import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {historyFingerprint} from './runtime.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const bossPath = path.join(scriptsDir, 'boss.mjs');
const harnessPath = path.join(scriptsDir, 'test-helpers', 'send-harness.mjs');
const recipient = {uid: 42001, name: '离线夹具候选人'};
const approvedText = '离线集成测试正文：不会发送到任何服务。';
const baseMessages = [{
  mid: 81001,
  from: {uid: recipient.uid},
  to: {uid: 77001},
  body: {text: '离线夹具中的既有入站消息'},
}];
const selectedContact = {
  ...recipient,
  jobId: 'fixture-job',
  securityId: 'fixture-security-id',
  friendSource: 17,
  encryptUid: 'fixture-encrypted-uid',
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function historyResponse(messages = baseMessages, hasMore = false) {
  return {code: 0, zpData: {messages, hasMore}};
}

function createApproval(messages = baseMessages) {
  return {
    recipient,
    text: approvedText,
    textSha256: sha256(approvedText),
    expectedHistorySha256: historyFingerprint(messages),
    approved: true,
    approval: {
      userMessage: '离线集成测试自建授权夹具',
      approvedTextSha256: sha256(approvedText),
      recipientCount: 1,
    },
  };
}

function createScenario(overrides = {}) {
  return {
    jobId: 'fixture-job',
    contacts: [
      {...selectedContact, uid: 42002, name: recipient.name, jobId: 'decoy-job'},
      {...selectedContact, jobId: 'other-job', securityId: 'wrong-job-security-id'},
      selectedContact,
    ],
    historyResponses: [historyResponse(baseMessages)],
    ...overrides,
  };
}

function createCase({scenario = createScenario(), approval = createApproval()} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-send-offline-'));
  const files = {
    root,
    approval: path.join(root, 'approval.json'),
    scenario: path.join(root, 'scenario.json'),
    attempt: path.join(root, 'attempt.json'),
    output: path.join(root, 'result.json'),
    lock: path.join(root, 'fixture-send.lock'),
  };
  fs.writeFileSync(files.approval, JSON.stringify(approval), {mode: 0o600});
  fs.writeFileSync(files.scenario, JSON.stringify(scenario), {mode: 0o600});
  return files;
}

function executeSend(files, {output = files.output} = {}) {
  const child = spawnSync(process.execPath, [
    '--experimental-vm-modules', harnessPath, bossPath, files.root,
    files.scenario, files.approval, files.attempt, output,
  ], {
    cwd: files.root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      BOSS_APP_MAIN: path.join(files.root, 'offline-fixture-app'),
      BOSS_INSPECTOR_URL: 'http://127.0.0.1:9229',
      BOSS_SEND_LOCK: path.join(files.root, 'unused-native-lock'),
      NODE_OPTIONS: '',
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `offline harness failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

function failureOf(report) {
  assert.equal(report.bossExitCode, 1, JSON.stringify(report.logs));
  assert.equal(report.errors.length, 1, JSON.stringify(report));
  return JSON.parse(report.errors[0]);
}

function clean(files) {
  fs.rmSync(files.root, {recursive: true, force: true});
}
test('version 2 approval cannot be sent under another job before opening any client context', () => {
  const files = createCase({approval: {...createApproval(), contractVersion: 2, jobId: 'another-job'}});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /job.*match/i);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(report.withBossCalls, 0);
  } finally {clean(files);}
});

test('rotating history envelope securityId permits exactly one confirmed SDK invocation', () => {
  const reviewed=baseMessages.map(m=>({...m,securityId:'review-token'}));
  const first=reviewed.map(m=>({...m,securityId:'first-read-token'}));
  const second=reviewed.map(m=>({...m,securityId:'final-read-token'}));
  const confirmed=[...second,{mid:81002,from:{uid:77001},to:{uid:recipient.uid},body:{text:approvedText}}];
  const files=createCase({approval:createApproval(reviewed),scenario:createScenario({historyResponses:[
    historyResponse(first),historyResponse(second),historyResponse(confirmed),
  ]})});
  try {
    const report=executeSend(files);
    assert.equal(report.bossExitCode,0,JSON.stringify(report.errors));
    assert.equal(report.fakeSendInvocations,1);
    assert.equal(JSON.parse(fs.readFileSync(files.output,'utf8')).historyConfirmed,true);
  } finally {clean(files);}
});

test('send selects the exact UID/name/job fixture and confines the SDK call to the fake renderer', () => {
  const confirmed = [
    ...baseMessages,
    {mid: 81002, from: {uid: 77001}, to: {uid: recipient.uid}, body: {text: approvedText}},
  ];
  const files = createCase({scenario: createScenario({historyResponses: [
    historyResponse(baseMessages), historyResponse(baseMessages), historyResponse(confirmed),
  ]})});
  try {
    const report = executeSend(files);
    assert.equal(report.bossExitCode, 0);
    assert.equal(report.fakeSendInvocations, 1);
    assert.equal(report.historyReads, 3);
    assert.equal(report.lockExistsAfter, false);

    const historyCalls = report.bridgeCalls.filter(call => call.act === 'zpChatHistoryMsg');
    assert.equal(historyCalls.length, 3);
    assert.deepEqual(historyCalls[0].data, {
      uid: recipient.uid, securityId: selectedContact.securityId, maxMsgId: 0,
    });
    const sdkCall = report.rendererCalls.find(call => call.expression.includes('window.iBossRoot.chat.sendMessage('));
    assert.ok(sdkCall, 'only the offline fake renderer should receive a send expression');
    assert.ok(sdkCall.expression.includes(JSON.stringify(approvedText)));
    assert.ok(sdkCall.expression.includes(JSON.stringify({
      uid: recipient.uid,
      friendSource: selectedContact.friendSource,
      encryptUid: selectedContact.encryptUid,
    })));

    const result = JSON.parse(fs.readFileSync(files.output, 'utf8'));
    const attempt = JSON.parse(fs.readFileSync(files.attempt, 'utf8'));
    assert.equal(result.historyConfirmed, true);
    assert.equal(result.messageMid, 81002);
    assert.equal(attempt.status, 'reserved_before_invocation');
    assert.equal(attempt.attempts, 1);
  } finally {
    clean(files);
  }
});

test('recipient UID, name, and requested job must all match before history or renderer access', async t => {
  const cases = [
    ['wrong UID', [{...selectedContact, uid: 42009}]],
    ['wrong name', [{...selectedContact, name: '另一个离线夹具'}]],
    ['wrong job', [{...selectedContact, jobId: 'different-fixture-job'}]],
  ];
  for (const [name, contacts] of cases) {
    await t.test(name, () => {
      const files = createCase({scenario: createScenario({contacts})});
      try {
        const report = executeSend(files);
        assert.match(failureOf(report).error, /Expected exactly one UID\/name\/job match/);
        assert.equal(report.withBossCalls, 1);
        assert.equal(report.historyReads, 0);
        assert.equal(report.rendererCalls.length, 0);
        assert.equal(fs.existsSync(files.attempt), false);
        assert.equal(fs.existsSync(files.output), false);
        assert.equal(report.lockExistsAfter, false);
      } finally {
        clean(files);
      }
    });
  }
});

test('single-recipient authorization and both body hashes are checked before opening the BOSS context', async t => {
  const invalidCases = [
    ['approval flag is false', approval => { approval.approved = false; }],
    ['recipient count is not one', approval => { approval.approval.recipientCount = 2; }],
    ['body changed after approval', approval => { approval.text += '被改写'; }],
    ['approved body digest is wrong', approval => { approval.approval.approvedTextSha256 = '0'.repeat(64); }],
  ];
  for (const [name, mutate] of invalidCases) {
    await t.test(name, () => {
      const approval = createApproval();
      mutate(approval);
      const files = createCase({approval});
      try {
        const report = executeSend(files);
        const failure = failureOf(report);
        assert.match(failure.error, name.includes('body') || name.includes('digest') ? /hash mismatch/ : /authorization/);
        assert.equal(report.withBossCalls, 0);
        assert.equal(report.fakeSendInvocations, 0);
        assert.equal(fs.existsSync(files.lock), false);
        assert.equal(fs.existsSync(files.attempt), false);
      } finally {
        clean(files);
      }
    });
  }
});

test('changed conversation fingerprint blocks the send before reserving an attempt', () => {
  const changed = [...baseMessages, {
    mid: 81003, from: {uid: recipient.uid}, to: {uid: 77001}, body: {text: '新到的离线夹具消息'},
  }];
  const files = createCase({scenario: createScenario({historyResponses: [historyResponse(changed)]})});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /Conversation changed since review/);
    assert.equal(report.historyReads, 1);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.existsSync(files.attempt), false);
    assert.equal(report.lockExistsAfter, false);
  } finally {
    clean(files);
  }
});

test('conversation changing between the two pre-send reads blocks the SDK call', () => {
  const changed = [...baseMessages, {
    mid: 81004, from: {uid: recipient.uid}, to: {uid: 77001}, body: {text: '发送前变化的离线夹具消息'},
  }];
  const files = createCase({scenario: createScenario({historyResponses: [
    historyResponse(baseMessages), historyResponse(changed),
  ]})});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /Conversation changed immediately before send/);
    assert.equal(report.historyReads, 2);
    assert.equal(report.rendererCalls.length, 1, 'only the SDK identity string may be inspected');
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.existsSync(files.attempt), false);
    assert.equal(report.lockExistsAfter, false);
  } finally {
    clean(files);
  }
});

test('incomplete history blocks sending before SDK inspection and attempt creation', () => {
  const files = createCase({scenario: createScenario({historyResponses: [historyResponse(baseMessages, true)]})});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /History pagination made no progress/);
    assert.equal(report.historyReads, 2);
    assert.equal(report.rendererCalls.length, 0);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.existsSync(files.attempt), false);
  } finally {
    clean(files);
  }
});

test('history becoming incomplete on the final read blocks sending even if message bytes did not change', () => {
  const files = createCase({scenario: createScenario({historyResponses: [
    historyResponse(baseMessages), historyResponse(baseMessages, true),
  ]})});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /History pagination made no progress/);
    assert.equal(report.historyReads, 3);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.existsSync(files.attempt), false);
    assert.equal(report.lockExistsAfter, false);
  } finally {
    clean(files);
  }
});

test('send lock conflict stops before entering the fixture BOSS context and preserves the owner lock', () => {
  const files = createCase();
  const owner = JSON.stringify({owner: 'offline-lock-fixture'});
  fs.writeFileSync(files.lock, owner, {mode: 0o600});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /EEXIST|already exists|file exists/i);
    assert.equal(report.withBossCalls, 0);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.readFileSync(files.lock, 'utf8'), owner);
    assert.equal(fs.existsSync(files.attempt), false);
  } finally {
    clean(files);
  }
});

test('an existing attempt file prevents a second orchestration run', () => {
  const files = createCase();
  const attempt = JSON.stringify({fixture: 'previous-offline-attempt'});
  fs.writeFileSync(files.attempt, attempt, {mode: 0o600});
  try {
    const report = executeSend(files);
    assert.match(failureOf(report).error, /Attempt already exists; check history, do not retry/);
    assert.equal(report.withBossCalls, 0);
    assert.equal(report.fakeSendInvocations, 0);
    assert.equal(fs.readFileSync(files.attempt, 'utf8'), attempt);
    assert.equal(fs.existsSync(files.lock), false);
  } finally {
    clean(files);
  }
});

test('Windows case aliases cannot make attempt and output the same file', {skip:process.platform!=='win32'}, () => {
  const files=createCase();
  try {
    const report=executeSend(files,{output:path.join(files.root,'Attempt.json')});
    assert.match(failureOf(report).error,/Attempt and output paths must differ/);
    assert.equal(report.withBossCalls,0);
    assert.equal(report.fakeSendInvocations,0);
    assert.equal(fs.existsSync(files.attempt),false);
  } finally {clean(files);}
});

test('output directory ACL rejection happens before entering the client context or acquiring send lock',()=>{
  const files=createCase({scenario:createScenario({rejectOutputDirectory:true})});
  try {
    const report=executeSend(files,{output:path.join(files.root,'denied-output','result.json')});
    assert.match(failureOf(report).error,/output ACL rejection/);
    assert.equal(report.withBossCalls,0);
    assert.equal(report.fakeSendInvocations,0);
    assert.equal(fs.existsSync(files.lock),false);
    assert.equal(fs.existsSync(files.attempt),false);
  } finally {clean(files);}
});

test('send lock write failure releases the owned lock before any client context or SDK call',()=>{
  const files=createCase({scenario:createScenario({failLockWrite:true})});
  try {
    const report=executeSend(files);
    assert.match(failureOf(report).error,/lock write failure/);
    assert.equal(report.withBossCalls,0);
    assert.equal(report.fakeSendInvocations,0);
    assert.equal(report.lockExistsAfter,false);
    assert.equal(report.openDescriptorCount,0);
    assert.equal(fs.existsSync(files.lock),false);
  } finally {clean(files);}
});

test('unknown outcome is recorded and an automatic retry is blocked by the attempt file', () => {
  const files = createCase({scenario: createScenario({historyResponses: [historyResponse(baseMessages)]})});
  try {
    const first = executeSend(files);
    assert.match(failureOf(first).error, /Send outcome unknown/);
    assert.equal(first.fakeSendInvocations, 1, 'one simulated SDK call is intercepted offline');
    assert.equal(first.historyReads, 10, 'two pre-send reads plus at most eight confirmation reads');
    assert.equal(first.lockExistsAfter, false);

    const unknown = JSON.parse(fs.readFileSync(files.output, 'utf8'));
    const attempt = fs.readFileSync(files.attempt, 'utf8');
    assert.equal(unknown.outcomeUnknown, true);
    assert.equal(unknown.doNotRetryAutomatically, true);
    assert.equal(unknown.sdkReturned, true);

    const retryOutput = path.join(files.root, 'retry-result.json');
    const retry = executeSend(files, {output: retryOutput});
    assert.match(failureOf(retry).error, /Attempt already exists; check history, do not retry/);
    assert.equal(retry.withBossCalls, 0);
    assert.equal(retry.fakeSendInvocations, 0);
    assert.equal(fs.readFileSync(files.attempt, 'utf8'), attempt);
    assert.equal(fs.existsSync(retryOutput), false);
  } finally {
    clean(files);
  }
});
