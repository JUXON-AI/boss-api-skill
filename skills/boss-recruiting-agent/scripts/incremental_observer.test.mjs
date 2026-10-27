import test from 'node:test';
import assert from 'node:assert/strict';
import {planIncremental, commitObservations, diffInbound} from './incremental_observer.mjs';

const now = 1_000_000;
const interval = 4 * 60 * 60 * 1000;
const candidate = {uid: 101, name: '离线候选人', jobId: 'fixture-job'};
const checkpointKey = 'fixture-job::101';

function contact(overrides = {}) {
  return {
    uid: candidate.uid,
    name: candidate.name,
    jobId: candidate.jobId,
    lastTS: 100,
    relationType: 1,
    securityId: 'fixture-security-a',
    ...overrides,
  };
}

function readFor(value) {
  return value.reads[0];
}

function successfulObservation(planRead, mids, overrides = {}) {
  return {
    candidate: planRead.candidate,
    metadataFingerprint: planRead.metadataFingerprint,
    mids,
    complete: true,
    ...overrides,
  };
}

function commitRead(planRead, mids = [10], at = now) {
  return commitObservations({successes: [successfulObservation(planRead, mids)], now: at});
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('first observation reads full history while current-job greetings stay separate', () => {
  const inputs = {
    contacts: [
      contact(),
      contact({uid: 202, name: '新招呼', relationType: 5, lastTS: 200}),
      contact({uid: 203, name: '别的岗位', jobId: 'other-job', relationType: 5}),
    ],
    scope: [candidate],
    checkpoint: {},
    now,
    fullScanIntervalMs: interval,
    jobId: candidate.jobId,
  };
  const before = JSON.stringify(inputs);
  const plan = planIncremental(inputs);
  assert.equal(JSON.stringify(inputs), before);
  assert.deepEqual(Object.keys(plan).sort(), ['issues', 'newCandidates', 'reads']);
  assert.equal(plan.reads.length, 1);
  assert.equal(plan.reads[0].reason, 'no_checkpoint');
  assert.deepEqual(plan.reads[0].candidate, candidate);
  assert.match(plan.reads[0].metadataFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.newCandidates, [{uid: 202, name: '新招呼', jobId: candidate.jobId}]);
  assert.deepEqual(plan.issues, []);
});

test('wrong job or a different UID with the same name is never selected as the scope target', () => {
  const plan = planIncremental({
    contacts: [
      contact({jobId: 'other-job'}),
      contact({uid: 102, name: candidate.name}),
    ],
    scope: [candidate],
    now,
    jobId: candidate.jobId,
  });
  assert.deepEqual(plan.reads, []);
  assert.equal(plan.issues.some(item => item.code === 'identity_mismatch'), true);
  assert.equal(JSON.stringify(plan.reads).includes('"uid":102'), false);
});

test('conflicting duplicate current-job identities fail closed', () => {
  const plan = planIncremental({
    contacts: [contact({lastTS: 100}), contact({lastTS: 101})],
    scope: [candidate],
    now,
    jobId: candidate.jobId,
  });
  assert.deepEqual(plan.reads, []);
  assert.deepEqual(plan.newCandidates, []);
  assert.equal(plan.issues.some(item => item.code === 'duplicate_contact_conflict'), true);
});

test('conflicting duplicate scope entries fail closed', () => {
  const plan = planIncremental({
    contacts: [contact()],
    scope: [candidate, {...candidate, jobId: 'other-job'}],
    now,
    jobId: candidate.jobId,
  });
  assert.deepEqual(plan.reads, []);
  assert.equal(plan.issues.some(item => item.code === 'duplicate_scope_conflict'), true);
});

test('same job and UID with different names fails closed without blocking equal names for distinct UIDs', () => {
  const conflicting = planIncremental({
    contacts: [contact()],
    scope: [candidate, {...candidate, name: '冲突姓名'}],
    now,
    jobId: candidate.jobId,
  });
  assert.deepEqual(conflicting.reads, []);
  assert.equal(conflicting.issues.some(item => item.code === 'duplicate_scope_conflict'), true);

  const sameName = planIncremental({
    contacts: [contact(), contact({uid: 102})],
    scope: [candidate, {...candidate, uid: 102}],
    now,
    jobId: candidate.jobId,
  });
  assert.deepEqual(sameName.reads.map(item => item.candidate.uid).sort((a, b) => a - b), [101, 102]);
  assert.equal(sameName.issues.some(item => item.code === 'duplicate_scope_conflict'), false);
});

test('unchanged metadata skips rereading until the periodic fallback is due', () => {
  const first = planIncremental({contacts: [contact()], scope: [candidate], now, fullScanIntervalMs: interval, jobId: candidate.jobId});
  const checkpoint = commitRead(readFor(first), [10], now);
  assert.deepEqual(Object.keys(checkpoint).sort(), ['entries', 'version']);
  assert.deepEqual(checkpoint.entries[checkpointKey].mids, [10]);
  const fresh = planIncremental({contacts: [contact()], scope: [candidate], checkpoint, now: now + 1, fullScanIntervalMs: interval, jobId: candidate.jobId});
  assert.deepEqual(fresh.reads, []);
  const due = planIncremental({contacts: [contact()], scope: [candidate], checkpoint, now: now + interval, fullScanIntervalMs: interval, jobId: candidate.jobId});
  assert.equal(due.reads.length, 1);
  assert.equal(due.reads[0].reason, 'full_scan_due');
});

test('rotating credentials do not change the metadata fingerprint or force a reread', () => {
  const original = contact({securityId: 'security-old', token: 'token-old'});
  const first = planIncremental({contacts: [original], scope: [candidate], now, fullScanIntervalMs: interval, jobId: candidate.jobId});
  const fingerprint = readFor(first).metadataFingerprint;
  const checkpoint = commitRead(readFor(first), [10], now);
  const rotated = contact({securityId: 'security-new', token: 'token-new'});
  const second = planIncremental({contacts: [rotated], scope: [candidate], checkpoint, now: now + 1, fullScanIntervalMs: interval, jobId: candidate.jobId});
  assert.deepEqual(second.reads, []);
  assert.equal(JSON.stringify(checkpoint).includes('security-'), false);
  assert.equal(JSON.stringify(checkpoint).includes('token-'), false);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test('partial and failed observations never advance a checkpoint', () => {
  const first = planIncremental({contacts: [contact()], scope: [candidate], now, fullScanIntervalMs: interval, jobId: candidate.jobId});
  const checkpoint = commitRead(readFor(first), [10], now);
  const before = JSON.stringify(checkpoint);
  const partial = commitObservations({
    checkpoint,
    successes: [successfulObservation(readFor(first), [99], {complete: false})],
    now: now + 50,
  });
  assert.equal(JSON.stringify(partial), before);
  const failure = commitObservations({
    checkpoint,
    successes: [{candidate, metadataFingerprint: readFor(first).metadataFingerprint, mids: [100], error: 'offline failure'}],
    now: now + 100,
  });
  assert.equal(JSON.stringify(failure), before);
});

test('name-conflicting successful sources cannot append mids or overwrite the existing identity', () => {
  const first = planIncremental({contacts: [contact()], scope: [candidate], now, fullScanIntervalMs: interval, jobId: candidate.jobId});
  const checkpoint = commitRead(readFor(first), [10], now);
  const before = JSON.stringify(checkpoint);
  const fingerprint = checkpoint.entries[checkpointKey].metadataFingerprint;
  const conflicting = commitObservations({
    checkpoint,
    successes: [
      {candidate: {...candidate, name: '成功源甲'}, metadataFingerprint: fingerprint, mids: [11], complete: true},
      {candidate: {...candidate, name: '成功源乙'}, metadataFingerprint: fingerprint, mids: [12], complete: true},
    ],
    now: now + 1,
  });
  assert.equal(JSON.stringify(conflicting), before);
  assert.equal(conflicting.entries[checkpointKey].candidate.name, candidate.name);
  assert.deepEqual(conflicting.entries[checkpointKey].mids, [10]);

  const renamed = commitObservations({
    checkpoint,
    successes: [{candidate: {...candidate, name: '与旧身份冲突'}, metadataFingerprint: fingerprint, mids: [13], complete: true}],
    now: now + 2,
  });
  assert.equal(JSON.stringify(renamed), before);
});

test('new inbound mids are selected by exact mid history, including future mids from the same UID', () => {
  const messages = [
    {mid: 10, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'old'}},
    {mid: 11, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'handled'}},
    {mid: 12, from: {uid: 900}, to: {uid: candidate.uid}, body: {text: '招聘方文本不是候选人回复'}},
    {mid: 13, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'future reply'}},
  ];
  const result = diffInbound({candidate, messages, previousMids: [10], handledMids: [11]});
  assert.deepEqual(Object.keys(result).sort(), ['candidateTextMids', 'issues', 'platformMids']);
  assert.deepEqual(result.candidateTextMids, [13]);
  const sameMid = diffInbound({candidate, messages, previousMids: [10], handledMids: [11, 12, 13]});
  assert.deepEqual(sameMid.candidateTextMids, []);
});

test('duplicate mids and unknown structures are reported instead of treated as no reply', () => {
  const duplicate = diffInbound({
    candidate,
    messages: [
      {mid: 21, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'one'}},
      {mid: 21, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'two'}},
    ],
  });
  assert.deepEqual(duplicate.candidateTextMids, []);
  assert.equal(duplicate.issues.some(item => item.code === 'duplicate_message_mid'), true);

  const unknown = diffInbound({
    candidate,
    messages: [{mid: 22, from: {uid: candidate.uid}, to: {uid: 900}, body: {mystery: true}}],
  });
  assert.deepEqual(unknown.candidateTextMids, []);
  assert.equal(unknown.issues.some(item => item.code === 'unknown_message_structure'), true);
});

test('recruiter text is excluded and acknowledgements remain review-only mids', () => {
  const recruiter = diffInbound({
    candidate,
    messages: [{mid: 31, from: {uid: 900}, to: {uid: candidate.uid}, body: {text: '候选人已接受'}}],
  });
  assert.deepEqual(recruiter.candidateTextMids, []);
  assert.deepEqual(recruiter.issues, []);

  const thanks = diffInbound({
    candidate,
    messages: [{mid: 32, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: '谢谢老板！'}}],
  });
  assert.deepEqual(thanks.candidateTextMids, [32]);
  assert.deepEqual(thanks.platformMids, []);
});

test('attachments and explicit platform events are isolated in platformMids', () => {
  const result = diffInbound({
    candidate,
    messages: [
      {
        mid: 41,
        from: {uid: candidate.uid},
        to: {uid: 900},
        body: {text: '附件说明', hyperLink: {url: 'https://example.invalid/private?token=SECRET_FIXTURE'}},
      },
      {
        mid: 42,
        from: {uid: candidate.uid},
        to: {uid: 900},
        body: {eventType: 'resume_accepted'},
      },
    ],
  });
  assert.deepEqual(result.candidateTextMids, []);
  assert.deepEqual(result.platformMids, [41, 42]);
  assert.equal(JSON.stringify(result).includes('SECRET_FIXTURE'), false);
});

test('all three functions leave frozen synthetic inputs unchanged', () => {
  const frozenContact = freeze(contact());
  const frozenScope = freeze([{...candidate}]);
  const first = planIncremental({contacts: [frozenContact], scope: frozenScope, now, jobId: candidate.jobId});
  const frozenCheckpoint = freeze({
    version: 1,
    entries: {
      [checkpointKey]: {
        candidate: {...candidate},
        metadataFingerprint: readFor(first).metadataFingerprint,
        mids: [],
        lastFullScanAt: now - 1,
      },
    },
  });
  const plan = planIncremental({contacts: [frozenContact], scope: frozenScope, checkpoint: frozenCheckpoint, now, jobId: candidate.jobId});
  assert.doesNotThrow(() => JSON.stringify(plan));
  const committed = commitObservations({checkpoint: frozenCheckpoint, successes: [successfulObservation(readFor(first), [10])], now});
  assert.doesNotThrow(() => JSON.stringify(committed));
  const messages = freeze([{mid: 51, from: {uid: candidate.uid}, to: {uid: 900}, body: {text: 'synthetic'}}]);
  const diff = diffInbound({candidate: freeze({...candidate}), messages});
  assert.deepEqual(diff.candidateTextMids, [51]);
});

test('normal-client resume dialogs and action receipts stay platform-only', () => {
  const result = diffInbound({candidate, messages: [
    {mid: 61, from: {uid: candidate.uid}, to: {uid: 900}, body: {type: 7, dialog: {type: 2, operated: false, buttons: [{text: '同意', url: 'bosszp://synthetic.invalid/?aid=41'}]}}},
    {mid: 62, from: {uid: candidate.uid}, to: {uid: 900}, body: {type: 4, action: {aid: 41, extend: 'synthetic-data'}}},
    {mid: 63, from: {uid: 900}, to: {uid: candidate.uid}, body: {type: 4, action: {aid: 41, extend: 'synthetic-data'}}},
  ]});
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.candidateTextMids, []);
  assert.deepEqual(result.platformMids, [61, 62]);
});

test('malformed action and unknown dialog wire shapes remain manual-review issues', () => {
  const result = diffInbound({candidate, messages: [
    {mid: 71, from: {uid: candidate.uid}, to: {uid: 900}, body: {type: 4, action: {}}},
    {mid: 72, from: {uid: candidate.uid}, to: {uid: 900}, body: {type: 7, dialog: {type: 99, operated: false, buttons: []}}},
  ]});
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.candidateTextMids, []);
  assert.deepEqual(result.platformMids, []);
});

test('string and array wire type coercions do not qualify as known platform cards', () => {
  const result = diffInbound({candidate, messages: [
    ...['4', [4]].map((type, i) => ({mid: 81+i, from: {uid: candidate.uid}, to: {uid: 900}, body: {type, action: {aid: 41}}})),
    ...['7', [7]].map((type, i) => ({mid: 83+i, from: {uid: candidate.uid}, to: {uid: 900}, body: {type, dialog: {type: 2, operated: false, buttons: []}}})),
  ]});
  assert.equal(result.issues.length, 4);
  assert.deepEqual(result.candidateTextMids, []);
  assert.deepEqual(result.platformMids, []);
});


