import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { executeResumeAcceptance, planResumeAcceptance } from './resume_intake.mjs';

function fixture() {
  const candidate = { uid: '101', name: '合成候选人', jobId: '583607920' };
  const attachment = { resumeId: '303', resumeName: '合成简历.pdf', annexType: 1, resumeRevocable: true };
  return {
    candidate,
    ownUid: '202',
    scope: { jobId: '583607920', targetUids: ['101'] },
    requestMid: '404',
    history: {
      candidate: { ...candidate }, complete: true,
      messages: [{
        mid: '404', type: 1,
        from: { uid: '101', name: '合成候选人' }, to: { uid: '202' },
        body: { type: 7, dialog: {
          type: 2, operated: false, buttons: [
            { text: '同意', url: 'bosszp://bosszhipin.app/openwith?type=sendaction&uid=101&aid=41&extends=' + encodeURIComponent(JSON.stringify(attachment)) },
            { text: '拒绝', url: 'bosszp://bosszhipin.app/openwith?type=sendaction&uid=101&aid=42' },
          ],
        } },
      }],
    },
  };
}

const card = input => input.history.messages[0].body.dialog;
const acceptButton = input => card(input).buttons[0];
function changeAttachment(input, patch) {
  const url = new URL(acceptButton(input).url);
  const attachment = JSON.parse(url.searchParams.get('extends'));
  url.searchParams.set('extends', JSON.stringify({ ...attachment, ...patch }));
  acceptButton(input).url = url.href;
}

test('plans only normal accept params and hashes actual canonical input without mutation', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = planResumeAcceptance(input);
  assert.deepEqual(result.candidate, input.candidate);
  assert.equal(result.action, 'accept_candidate_resume');
  assert.equal(result.requestMid, '404');
  assert.equal(result.resumeId, '303');
  assert.equal(result.resumeName, '合成简历.pdf');
  assert.deepEqual(result.request, { mid: '404', type: 3, scene: 1 });
  assert.equal(Object.hasOwn(result.request, 'securityId'), false);
  assert.deepEqual(input, before);
  // An independently constructed canonical body, including the complete URL.
  const expectedBody = '{"dialog":{"buttons":[{"text":"同意","url":' +
    JSON.stringify(acceptButton(input).url) + '},{"text":"拒绝","url":' +
    JSON.stringify(card(input).buttons[1].url) + '}],"operated":false,"type":2},"type":7}';
  assert.equal(result.bodySha256, createHash('sha256').update(expectedBody, 'utf8').digest('hex'));
  assert.match(result.historySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(), [
    'action', 'candidate', 'requestMid', 'resumeId', 'resumeName', 'bodySha256', 'historySha256', 'request',
  ].sort());
});

test('hashes ignore property insertion order but bind body and entire history contents', () => {
  const input = fixture();
  const original = planResumeAcceptance(input);
  input.history = { messages: input.history.messages, complete: true, candidate: input.candidate };
  input.history.messages[0].body = { dialog: { ...card(input) }, type: 7 };
  assert.deepEqual(planResumeAcceptance(input), original);
  input.history.messages.push({ mid: '405', type: 1, body: { type: 1, text: '合成历史' } });
  const moreHistory = planResumeAcceptance(input);
  assert.equal(moreHistory.bodySha256, original.bodySha256);
  assert.notEqual(moreHistory.historySha256, original.historySha256);
  card(input).title = '合成卡片';
  assert.notEqual(planResumeAcceptance(input).bodySha256, original.bodySha256);
});

const invalidCases = [
  ['incomplete history', x => { x.history.complete = false; }],
  ['wrong history uid', x => { x.history.candidate.uid = '999'; }],
  ['wrong history name', x => { x.history.candidate.name = '另一合成人'; }],
  ['wrong history job', x => { x.history.candidate.jobId = '999'; }],
  ['wrong scoped job', x => { x.scope.jobId = '999'; }],
  ['uid outside target scope', x => { x.scope.targetUids = ['999']; }],
  ['unsafe numeric uid', x => { x.candidate.uid = Number.MAX_SAFE_INTEGER + 1; }],
  ['unsafe numeric job', x => { x.candidate.jobId = Number.MAX_SAFE_INTEGER + 1; }],
  ['unsafe numeric mid', x => { x.requestMid = Number.MAX_SAFE_INTEGER + 1; }],
  ['empty name', x => { x.candidate.name = ' '; }],
  ['zero uid', x => { x.candidate.uid = 0; }],
  ['missing mid', x => { x.requestMid = '999'; }],
  ['duplicate mid', x => { x.history.messages.push(structuredClone(x.history.messages[0])); }],
  ['outbound request', x => { x.history.messages[0].from.uid = '202'; x.history.messages[0].to.uid = '101'; }],
  ['wrong recipient', x => { x.history.messages[0].to.uid = '999'; }],
  ['wrong sender name', x => { x.history.messages[0].from.name = '另一合成人'; }],
  ['wrong message job', x => { x.history.messages[0].jobId = '999'; }],
  ['wrong message type', x => { x.history.messages[0].type = 2; }],
  ['other body type', x => { x.history.messages[0].body.type = 1; }],
  ['other dialog type', x => { card(x).type = 1; }],
  ['missing operated', x => { delete card(x).operated; }],
  ['coerced operated', x => { card(x).operated = 0; }],
  ['missing buttons', x => { delete card(x).buttons; }],
  ['empty buttons', x => { card(x).buttons = []; }],
  ['duplicate consent button', x => { card(x).buttons.push({ ...acceptButton(x) }); }],
  ['ambiguous consent button', x => { card(x).buttons.push({ text: '同意', url: acceptButton(x).url.replace('aid=41', 'aid=33') }); }],
  ['invented agreeText/agreeURL shape', x => {
    card(x).agreeText = '同意'; card(x).agreeURL = acceptButton(x).url; delete card(x).buttons;
  }],
  ['asking resume', x => { acceptButton(x).text = '索要简历'; }],
  ['phone button', x => { acceptButton(x).text = '交换电话'; }],
  ['wechat button', x => { acceptButton(x).text = '交换微信'; }],
  ['action 33', x => { acceptButton(x).url = acceptButton(x).url.replace('aid=41', 'aid=33'); }],
  ['reject action', x => { acceptButton(x).url = acceptButton(x).url.replace('aid=41', 'aid=42'); }],
  ['wrong URL uid', x => { acceptButton(x).url = acceptButton(x).url.replace('uid=101', 'uid=999'); }],
  ['wrong scheme', x => { acceptButton(x).url = acceptButton(x).url.replace('bosszp:', 'https:'); }],
  ['wrong host', x => { acceptButton(x).url = acceptButton(x).url.replace('bosszhipin.app', 'other.invalid'); }],
  ['wrong pathname', x => { acceptButton(x).url = acceptButton(x).url.replace('/openwith?', '/other?'); }],
  ['URL credentials', x => { acceptButton(x).url = acceptButton(x).url.replace('://', '://user@'); }],
  ['URL port', x => { acceptButton(x).url = acceptButton(x).url.replace('.app/', '.app:443/'); }],
  ['extra query', x => { acceptButton(x).url += '&email=test'; }],
  ['missing parameter', x => { acceptButton(x).url = acceptButton(x).url.replace('&aid=41', ''); }],
  ['duplicate aid', x => { acceptButton(x).url += '&aid=41'; }],
  ['duplicate encoded key', x => { acceptButton(x).url += '&%61id=41'; }],
  ['fragment', x => { acceptButton(x).url += '#fragment'; }],
  ['empty fragment', x => { acceptButton(x).url += '#'; }],
  ['bad JSON', x => { acceptButton(x).url = acceptButton(x).url.split('&extends=')[0] + '&extends=oops'; }],
  ['empty resume name', x => changeAttachment(x, { resumeName: ' ' })],
  ['unsafe resume id', x => changeAttachment(x, { resumeId: Number.MAX_SAFE_INTEGER + 1 })],
  ['zero resume id', x => changeAttachment(x, { resumeId: '0' })],
];
for (const [label, mutate] of invalidCases) {
  test(`rejects ${label}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => planResumeAcceptance(input));
  });
}

test('permits large finite metadata and deterministically hashes the parsed representation', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1e100, -1e100, 1.25]) {
    const input = fixture();
    const original = planResumeAcceptance(input);
    input.history.messages[0].timestamp = value;
    input.history.metadata = { serverCounter: value };
    input.history.messages[0].body.metadata = { serverCounter: value };
    const before = structuredClone(input);
    const result = planResumeAcceptance(input);
    assert.equal(result.action, 'accept_candidate_resume');
    assert.deepEqual(result.request, original.request);
    assert.notEqual(result.historySha256, original.historySha256);
    assert.notEqual(result.bodySha256, original.bodySha256);
    assert.deepEqual(planResumeAcceptance(JSON.parse(JSON.stringify(input))), result);
    assert.deepEqual(input, before);
  }
});

test('large metadata never relaxes safe numeric UID, job, request mid or resume ID validation', () => {
  const unsafeId = Number.MAX_SAFE_INTEGER + 1;
  for (const [mutate, expected] of [
    [input => { input.candidate.uid = unsafeId; }, /candidate\.uid must be a safe positive ID/],
    [input => { input.candidate.jobId = unsafeId; }, /candidate\.jobId must be a safe positive ID/],
    [input => { input.requestMid = unsafeId; }, /requestMid must be a safe positive ID/],
    [input => changeAttachment(input, { resumeId: unsafeId }), /resumeId must be a safe positive ID/],
  ]) {
    const input = fixture();
    input.history.metadata = { serverCounter: unsafeId };
    mutate(input);
    assert.throws(() => planResumeAcceptance(input), expected);
  }
});

test('accepts query parameters in any order and consent at any button index', () => {
  const input = fixture();
  const url = new URL(acceptButton(input).url);
  const params = new URLSearchParams();
  for (const key of ['extends', 'aid', 'uid', 'type']) params.set(key, url.searchParams.get(key));
  url.search = params.toString();
  acceptButton(input).url = url.href;
  card(input).buttons.reverse();
  assert.equal(planResumeAcceptance(input).action, 'accept_candidate_resume');
});

for (const status of ['failed', 'unknown', 'succeeded', 'completed']) {
  test(`blocks prior ${status} attempts without retry`, () => {
    const input = fixture();
    input.priorAttempts = [{ uid: '101', requestMid: '404', status }];
    assert.throws(() => planResumeAcceptance(input), /prior attempt/i);
  });
}

test('blocks same mid with wrong UID regardless of completed outcome', () => {
  for (const status of ['failed', 'succeeded', 'completed', 'unknown']) {
    const attempt = { uid: '999', requestMid: '404', status };
    assert.throws(() => planResumeAcceptance({ ...fixture(), priorAttempts: [attempt] }), /prior attempt/i);
  }
});

test('allows a genuinely new request after a completed older request by the same UID', () => {
  for (const status of ['succeeded', 'failed', 'completed']) {
    const input = fixture();
    const oldMessage = structuredClone(input.history.messages[0]);
    oldMessage.mid = '400';
    oldMessage.body.dialog.operated = true;
    input.history.messages.unshift(oldMessage);
    input.priorAttempts = [{ candidate: { uid: '101' }, requestMid: '400', status }];
    assert.deepEqual(planResumeAcceptance(input).request, { mid: '404', type: 3, scene: 1 });
  }
});

test('pauses same UID with unknown or unfinished old outcome', () => {
  for (const extra of [{}, { status: 'unknown' }, { status: 'pending' }, { outcome: 'unknown' },
    { status: 'completed', outcome: 'unknown' }]) {
    const attempt = { uid: '101', requestMid: '400', ...extra };
    assert.throws(() => planResumeAcceptance({ ...fixture(), priorAttempts: [attempt] }), /prior attempt/i);
  }
});

test('recognizes a terminal outcome field for an older different request', () => {
  const input = fixture();
  input.priorAttempts = [{ uid: '101', requestMid: '400', outcome: 'succeeded' }];
  assert.equal(planResumeAcceptance(input).action, 'accept_candidate_resume');
});

test('an unrelated prior attempt does not block', () => {
  assert.equal(planResumeAcceptance({ ...fixture(), priorAttempts: [{ uid: '999', requestMid: '998' }] }).action,
    'accept_candidate_resume');
});

test('operated true produces only a noop, including after a prior attempt', () => {
  const input = fixture();
  card(input).operated = true;
  input.priorAttempts = [{ uid: '101', requestMid: '404', status: 'unknown' }];
  assert.deepEqual(planResumeAcceptance(input), { action: 'already_operated_noop' });
});

test('operated does not bypass identity or card validation', () => {
  const input = fixture();
  card(input).operated = true;
  acceptButton(input).url = acceptButton(input).url.replace('aid=41', 'aid=33');
  assert.throws(() => planResumeAcceptance(input));
});

test('safe integer inputs normalize deterministically', () => {
  const input = fixture();
  input.candidate.uid = 101;
  input.ownUid = 202;
  input.requestMid = 404;
  assert.deepEqual(planResumeAcceptance(input).request, { mid: '404', type: 3, scene: 1 });
});

test('rejects non-JSON and cyclic inputs instead of hashing lossy representations', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, -0, 1n, new Date(), () => {}]) {
    const input = fixture();
    input.history.extra = value;
    assert.throws(() => planResumeAcceptance(input));
  }
  const input = fixture();
  input.history.self = input.history;
  assert.throws(() => planResumeAcceptance(input));
});

test('preserves original filename whitespace while keeping person names strict', () => {
  const input = fixture();
  changeAttachment(input, { resumeName: ' 合成简历.pdf  ' });
  assert.equal(planResumeAcceptance(input).resumeName, ' 合成简历.pdf  ');
  input.candidate.name += ' ';
  input.history.candidate.name += ' ';
  assert.throws(() => planResumeAcceptance(input), /candidate\.name/);
});

test('resume filenames must remain nonblank, bounded, and free of control characters', () => {
  for (const resumeName of ['', '  ', 123, 'x'.repeat(513), '合成\n简历.pdf', '合成简历.pdf\u007f']) {
    const input = fixture();
    changeAttachment(input, { resumeName });
    assert.throws(() => planResumeAcceptance(input), /resumeName/);
  }
});

function fakePorts(input) {
  const calls = [];
  const fresh = structuredClone(input.history);
  const back = structuredClone(input.history);
  back.messages[0].body.dialog.operated = true;
  return {
    calls, fresh, back,
    ports: {
      async readFreshHistory() { calls.push('fresh'); return fresh; },
      async writeAttempt(plan) { calls.push('attempt'); assert.equal(plan.action, 'accept_candidate_resume'); },
      async invokeAccept(request) {
        calls.push('accept');
        assert.deepEqual(request, { mid: '404', type: 3, scene: 1 });
        return { code: 0, zpData: { status: 0 } };
      },
      async readBack() { calls.push('back'); return back; },
    },
  };
}

test('orchestrator validates fresh history, records attempt, accepts once and verifies once without mutation', async () => {
  const input = fixture();
  const state = fakePorts(input);
  state.fresh.metadata = { source: 'synthetic fresh read' };
  // The supplied history is stale; only the fresh history is authoritative.
  input.history.complete = false;
  const before = structuredClone(input);
  const result = await executeResumeAcceptance(input, state.ports);
  assert.deepEqual(state.calls, ['fresh', 'attempt', 'accept', 'back']);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.plan, planResumeAcceptance({ ...input, history: state.fresh }));
  assert.deepEqual(input, before);
});

test('fresh operated card returns noop without recording or invoking accept', async () => {
  const input = fixture();
  const state = fakePorts(input);
  state.fresh.messages[0].body.dialog.operated = true;
  assert.deepEqual(await executeResumeAcceptance(input, state.ports), { action: 'already_operated_noop' });
  assert.deepEqual(state.calls, ['fresh']);
});

test('invalid fresh preflight, including changed UID, never records or invokes accept', async () => {
  for (const mutate of [
    history => { history.complete = false; },
    history => { history.candidate.uid = '999'; },
    history => { history.messages[0].from.uid = '999'; },
    history => { history.messages[0].body.dialog.type = 1; },
  ]) {
    const input = fixture();
    const state = fakePorts(input);
    mutate(state.fresh);
    await assert.rejects(executeResumeAcceptance(input, state.ports));
    assert.deepEqual(state.calls, ['fresh']);
  }
});

test('prior-attempt collision never reaches attempt writer or accept', async () => {
  const input = fixture();
  input.priorAttempts = [{ uid: '101', requestMid: '404', status: 'unknown' }];
  const state = fakePorts(input);
  await assert.rejects(executeResumeAcceptance(input, state.ports), /prior attempt/i);
  assert.deepEqual(state.calls, ['fresh']);
});

test('atomic attempt-write failure prevents accept and read-back', async () => {
  const input = fixture();
  const state = fakePorts(input);
  state.ports.writeAttempt = async () => { state.calls.push('attempt'); throw new Error('atomic collision'); };
  await assert.rejects(executeResumeAcceptance(input, state.ports), /atomic collision/);
  assert.deepEqual(state.calls, ['fresh', 'attempt']);
});

test('unknown accept outcome propagates without retry or read-back', async () => {
  const input = fixture();
  const state = fakePorts(input);
  state.ports.invokeAccept = async () => { state.calls.push('accept'); throw new Error('unknown outcome'); };
  await assert.rejects(executeResumeAcceptance(input, state.ports), /unknown outcome/);
  assert.deepEqual(state.calls, ['fresh', 'attempt', 'accept']);
});

test('accept requires exact numeric code zero and status zero with no retry', async () => {
  for (const response of [undefined, null, {}, { code: 1, zpData: { status: 0 } },
    { code: 0 }, { code: '0', zpData: { status: 0 } }, { code: 0, zpData: { status: '0' } },
    { code: 0, zpData: { status: 4 } }]) {
    const input = fixture();
    const state = fakePorts(input);
    state.ports.invokeAccept = async () => { state.calls.push('accept'); return response; };
    await assert.rejects(executeResumeAcceptance(input, state.ports), /accept response/i);
    assert.deepEqual(state.calls, ['fresh', 'attempt', 'accept']);
  }
});

test('read-back must identify exactly the same inbound mid with operated true', async () => {
  for (const mutate of [
    history => { history.messages = []; },
    history => { history.messages[0].mid = '999'; },
    history => { history.messages.push(structuredClone(history.messages[0])); },
    history => { history.messages[0].from.uid = '999'; },
    history => { history.messages[0].to.uid = '999'; },
    history => { history.messages[0].body.dialog.operated = false; },
    history => { history.messages[0].body.dialog.operated = 'true'; },
  ]) {
    const input = fixture();
    const state = fakePorts(input);
    mutate(state.back);
    await assert.rejects(executeResumeAcceptance(input, state.ports));
    assert.deepEqual(state.calls, ['fresh', 'attempt', 'accept', 'back']);
  }
});

test('read-back failure propagates without retrying either operation', async () => {
  const input = fixture();
  const state = fakePorts(input);
  state.ports.readBack = async () => { state.calls.push('back'); throw new Error('read-back unavailable'); };
  await assert.rejects(executeResumeAcceptance(input, state.ports), /read-back unavailable/);
  assert.deepEqual(state.calls, ['fresh', 'attempt', 'accept', 'back']);
});
