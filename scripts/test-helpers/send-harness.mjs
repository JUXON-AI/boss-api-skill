import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {sameOutputPath} from '../platform.mjs';
import {attachDiagnosticContext, serializeDiagnosticError} from '../diagnostics.mjs';

const [bossPathArg, rootArg, scenarioPathArg, approvalPathArg, attemptPathArg, outputPathArg] = process.argv.slice(2);
const bossPath = path.resolve(bossPathArg);
const runtimePath = path.join(path.dirname(bossPath), 'runtime.mjs');
const root = path.resolve(rootArg);
const scenario = JSON.parse(fs.readFileSync(scenarioPathArg, 'utf8'));

function insideRoot(value) {
  const absolute = path.resolve(value);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Offline harness blocked filesystem access outside fixture root');
  }
  return absolute;
}

const openDescriptors = new Set();
const guardedFs = {
  existsSync(value) { return fs.existsSync(insideRoot(value)); },
  readFileSync(value, ...args) { return fs.readFileSync(insideRoot(value), ...args); },
  openSync(value, ...args) {
    const descriptor = fs.openSync(insideRoot(value), ...args);
    openDescriptors.add(descriptor);
    return descriptor;
  },
  writeSync(descriptor, ...args) {
    if (!openDescriptors.has(descriptor)) throw new Error('Offline harness blocked an unowned file descriptor');
    if (scenario.failLockWrite) throw new Error('Offline injected lock write failure');
    return fs.writeSync(descriptor, ...args);
  },
  closeSync(descriptor) {
    if (!openDescriptors.has(descriptor)) throw new Error('Offline harness blocked an unowned file descriptor');
    openDescriptors.delete(descriptor);
    return fs.closeSync(descriptor);
  },
  unlinkSync(value) { return fs.unlinkSync(insideRoot(value)); },
  mkdirSync(value, ...args) { return fs.mkdirSync(insideRoot(value), ...args); },
  writeFileSync(value, ...args) { return fs.writeFileSync(insideRoot(value), ...args); },
};

const report = {
  bossExitCode: 0,
  logs: [],
  errors: [],
  bridgeCalls: [],
  rendererCalls: [],
  withBossCalls: 0,
  fakeSendInvocations: 0,
  historyReads: 0,
};
const lockPath = path.join(root, 'fixture-send.lock');
const fakeProcess = {
  argv: [process.execPath, bossPath, 'send', '--approval', approvalPathArg, '--attempt', attemptPathArg, '--output', outputPathArg,
    '--job-id', scenario.jobId ?? 'fixture-job'],
  exitCode: 0,
  pid: 90001,
  platform: process.platform,
  env: {
    BOSS_APP_MAIN: path.join(root, 'fixture-BOSS-app'),
    BOSS_INSPECTOR_URL: 'http://127.0.0.1:9229',
    BOSS_SEND_LOCK: path.join(root, 'unused-native-lock'),
  },
};
const fakeConsole = {
  log(...values) { report.logs.push(values.map(String).join(' ')); },
  error(...values) { report.errors.push(values.map(String).join(' ')); },
};
const context = vm.createContext({console: fakeConsole, process: fakeProcess, URL});

const fsModule = new vm.SyntheticModule(['default'], function() {
  this.setExport('default', guardedFs);
}, {context, identifier: 'offline:node:fs'});
const pathModule = new vm.SyntheticModule(['default'], function() {
  this.setExport('default', path);
}, {context, identifier: 'offline:node:path'});
const osModule = new vm.SyntheticModule(['default'], function() {
  this.setExport('default', {tmpdir: () => root});
}, {context, identifier: 'offline:node:os'});
const cryptoModule = new vm.SyntheticModule(['default'], function() {
  this.setExport('default', crypto);
}, {context, identifier: 'offline:node:crypto'});
const childProcessModule = new vm.SyntheticModule(['execFileSync'], function() {
  this.setExport('execFileSync', () => { throw new Error('Offline harness blocked child process execution'); });
}, {context, identifier: 'offline:node:child_process'});
const platformExports = {
  sameOutputPath: (left,right) => sameOutputPath(insideRoot(left),insideRoot(right)),
  defaultAppMain: () => path.join(root, 'fixture-BOSS-app'),
  archivePath: () => path.join(root, 'fixture.asar'),
  windowsProcesses: () => { throw new Error('Offline harness blocked process enumeration'); },
  selectWindowsMain: () => { throw new Error('Offline harness blocked process selection'); },
  activateInspector: () => { throw new Error('Offline harness blocked Inspector activation'); },
  verifyWindowsListener: () => { throw new Error('Offline harness blocked listener inspection'); },
  privateDirectory: value => {
    const directory = insideRoot(value);
    if (scenario.rejectOutputDirectory && directory === path.join(root,'denied-output')) throw new Error('Offline injected output ACL rejection');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    return directory;
  },
};
const platformModule = new vm.SyntheticModule(Object.keys(platformExports), function() {
  for (const [name, value] of Object.entries(platformExports)) this.setExport(name, value);
}, {context, identifier: 'offline:platform.mjs'});
const diagnosticsModule = new vm.SyntheticModule(['attachDiagnosticContext', 'serializeDiagnosticError'], function() {
  this.setExport('attachDiagnosticContext', attachDiagnosticContext);
  this.setExport('serializeDiagnosticError', serializeDiagnosticError);
}, {context, identifier: 'offline:diagnostics.mjs'});

function fixtureHistory(index) {
  const histories = scenario.historyResponses ?? [];
  const entry = histories[index] ?? histories.at(-1) ?? scenario.defaultHistory;
  if (!entry) throw new Error('Offline fixture omitted a history response');
  return JSON.parse(JSON.stringify(entry));
}

async function withFixtureBoss(callback) {
  report.withBossCalls++;
  const ctx = {
    identity: {account: 'offline-fixture'},
    main: async () => { throw new Error('Offline harness blocked main-process evaluation'); },
    bridge: async (actType, act, data) => {
      report.bridgeCalls.push({actType, act, data: data ?? null});
      if (act === '_sdk_getLoginStatus') return {code: 0, data: scenario.loggedIn !== false};
      if (act === 'zprelationGetFriendList') return {code: 0, zpData: {friendList: scenario.contacts ?? []}};
      if (act === 'zpChatHistoryMsg') return fixtureHistory(report.historyReads++);
      throw new Error('Offline harness rejected unexpected bridge action: ' + act);
    },
    renderer: async (kind, expression) => {
      report.rendererCalls.push({kind, expression});
      if (expression === 'window.iBossRoot.chat.sendMessage.toString()') {
        return scenario.sdkSource ?? 'function offlineFixtureSendMessage() {}';
      }
      if (!expression.includes('window.iBossRoot.chat.sendMessage(')) {
        throw new Error('Offline harness rejected unexpected renderer expression');
      }
      report.fakeSendInvocations++;
      return {invoked: true};
    },
  };
  return await callback(ctx);
}

const runtimeImportModules = {
  'node:fs': fsModule,
  'node:os': osModule,
  'node:path': pathModule,
  'node:crypto': cryptoModule,
  'node:child_process': childProcessModule,
  './platform.mjs': platformModule,
  './diagnostics.mjs': diagnosticsModule,
};
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
const runtimeSourceModule = new vm.SourceTextModule(runtimeSource, {
  context,
  identifier: pathToFileURL(runtimePath).href,
});
await runtimeSourceModule.link(specifier => {
  const dependency = runtimeImportModules[specifier];
  if (!dependency) throw new Error('Offline harness rejected runtime import: ' + specifier);
  return dependency;
});
await runtimeSourceModule.evaluate();

const runtimeExports = {
  ...runtimeSourceModule.namespace,
  appMain: path.join(root, 'fixture-BOSS-app'),
  sendLock: lockPath,
  sleep: async () => {},
  withBoss: withFixtureBoss,
};
const runtimeSyntheticModule = new vm.SyntheticModule(Object.keys(runtimeExports), function() {
  for (const [name, value] of Object.entries(runtimeExports)) this.setExport(name, value);
}, {context, identifier: 'offline:runtime.mjs'});

const paginationModule = new vm.SourceTextModule(fs.readFileSync(path.join(path.dirname(bossPath), 'history-pagination.mjs'), 'utf8'), {context, identifier:'offline:real-history-pagination'});
await paginationModule.link(() => { throw new Error('Unexpected pagination dependency'); });
await paginationModule.evaluate();
async function linkBoss(specifier) {
  if (specifier === './history-pagination.mjs') return paginationModule;
  if (specifier === 'node:fs') return fsModule;
  if (specifier === 'node:path') return pathModule;
  if (specifier === './runtime.mjs') return runtimeSyntheticModule;
  if (specifier === './platform.mjs') return platformModule;
  if (specifier === './diagnostics.mjs') return diagnosticsModule;
  throw new Error('Offline harness rejected boss.mjs import: ' + specifier);
}

try {
  let source = fs.readFileSync(bossPath, 'utf8');
  const completionMarker = 'main().catch(';
  const markerIndex = source.lastIndexOf(completionMarker);
  if (markerIndex < 0) throw new Error('Could not instrument boss.mjs completion promise');
  source = source.slice(0, markerIndex) + 'globalThis.__bossDone = ' + source.slice(markerIndex);
  const bossModule = new vm.SourceTextModule(source, {context, identifier: pathToFileURL(bossPath).href});
  await bossModule.link(linkBoss);
  await bossModule.evaluate();
  await context.__bossDone;
  report.bossExitCode = fakeProcess.exitCode ?? 0;
  report.lockExistsAfter = fs.existsSync(lockPath);
  report.openDescriptorCount = openDescriptors.size;
  process.stdout.write(JSON.stringify(report));
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
}
