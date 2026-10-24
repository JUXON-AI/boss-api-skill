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
const workerEnvKey = 'BOSS_RUNTIME_DIAGNOSTICS_VM_WORKER';

async function runVmWorker(root, scenario) {
  const vm = await import('node:vm');
  const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
  const lockPath = path.join(root, 'boss-desktop-inspector.lock');
  const fixtureApp = path.join(root, 'fixture-boss.exe');
  const counters = {callbackCalls: 0, openCalls: 0, closeFdCalls: 0, unlinkCalls: 0, networkCalls: 0, socketSends: 0};
  const observations = {callbackBodyCompleted: false, undefinedObserved: false, consoleErrors: 0};
  const openDescriptors = new Set();
  const fixtureProcess = {
    platform: 'win32',
    pid: 44001,
    execPath: process.execPath,
    env: {
      BOSS_APP_MAIN: fixtureApp,
      BOSS_INSPECTOR_URL: 'http://127.0.0.1:9229',
      BOSS_WS_CONNECT_TIMEOUT_MS: '60',
      BOSS_CDP_REQUEST_TIMEOUT_MS: '60',
    },
  };
  const checkedPath = value => {
    const absolute = path.resolve(value);
    if (absolute !== lockPath) throw new Error('VM fixture blocked an unexpected filesystem path');
    return absolute;
  };
  const fixtureFs = {
    openSync(value, ...args) {
      counters.openCalls++;
      const descriptor = fs.openSync(checkedPath(value), ...args);
      openDescriptors.add(descriptor);
      return descriptor;
    },
    writeSync(descriptor, ...args) {
      if (!openDescriptors.has(descriptor)) throw new Error('VM fixture blocked an unowned descriptor');
      return fs.writeSync(descriptor, ...args);
    },
    closeSync(descriptor) {
      if (!openDescriptors.has(descriptor)) throw new Error('VM fixture blocked an unowned descriptor');
      const result = fs.closeSync(descriptor);
      openDescriptors.delete(descriptor);
      counters.closeFdCalls++;
      return result;
    },
    unlinkSync(value) {
      counters.unlinkCalls++;
      return fs.unlinkSync(checkedPath(value));
    },
    realpathSync(value) { return path.resolve(value); },
  };
  let fetchCalls = 0;
  const target = {type: 'node', id: 'offline-fixture', webSocketDebuggerUrl: 'ws://127.0.0.1:9229/offline-fixture'};
  const fixture = {socket: null};
  const identityPayload = {id: 1, result: {result: {value: {
    pid: 55002, execPath: fixtureApp, electron: 'fixture', node: 'fixture', platform: 'win32', arch: 'x64',
  }}}};
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      fixture.socket = this;
      setTimeout(() => {
        if (scenario === 'connect-error') this.onerror?.({type: 'error'});
        else this.onopen?.({type: 'open'});
      }, 0);
    }
    send(data) {
      counters.socketSends++;
      const message = JSON.parse(data);
      this.sent.push(message);
      if (scenario === 'ws-close') setTimeout(() => this.onclose?.({code: 1006, reason: 'fixture close'}), 0);
      else if (scenario === 'ws-error') setTimeout(() => this.onerror?.({type: 'error', error: new Error('fixture socket failure')}), 0);
      else if (scenario === 'invalid-frame') setTimeout(() => this.onmessage?.({data: '{fixture-invalid-frame'}), 0);
      else if (scenario === 'cdp-timeout') { /* Intentionally leave the request pending. */ }
      else if (scenario === 'notification' && message.id === 1) {
        setTimeout(() => this.onmessage?.({data: JSON.stringify({method: 'Runtime.consoleAPICalled', params: {type: 'fixture'}})}), 0);
        setTimeout(() => this.onmessage?.({data: JSON.stringify(identityPayload)}), 0);
      } else if (scenario === 'native-remote' && message.id === 1) {
        const payload={id:1,error:{code:-32000,message:'fixture native remote failure',stack:'CDPError: fixture native remote failure\n    at runtime.mjs:111:20'}};
        setTimeout(() => this.onmessage?.({data: JSON.stringify(payload)}), 0);
      } else if (scenario === 'native-eval' && message.id === 1) {
        const payload={id:1,result:{exceptionDetails:{text:'Uncaught',exception:{className:'TypeError',description:'TypeError: fixture native evaluation failure\n    at runtime.mjs:111:20'}}}};
        setTimeout(() => this.onmessage?.({data: JSON.stringify(payload)}), 0);
      } else if (scenario === 'undefined' && message.id === 1) {
        setTimeout(() => this.onmessage?.({data: JSON.stringify(identityPayload)}), 0);
      } else if (scenario === 'undefined' && message.id === 2) {
        setTimeout(() => this.onmessage?.({data: JSON.stringify({id:2,result:{result:{type:'undefined'}}})}), 0);
      } else if (scenario === 'cleanup-unavailable' && message.id === 1) {
        this.onmessage?.({data: JSON.stringify(identityPayload)});
        this.onclose?.({code: 1006, reason: 'fixture lost'});
      } else if (scenario === 'ownership-failure' && message.id === 1) {
        const payload={id:1,result:{result:{value:{pid:99999,execPath:fixtureApp,electron:'fixture',node:'fixture',platform:'win32',arch:'x64'}}}};
        setTimeout(() => this.onmessage?.({data: JSON.stringify(payload)}), 0);
      } else if (scenario === 'cleanup-failure' && message.id === 1) {
        setTimeout(() => this.onmessage?.({data: JSON.stringify(identityPayload)}), 0);
      } else if (scenario === 'cleanup-failure' && message.id === 2) {
        setTimeout(() => this.onmessage?.({data: JSON.stringify({id: 2, error: {code: -32000, message: 'fixture cleanup failure'}})}), 0);
      }
    }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    process: fixtureProcess,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    WebSocket: FakeWebSocket,
    fetch: async () => {
      counters.networkCalls++;
      const directTarget = ['connect-error','notification','native-remote','native-eval','undefined'].includes(scenario);
      const body = directTarget || fetchCalls++ > 0 ? [target] : [];
      return {ok: true, json: async () => body};
    },
    console: {error() { observations.consoleErrors++; }, log() {}},
  });
  const synthetic = (identifier, names, values) => new vm.SyntheticModule(names, function() {
    for (const name of names) this.setExport(name, values[name]);
  }, {context, identifier});
  const fsModule = synthetic('offline:node:fs', ['default'], {default: fixtureFs});
  const osModule = synthetic('offline:node:os', ['default'], {default: {tmpdir: () => root}});
  const pathModule = synthetic('offline:node:path', ['default'], {default: path});
  const cryptoModule = synthetic('offline:node:crypto', ['default'], {default: (await import('node:crypto')).default});
  const childProcessModule = synthetic('offline:node:child_process', ['execFileSync'], {
    execFileSync() { throw new Error('offline fixture blocked child process execution'); },
  });
  const row = {ProcessId: 55002, ExecutablePath: fixtureApp, CommandLine: fixtureApp};
  const platformModule = synthetic('offline:platform.mjs', [
    'defaultAppMain', 'archivePath', 'windowsProcesses', 'selectWindowsMain', 'activateInspector',
    'verifyWindowsListener', 'privateDirectory',
  ], {
    defaultAppMain: () => fixtureApp,
    archivePath: () => '',
    windowsProcesses: () => [row],
    selectWindowsMain: rows => rows[0],
    activateInspector() {},
    verifyWindowsListener() {},
    privateDirectory() {},
  });
  const diagnosticsModule = synthetic('offline:diagnostics.mjs', ['attachDiagnosticContext', 'serializeDiagnosticError'], {
    attachDiagnosticContext, serializeDiagnosticError,
  });
  const imports = {
    'node:fs': fsModule,
    'node:os': osModule,
    'node:path': pathModule,
    'node:crypto': cryptoModule,
    'node:child_process': childProcessModule,
    './platform.mjs': platformModule,
    './diagnostics.mjs': diagnosticsModule,
  };
  const runtime = new vm.SourceTextModule(runtimeSource, {context, identifier: pathToFileURL(runtimePath).href});
  await runtime.link(specifier => {
    const dependency = imports[specifier];
    if (!dependency) throw new Error('VM fixture rejected runtime import: ' + specifier);
    return dependency;
  });
  await runtime.evaluate();
  let failure = null;
  try {
    await runtime.namespace.withBoss(async ctx => {
      counters.callbackCalls++;
      if (scenario === 'cleanup-failure') {
        const error = new Error('fixture primary callback failure');
        error.code = 'FIXTURE_PRIMARY';
        throw error;
      }
      if (scenario === 'undefined') {
        const value=await ctx.renderer('view','fixture-undefined',{stage:'sdk',action:'fixture-undefined'});
        observations.undefinedObserved=value===undefined;
      }
      if (scenario === 'notification' || scenario === 'undefined') observations.callbackBodyCompleted=true;
      if (scenario === 'cleanup-unavailable') observations.callbackBodyCompleted=true;
      return 'callback complete';
    });
  } catch (error) {
    failure = serializeDiagnosticError(error);
  }
  return {
    failure,
    ...counters,
    ...observations,
    socketSends: fixture.socket?.sent.length ?? 0,
    descriptorCount: openDescriptors.size,
    lockExists: fs.existsSync(lockPath),
    socketClosed: fixture.socket?.closed ?? false,
  };
}

if (process.env[workerEnvKey] === '1') {
  try {
    const report = await runVmWorker(process.env.BOSS_RUNTIME_DIAGNOSTICS_ROOT, process.env.BOSS_RUNTIME_DIAGNOSTICS_SCENARIO);
    process.stdout.write(JSON.stringify(report));
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  }
} else {
  function execute(scenario) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-runtime-diagnostics-offline-'));
    try {
      const child = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          [workerEnvKey]: '1',
          BOSS_RUNTIME_DIAGNOSTICS_ROOT: root,
          BOSS_RUNTIME_DIAGNOSTICS_SCENARIO: scenario,
        },
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, `offline VM worker failed: ${child.stderr}`);
      return JSON.parse(child.stdout);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  }

  test('WebSocket close after a request starts rejects the pending CDP call promptly', () => {
    const report = execute('ws-close');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'cdp');
    assert.equal(report.failure.code, 'WS_CLOSED');
    assert.equal(report.failure.requestId, 1);
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
    assert.equal(report.closeFdCalls, 1);
    assert.equal(report.unlinkCalls, 1);
  });

  test('WebSocket error after a request starts rejects the pending CDP call promptly', () => {
    const report = execute('ws-error');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'cdp');
    assert.equal(report.failure.code, 'WS_ERROR');
    assert.equal(report.failure.requestId, 1);
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
  });

  test('CDP timeout reports stable code, stage, request identity and elapsed time', () => {
    const report = execute('cdp-timeout');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'ownership');
    assert.equal(report.failure.action, 'read-process-identity');
    assert.equal(report.failure.code, 'CDP_REQUEST_TIMEOUT');
    assert.equal(report.failure.requestId, 1);
    assert.ok(report.failure.elapsed >= 50 && report.failure.elapsed < 1000, JSON.stringify(report.failure));
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
  });

  test('invalid WebSocket frames fail pending work without including the raw frame', () => {
    const report = execute('invalid-frame');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'cdp');
    assert.equal(report.failure.code, 'CDP_INVALID_FRAME');
    assert.equal(JSON.stringify(report.failure).includes('fixture-invalid-frame'), false);
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
  });

  test('connection failure has a stable transport code before any CDP request', () => {
    const report = execute('connect-error');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'ws');
    assert.equal(report.failure.code, 'WS_CONNECT_ERROR');
    assert.equal(report.socketSends, 0);
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
  });

  test('cleanup failure preserves the primary callback error and records cleanup context', () => {
    const report = execute('cleanup-failure');
    assert.equal(report.callbackCalls, 1);
    assert.equal(report.socketSends, 2);
    assert.equal(report.failure.code, 'FIXTURE_PRIMARY');
    assert.match(report.failure.message, /primary callback failure/);
    assert.ok(Array.isArray(report.failure.context.cleanup));
    assert.equal(report.failure.context.cleanup[0].stage, 'cleanup');
    assert.equal(report.failure.context.cleanup[0].code, 'CDP_REMOTE_ERROR');
    assert.equal(report.lockExists, false);
    assert.equal(report.descriptorCount, 0);
  });
  test('CDP notifications without an id are ignored while the pending request completes', () => {
    const report = execute('notification');
    assert.equal(report.failure, null);
    assert.equal(report.callbackCalls, 1);
    assert.equal(report.callbackBodyCompleted, true);
    assert.equal(report.socketSends, 1);
    assert.equal(report.lockExists, false);
  });

  test('remote CDP and evaluation errors retain sanitized native message and stack', () => {
    const remote=execute('native-remote');
    assert.equal(remote.failure.stage, 'ownership');
    assert.equal(remote.failure.code, 'CDP_REMOTE_ERROR');
    assert.equal(remote.failure.cause.code, -32000);
    assert.match(remote.failure.cause.message, /fixture native remote failure/);
    assert.match(remote.failure.cause.stack, /runtime\.mjs:111:20/);
    const evaluation=execute('native-eval');
    assert.equal(evaluation.failure.stage, 'ownership');
    assert.equal(evaluation.failure.code, 'CDP_EVALUATION_ERROR');
    assert.equal(evaluation.failure.cause.name, 'TypeError');
    assert.match(evaluation.failure.cause.message, /fixture native evaluation failure/);
    assert.match(evaluation.failure.cause.stack, /runtime\.mjs:111:20/);
  });

  test('a legitimate undefined evaluation result is not treated as a protocol error', () => {
    const report = execute('undefined');
    assert.equal(report.failure, null);
    assert.equal(report.callbackCalls, 1);
    assert.equal(report.callbackBodyCompleted, true);
    assert.equal(report.undefinedObserved, true);
    assert.equal(report.socketSends, 2);
  });

  test('cleanup reports unavailable when an owned Inspector socket was lost after verification', () => {
    const report = execute('cleanup-unavailable');
    assert.equal(report.callbackCalls, 1);
    assert.equal(report.callbackBodyCompleted, true);
    assert.equal(report.failure.stage, 'cleanup');
    assert.equal(report.failure.code, 'CLEANUP_UNAVAILABLE');
    assert.equal(report.socketSends, 1, 'cleanup must not reconnect or replay business work');
    assert.equal(report.lockExists, false);
  });
  test('unverified ownership reports cleanup secondary status without an extra stderr line', () => {
    const report = execute('ownership-failure');
    assert.equal(report.callbackCalls, 0);
    assert.equal(report.failure.stage, 'ownership');
    assert.equal(report.failure.code, 'BOSS_OWNERSHIP_MISMATCH');
    assert.equal(report.failure.context.cleanup[0].code, 'INSPECTOR_OWNERSHIP_UNVERIFIED');
    assert.equal(report.consoleErrors, 0);
    assert.equal(report.socketSends, 1, 'unverified ownership must not send an Inspector close command');
    assert.equal(report.lockExists, false);
  });
}