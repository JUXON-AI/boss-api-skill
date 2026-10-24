import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {attachDiagnosticContext, serializeDiagnosticError} from './diagnostics.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(scriptsDir, 'runtime.mjs');
const workerEnvKey = 'BOSS_INSPECTOR_LOCK_VM_WORKER';

async function runVmWorker(root) {
  const vm = await import('node:vm');
  const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
  const lockPath = path.join(root, 'boss-desktop-inspector.lock');
  const fixtureApp = path.join(root, 'fixture-boss.exe');
  const failWrite = process.env.BOSS_INSPECTOR_LOCK_FAIL_WRITE === '1';
  const counters = {
    openCalls: 0,
    writeCalls: 0,
    closeCalls: 0,
    unlinkCalls: 0,
    processEnumerations: 0,
    activationCalls: 0,
    listenerChecks: 0,
    networkCalls: 0,
    callbackCalls: 0,
    openedFd: null,
  };
  const openDescriptors = new Set();
  const closedDescriptors = new Set();
  const fixtureProcess = {
    platform: 'win32',
    pid: 44001,
    execPath: process.execPath,
    env: {
      BOSS_APP_MAIN: fixtureApp,
      BOSS_INSPECTOR_URL: 'http://127.0.0.1:9229',
    },
  };

  function checkedLockPath(value) {
    const absolute = path.resolve(value);
    if (absolute !== lockPath) throw new Error('VM fixture blocked filesystem access outside its lock path');
    return absolute;
  }

  const fixtureFs = {
    openSync(value, ...args) {
      counters.openCalls++;
      const fd = fs.openSync(checkedLockPath(value), ...args);
      counters.openedFd = fd;
      openDescriptors.add(fd);
      return fd;
    },
    writeSync(fd, ...args) {
      counters.writeCalls++;
      if (!openDescriptors.has(fd)) throw new Error('VM fixture blocked write to an unowned descriptor');
      if (failWrite) throw new Error('offline fixture injected Inspector lock write failure');
      return fs.writeSync(fd, ...args);
    },
    closeSync(fd) {
      if (!openDescriptors.has(fd)) throw new Error('VM fixture blocked close of an unowned descriptor');
      const result = fs.closeSync(fd);
      counters.closeCalls++;
      openDescriptors.delete(fd);
      closedDescriptors.add(fd);
      return result;
    },
    unlinkSync(value) {
      counters.unlinkCalls++;
      return fs.unlinkSync(checkedLockPath(value));
    },
  };

  const context = vm.createContext({
    process: fixtureProcess,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      counters.networkCalls++;
      return {ok: true, json: async () => []};
    },
    console: {error() {}},
  });

  const synthetic = (identifier, exports, values) => new vm.SyntheticModule(exports, function() {
    for (const name of exports) this.setExport(name, values[name]);
  }, {context, identifier});

  const fsModule = synthetic('offline:node:fs', ['default'], {default: fixtureFs});
  const osModule = synthetic('offline:node:os', ['default'], {default: {tmpdir: () => root}});
  const pathModule = synthetic('offline:node:path', ['default'], {default: path});
  const cryptoModule = synthetic('offline:node:crypto', ['default'], {default: await import('node:crypto').then(m => m.default)});
  const childProcessModule = synthetic('offline:node:child_process', ['execFileSync'], {
    execFileSync() { throw new Error('offline fixture blocked child process execution'); },
  });
  const processRow = {ProcessId: 55002, ExecutablePath: fixtureApp, CommandLine: fixtureApp};
  const platformValues = {
    defaultAppMain: () => fixtureApp,
    windowsProcesses: () => { counters.processEnumerations++; return [processRow]; },
    selectWindowsMain: rows => rows[0],
    activateInspector: () => {
      counters.activationCalls++;
      throw new Error('offline fixture blocked Inspector activation');
    },
    verifyWindowsListener: () => { counters.listenerChecks++; throw new Error('unexpected listener check'); },
    privateDirectory: () => { throw new Error('unexpected output directory access'); },
  };
  const platformModule = synthetic('offline:platform.mjs', Object.keys(platformValues), platformValues);
  const diagnosticsModule = synthetic('offline:diagnostics.mjs', ['attachDiagnosticContext', 'serializeDiagnosticError'], {attachDiagnosticContext, serializeDiagnosticError});
  const imports = {
    'node:fs': fsModule,
    'node:os': osModule,
    'node:path': pathModule,
    'node:crypto': cryptoModule,
    'node:child_process': childProcessModule,
    './platform.mjs': platformModule,
    './diagnostics.mjs': diagnosticsModule,
  };
  const runtime = new vm.SourceTextModule(runtimeSource, {
    context,
    identifier: pathToFileURL(runtimePath).href,
  });
  await runtime.link(specifier => {
    const dependency = imports[specifier];
    if (!dependency) throw new Error('VM fixture rejected runtime import: ' + specifier);
    return dependency;
  });
  await runtime.evaluate();

  let failure;
  try {
    await runtime.namespace.withBoss(async () => {
      counters.callbackCalls++;
      return 'callback must not run in this fixture';
    });
  } catch (error) {
    failure = {message: error.message, code: error.code ?? null};
  }

  const fd = counters.openedFd;
  let descriptorClosed = fd !== null && closedDescriptors.has(fd) && !openDescriptors.has(fd);
  if (fd !== null) {
    try { fs.fstatSync(fd); descriptorClosed = false; }
    catch { /* A closed descriptor must no longer be stat-able. */ }
  }
  return {
    failure,
    ...counters,
    outstandingDescriptors: openDescriptors.size,
    descriptorClosed,
    lockExists: fs.existsSync(lockPath),
    lockContents: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
  };
}

if (process.env[workerEnvKey] === '1') {
  const root = process.env.BOSS_INSPECTOR_LOCK_FIXTURE_ROOT;
  try {
    const report = await runVmWorker(root);
    process.stdout.write(JSON.stringify(report));
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  }
} else {
  function createRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'boss-inspector-lock-offline-'));
  }

  function runWorker(root, failWrite) {
    const child = spawnSync(process.execPath, [
      '--experimental-vm-modules', fileURLToPath(import.meta.url),
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        [workerEnvKey]: '1',
        BOSS_INSPECTOR_LOCK_FIXTURE_ROOT: root,
        BOSS_INSPECTOR_LOCK_FAIL_WRITE: failWrite ? '1' : '0',
      },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `offline VM worker failed: ${child.stderr}`);
    return JSON.parse(child.stdout);
  }

  test('runtime.withBoss closes and removes its lock after an injected lock write failure', () => {
    const root = createRoot();
    try {
      const report = runWorker(root, true);
      assert.match(report.failure?.message ?? '', /injected Inspector lock write failure/);
      assert.equal(report.openCalls, 1);
      assert.equal(report.writeCalls, 1);
      assert.equal(report.closeCalls, 1);
      assert.equal(report.unlinkCalls, 1);
      assert.equal(report.descriptorClosed, true);
      assert.equal(report.outstandingDescriptors, 0);
      assert.equal(report.lockExists, false);
      assert.equal(report.activationCalls, 0);
      assert.equal(report.networkCalls, 0);
      assert.equal(report.callbackCalls, 0);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  test('runtime.withBoss preserves an existing lock and does not enter the callback', () => {
    const root = createRoot();
    const lockPath = path.join(root, 'boss-desktop-inspector.lock');
    const ownerContent = JSON.stringify({owner: 'offline-lock-fixture'});
    fs.writeFileSync(lockPath, ownerContent, {mode: 0o600, flag: 'wx'});
    try {
      const report = runWorker(root, false);
      assert.equal(report.failure?.code, 'EEXIST');
      assert.equal(report.openCalls, 1);
      assert.equal(report.writeCalls, 0);
      assert.equal(report.closeCalls, 0);
      assert.equal(report.unlinkCalls, 0);
      assert.equal(report.outstandingDescriptors, 0);
      assert.equal(report.lockExists, true);
      assert.equal(report.lockContents, ownerContent);
      assert.equal(report.activationCalls, 0);
      assert.equal(report.networkCalls, 0);
      assert.equal(report.callbackCalls, 0);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
}
