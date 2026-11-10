import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {historyFingerprint} from '../../../scripts/runtime.mjs';
import {validateJobPolicy, legacyJobPolicy, jobPolicyVersion, scoreForJob, resolveKnowledgeFacts, ROLE_DIMENSIONS} from './job_policy.mjs';
import {canonicalJsonSha256, validateCandidateRecord} from './candidate_ledger.mjs';
import {prepareOfflineReview, checkOfflineReview} from './offline_review.mjs';
import {validateProposal} from './proposal_validation.mjs';
import {normalizeTalentGateNotes} from './talent_push_gate_notes.mjs';

const example = kind => JSON.parse(fs.readFileSync(new URL(`../assets/job-profile.${kind}.example.json`, import.meta.url), 'utf8'));
function fixture(kind = 'design') {
  const profile = example(kind); profile.screening_policy.approved = true;
  const messages = [{mid: 1, time: 1, from: {uid: 101}, to: {uid: 900}, body: {text: '本人独立负责方案、交付和修改。薪资和工作方式可以接受，两周内到岗。'}}];
  const packet = {candidate: {uid: 101, name: 'Synthetic', jobId: profile.boss_job_id}, jobProfile: profile,
    history: {complete: true, messages, sha256: historyFingerprint(messages)}, formalRecord: null};
  const response = {newTechnology: true, dimensions: Object.fromEntries(ROLE_DIMENSIONS.map(k => [k, 75])),
    evidence: [{purpose: 'role', sourceType: 'message', mid: 1, documentId: null, quote: messages[0].body.text, questionMid: null}],
    dimensionEvidence: Object.fromEntries(ROLE_DIMENSIONS.map(k => [k, [0]])),
    conditions: profile.screening_policy.conditions.map(c => ({key: c.key, status: 'confirmed', evidence: [0]})),
    decision: 'pass', messageDraft: null, notes: []};
  return {profile, packet, response};
}
function formal(profile, messages, value = 75) {
  const dims = Object.fromEntries(ROLE_DIMENSIONS.map(k => [k, value]));
  const score = scoreForJob(dims, profile.screening_policy);
  return {schema_version: 1, policy_version: jobPolicyVersion(profile.screening_policy), screening_policy: structuredClone(profile.screening_policy),
    job: {boss_job_id: profile.boss_job_id, job_profile_sha256: canonicalJsonSha256(profile)}, candidate: {uid: 101, name: 'Synthetic'},
    history: {complete: true, sha256: historyFingerprint(messages), checked_at: '2026-11-10T01:00:00Z', last_mid: messages.at(-1).mid, last_direction: 'in'},
    score: {dimensions: dims, ability_base_score: score.abilityBaseScore, evidence_coverage_percent: score.evidenceCoveragePercent,
      competition_bonus: 0, github_bonus: 0, proof_bonus: 0, final_signal_score: score.finalSignalScore, competitions: [], github_projects: [], evaluation_sha256: 'a'.repeat(64)},
    job_fit: {score: 75, hard_condition_status: 'pass', conditions: profile.screening_policy.conditions.map(c => ({key: c.key, status: 'confirmed', evidence: [{source: 'fixture', quote: messages[0].body.text}]}))},
    state: 'ai_screened_pass', recommendation: 'ready_for_hr', next_round: 0, next_action: 'Main review before action',
    facts: {confirmed: [], unverified: [], unknown: []}, communication: {round: 0, pending_inbound_mids: [messages.at(-1).mid]},
    sources: ['fixture'], updated_at: '2026-11-10T01:00:00Z'};
}

test('design and HR use explicit rubrics and conditions without inherited coding/school gates', () => {
  for (const kind of ['design', 'hr']) {
    const {profile, packet, response} = fixture(kind);
    validateJobPolicy(profile.screening_policy, profile);
    assert.deepEqual(response.conditions.map(c => c.key), ['salary', 'work_mode', 'arrival']);
    const request = prepareOfflineReview(packet), checked = checkOfflineReview(request, response);
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
    assert.equal(checked.computedScore.abilityBaseScore, 75);
    assert.match(request.message, /只确认配置的conditions/);
    const record = formal(profile, packet.history.messages);
    assert.equal(validateCandidateRecord(record).score.abilityBaseScore, 75);
    record.job_fit.conditions[0].status = 'unknown';
    assert.throws(() => validateCandidateRecord(record), /required role condition/);
  }
});

test('role weights normalize known evidence and do not inherit software proof bonuses', () => {
  const policy = validateJobPolicy(example('design').screening_policy);
  const values = {core_role_skills: 90, project_depth: 50, engineering_habits: null, learning_and_collaboration: null};
  const result = scoreForJob(values, policy);
  assert.equal(result.abilityBaseScore, 72.86); assert.equal(result.evidenceCoveragePercent, 70);
  assert.equal(result.proofBonus, 0);
  assert.throws(() => scoreForJob(values, policy, {githubProjects: [{}]}), /does not enable/);
  assert.equal(scoreForJob(Object.fromEntries(ROLE_DIMENSIONS.map(k => [k, null])), policy).abilityBaseScore, null);
  assert.equal(scoreForJob(values, legacyJobPolicy()).policyVersion, '2026-10-24.1');
});

test('optional preferences do not block admission; missing required conditions and unapproved policy do', () => {
  const {packet, response} = fixture();
  packet.jobProfile.screening_policy.conditions.push({key: 'optional_tool', label: '可选岗位工具', required: false});
  response.conditions.push({key: 'optional_tool', status: 'unknown', evidence: []});
  assert.equal(checkOfflineReview(prepareOfflineReview(packet), response).valid, true);
  response.conditions[0].status = 'unknown'; response.conditions[0].evidence = [];
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(e => e.code === 'pass_condition_missing'));
  response.conditions[0].status = 'confirmed'; response.conditions[0].evidence = [0];
  packet.jobProfile.screening_policy.approved = false;
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(e => e.code === 'job_policy_not_approved'));
});

test('invalid weights, cross-job scope, changed policy and unsourced acceptance are rejected', () => {
  const {profile, packet} = fixture();
  assert.throws(() => validateJobPolicy(profile.screening_policy, {boss_job_id: 'another-job'}), /scope mismatch/);
  const wrong = structuredClone(profile.screening_policy); wrong.dimensions.core_role_skills.weight++;
  assert.throws(() => validateJobPolicy(wrong), /sum to 100/);
  const record = formal(profile, packet.history.messages);
  record.job_fit.conditions[0].evidence[0].source = 'not-bound';
  assert.throws(() => validateCandidateRecord(record), /sourced exact quotations/);
  record.job_fit.conditions[0].evidence[0].source = 'fixture';
  packet.formalRecord = record; packet.formalRecordSHA = canonicalJsonSha256(record);
  packet.jobProfile.screening_policy.revision = 'next';
  assert.throws(() => prepareOfflineReview(packet), /explicit migration/);
});

test('approved per-role threshold reaches proposal validation while two-round and policy binding remain', () => {
  const {profile} = fixture('hr');
  profile.screening_policy.thresholds = {ability_base: 50, coverage: 70, signal: 50, job_fit: 60};
  const messages = [
    {mid: 1, time: 1, from: {uid: 101}, to: {uid: 900}, body: {text: '本人负责岗位邀约。'}},
    {mid: 2, time: 2, from: {uid: 900}, to: {uid: 101}, body: {text: '还负责哪些招聘环节？'}},
    {mid: 3, time: 3, from: {uid: 101}, to: {uid: 900}, body: {text: '还负责面试安排和反馈跟进。'}}];
  const record = formal(profile, messages, 55);
  record.state = 'needs_more_info'; record.recommendation = 'continue_contact'; record.next_round = 2;
  record.communication = {round: 1, pending_inbound_mids: [3], last_outbound_mid: 2, last_outbound_at: '2026-11-10T00:59:00Z'};
  const candidate = {uid: 101, name: 'Synthetic', boss_job_id: profile.boss_job_id};
  const packet = {candidate, recordSha256: canonicalJsonSha256(record), jobProfileSha256: canonicalJsonSha256(profile),
    history: {complete: true, messages, sha256: historyFingerprint(messages)}, safety: {
      blocked: false, humanConversationHold: false, alreadyHandled: false, baseReadbackVerified: false, bossHandoffSent: false}};
  const proposal = {candidate, expectedRecordSha256: packet.recordSha256, jobProfileSha256: packet.jobProfileSha256,
    expectedHistorySha256: packet.history.sha256, kind: 'substantive_round2', text: '你最快什么时候能到岗？',
    nextRecord: structuredClone(record), citations: [{mid: 3, quote: '面试安排和反馈跟进'}]};
  const input = {packet, proposal, currentRecord: record, jobProfile: profile, jobProfileHashMode: 'canonical'};
  const checked = validateProposal(input);
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  proposal.nextRecord.screening_policy.revision = 'other';
  assert.ok(validateProposal(input).errors.some(e => e.code === 'role_policy_mismatch'));
});

test('company facts inherit narrowly; other companies, departments, pending facts and conflicts stay distinct', () => {
  const identity = {company_key: 'co', department_key: 'people', boss_job_id: 'job'};
  const fact = {key: 'benefit', content: 'Confirmed', company_key: 'co', scope: 'company', source: 'hr', status: 'confirmed', external_allowed: true};
  const facts = [fact, {...fact, scope: 'department', department_key: 'other', content: 'Other department'},
    {...fact, company_key: 'other'}, {...fact, status: 'pending'}, {...fact, external_allowed: false},
    {...fact, scope: 'job', department_key: 'people', boss_job_id: 'other'},
    {...fact, scope: 'job', department_key: 'people', boss_job_id: 'job', content: 'Different confirmed statement'}];
  const result = resolveKnowledgeFacts(facts, identity);
  assert.equal(result.facts.length, 2); assert.deepEqual(result.conflicts, ['benefit']);
  assert.throws(() => resolveKnowledgeFacts(facts, {...identity, department_key: ''}));
});

test('generic group evidence follows exact configured conditions, without six-condition aliases', () => {
  const keys = ['salary', 'work_mode', 'arrival'];
  assert.equal(normalizeTalentGateNotes({gates: keys.map(condition => ({condition}))}, keys).gates.length, 3);
  assert.throws(() => normalizeTalentGateNotes({gates: ['salary', 'school', 'arrival'].map(condition => ({condition}))}, keys));
});

test('new roles still stop at unknown base and the configured substantive round limit', () => {
  const {packet, response} = fixture('hr');
  response.dimensions = Object.fromEntries(ROLE_DIMENSIONS.map(k => [k, null]));
  response.decision = 'contact'; response.messageDraft = '合成问题';
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(e => e.code === 'unknown_base_no_contact'));
  packet.jobProfile.screening_policy.max_substantive_rounds = 1;
  packet.formalRecord = formal(packet.jobProfile, packet.history.messages);
  packet.formalRecord.communication.round = 1;
  packet.formalRecordSHA = canonicalJsonSha256(packet.formalRecord);
  response.dimensions = packet.formalRecord.score.dimensions; response.newTechnology = false;
  response.decision = 'substantive_round2';
  assert.ok(checkOfflineReview(prepareOfflineReview(packet), response).errors.some(e => e.code === 'two_round_limit'));
});
