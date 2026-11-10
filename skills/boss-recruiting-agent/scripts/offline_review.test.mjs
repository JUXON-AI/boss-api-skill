import test from 'node:test';
import assert from 'node:assert/strict';
import {hash, historyFingerprint} from '../../../scripts/runtime.mjs';
import {prepareOfflineReview, checkOfflineReview} from './offline_review.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';

const keys = ['core_role_skills', 'project_depth', 'engineering_habits', 'learning_and_collaboration'];
export function fixture() {
  const messages = [{mid: 1, from: {uid: 2}, to: {uid: 1}, body: {text: '学校手续方便吗？'}},
    {mid: 2, from: {uid: 1}, to: {uid: 2}, body: {text: '学校允许外出实习。\r\n我用过Cursor写接口。'}}];
  const dims = Object.fromEntries(keys.map(k => [k, k === 'learning_and_collaboration' ? null : 70]));
  const packet = {candidate: {uid: 1, name: '离线测试', jobId: 'test-job'}, jobProfile: {boss_job_id: 'test-job'},
    formalRecord: {candidate: {uid: 1, name: '离线测试'}, job: {boss_job_id: 'test-job'}, communication: {round: 1}, score: {dimensions: dims}},
    history: {complete: true, messages, sha256: historyFingerprint(messages)}};
  packet.formalRecordSHA = canonicalJsonSha256(packet.formalRecord);
  const response = {newTechnology: false, dimensions: dims, evidence: [], dimensionEvidence: Object.fromEntries(keys.map(k => [k, []])),
    conditions: ['salary', 'onsite', 'days', 'duration', 'school', 'arrival', 'go', 'aiCoding', 'claudeAccount'].map(key => ({key, status: 'unknown', evidence: []})),
    decision: 'hold', messageDraft: null, notes: []};
  return {packet, response};
}

test('one full packet is passed once, preserving raw history and formal score', () => {
  const {packet, response} = fixture();
  const request = prepareOfflineReview(packet);
  assert.deepEqual(request.packet, packet);
  assert.equal(request.message.split(JSON.stringify(packet)).length, 2);
  assert.equal(checkOfflineReview(request, response).valid, true);
  assert.equal(checkOfflineReview(request, response).mainApprovalRequired, true);
  assert.equal(checkOfflineReview(request, response).SDKInvoked, false);
});
test('first numeric review binds existing own technical evidence without inventing a formal score', () => {
  const {packet, response} = fixture();
  delete packet.formalRecord; delete packet.formalRecordSHA;
  packet.history.messages = [packet.history.messages[1]];
  packet.history.sha256 = historyFingerprint(packet.history.messages);
  response.newTechnology = true;
  response.dimensions = Object.fromEntries(keys.map(k => [k, k === 'core_role_skills' ? 50 : null]));
  response.evidence = [{purpose: 'core_role_skills', sourceType: 'message', mid: 2,
    documentId: null, quote: '我用过Cursor写接口。', questionMid: null}];
  response.dimensionEvidence.core_role_skills = [0];
  response.decision = 'contact'; response.messageDraft = '你主要做过哪些后端功能？';
  const request = prepareOfflineReview(packet);
  assert.match(request.message, /formalRecord=null时是首次评分/);
  const checked = checkOfflineReview(request, response);
  assert.equal(checked.valid, true);
  assert.equal(checked.binding.currentRound, 0);
  assert.equal(checked.formalRecordWritten, false);
  response.newTechnology = false;
  assert.ok(checkOfflineReview(request, response).errors.some(e => e.code === 'unchanged_score_required'));
});
test('rejects incomplete history, wrong identities, duplicate mids and changed CAS', () => {
  for (const mutate of [p => p.history.complete = false, p => p.candidate.jobId = 'other',
    p => p.history.messages.push(p.history.messages[0]), p => p.formalRecord.candidate.uid = 9,
    p => p.formalRecordSHA = 'a'.repeat(64)]) {
    const {packet} = fixture(); mutate(packet); assert.throws(() => prepareOfflineReview(packet));
  }
});
test('collects all output errors without accepting altered unchanged scores', () => {
  const {packet, response} = fixture(); response.dimensions = {...response.dimensions, core_role_skills: 80, project_depth: 101};
  response.decision = 'invalid'; response.notes = null;
  const result = checkOfflineReview(prepareOfflineReview(packet), response);
  assert.equal(result.valid, false);
  for (const code of ['unchanged_score_required', 'raw_dimension_range', 'decision_enum', 'notes_array']) assert.ok(result.errors.some(x => x.code === code));
});
test('confirmed evidence must be own exact quote; recruiter text cannot prove acceptance', () => {
  const {packet, response} = fixture();
  response.conditions.find(x => x.key === 'school').status = 'confirmed';
  response.conditions.find(x => x.key === 'school').evidence = [0];
  response.evidence = [{purpose: 'school', sourceType: 'message', mid: 2, documentId: null, quote: '学校允许外出实习。', questionMid: 1}];
  const request = prepareOfflineReview(packet);
  assert.equal(checkOfflineReview(request, response).valid, true);
  response.evidence[0].mid = 1; response.evidence[0].quote = '学校手续方便吗？';
  assert.equal(checkOfflineReview(request, response).valid, false);
});
test('bound documents work; CRLF is not silently rewritten', () => {
  const {packet, response} = fixture(); const text = '本人独立实现接口。\r\n使用Claude Code调试。';
  packet.documents = [{id: 'resume', uid: 1, jobId: 'test-job', identityVerified: true, text, textSha256: hash(text)}];
  response.evidence = [{purpose: 'AI编码', sourceType: 'document', mid: null, documentId: 'resume', quote: text, questionMid: null}];
  const request = prepareOfflineReview(packet);
  assert.equal(checkOfflineReview(request, response).valid, true);
  response.evidence[0].quote = text.replaceAll('\r\n', '\n');
  assert.equal(checkOfflineReview(request, response).valid, false);
  packet.documents[0].uid = 8; assert.throws(() => prepareOfflineReview(packet));
});
test('round limits, pause and numerical gates remain enforced', () => {
  const {packet, response} = fixture(); packet.formalRecord.communication.round = 2;
  packet.formalRecordSHA = canonicalJsonSha256(packet.formalRecord);
  response.decision = 'substantive_round2'; response.messageDraft = '问一下缺项';
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(x => x.code === 'two_round_limit'));
  packet.formalRecord.communication.round = 1; packet.paused = true;
  packet.formalRecordSHA = canonicalJsonSha256(packet.formalRecord);
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(x => x.code === 'paused_requires_main_decision'));
  packet.paused = false; packet.formalRecord.score.dimensions = Object.fromEntries(keys.map(k => [k, 40]));
  packet.formalRecordSHA = canonicalJsonSha256(packet.formalRecord);
  response.dimensions = {...packet.formalRecord.score.dimensions};
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(x => x.code === 'score_gate'));
});
test('changed prepared packet cannot bind a review', () => {
  const {packet, response} = fixture(); const request = prepareOfflineReview(packet);
  request.packet.history.messages[0].body.text = 'changed';
  assert.throws(() => checkOfflineReview(request, response));
});
test('changed binding and missing old formal record are rejected', () => {
  const {packet, response} = fixture(); const request = prepareOfflineReview(packet);
  request.binding.currentRound = 0;
  assert.throws(() => checkOfflineReview(request, response));
  delete packet.formalRecord; delete packet.formalRecordSHA;
  assert.throws(() => prepareOfflineReview(packet));
});
test('a future question cannot support an earlier candidate answer', () => {
  const {packet, response} = fixture(); packet.history.messages[0].mid = 3;
  packet.history.sha256 = historyFingerprint(packet.history.messages);
  response.evidence = [{purpose: 'school', sourceType: 'message', mid: 2, documentId: null, quote: '学校允许外出实习。', questionMid: 3}];
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(e => e.code === 'question_source'));
});
test('malformed pass returns a list of errors rather than throwing', () => {
  const {packet, response} = fixture(); response.decision = 'pass'; response.conditions = [null];
  assert.equal(checkOfflineReview(prepareOfflineReview(packet), response).valid, false);
});
test('profile availability proves only arrival, never school or ability', () => {
  const {packet, response} = fixture();
  packet.history.messages.push({mid: 4, from: {uid: 1}, to: {uid: 2}, body: {resume: {applyStatus: '离职-随时到岗'}}});
  packet.history.sha256 = historyFingerprint(packet.history.messages);
  response.evidence = [{purpose: 'arrival', sourceType: 'profile', mid: 4, documentId: null, quote: '随时到岗', questionMid: null}];
  response.conditions.find(x => x.key === 'arrival').status = 'confirmed';
  response.conditions.find(x => x.key === 'arrival').evidence = [0];
  const request = prepareOfflineReview(packet);
  assert.equal(checkOfflineReview(request, response).valid, true);
  response.conditions.find(x => x.key === 'school').status = 'confirmed';
  response.conditions.find(x => x.key === 'school').evidence = [0];
  assert.ok(checkOfflineReview(request, response).errors.some(x => x.code === 'profile_arrival_only'));
});
