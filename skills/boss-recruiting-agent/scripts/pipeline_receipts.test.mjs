import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCORING_POLICY_VERSION} from '../../../scripts/scoring.mjs';
import {hash, historyFingerprint} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {claimPipelineTask, completePipelineClaim, verifyPipelineClaim, verifyPipelineExecution} from './pipeline_receipts.mjs';
import {createSyntheticPipelineReceiptFixture} from './test-helpers/pipeline-fixture.mjs';

const JOB_ID = 'job-1';
const UID = 101;
const OWN_UID = 900;
const BINDING = 'b'.repeat(64);
const JOB_PROFILE_SHA = 'a'.repeat(64);

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function writeJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(file, bytes);
  return {path: file, sha256: sha(bytes)};
}
function tempRoot(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-receipts-'));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  return {parent, root: path.join(parent, 'private')};
}
function errors(result) { return result.errors.map(error => error.code); }
function claimIdentity(fixture) {
  return {
    taskId: fixture.claim.taskId, jobId: fixture.claim.jobId, uid: fixture.claim.uid,
    sourceFingerprint: fixture.claim.sourceFingerprint, recordSha256: fixture.claim.recordSha256,
    bindingSha256: fixture.claim.bindingSha256,
  };
}

test('claim is exclusive, immutable, version-bound and expires without deletion', t => {
  const {root} = tempRoot(t);
  const base = {taskId: 'task-1', jobId: JOB_ID, uid: UID, sourceFingerprint: 'source-1', recordSha256: '1'.repeat(64), bindingSha256: '2'.repeat(64)};
  const claim = claimPipelineTask(root, base, {now: () => 1000, ttlMs: 10});
  assert.equal(claim.schemaVersion, 1);
  assert.match(claim.claimFile, /\.claim\.json$/u);
  assert.match(claim.uidLockFile, /\.lock$/u);
  assert.equal(claim.claimFileSha256, sha(fs.readFileSync(claim.claimFile)));
  assert.equal(verifyPipelineClaim(claim, base, {now: 1001}).verified, true);
  assert.throws(() => claimPipelineTask(root, {...base, recordSha256: '3'.repeat(64)}, {now: () => 1001, ttlMs: 10}), /already permanently claimed/u);
  assert.throws(() => claimPipelineTask(root, {...base, sourceFingerprint: 'source-2'}, {now: () => 1001, ttlMs: 10}), /locked by another source/u);
  assert.equal(fs.existsSync(claim.claimFile), true);
  assert.equal(verifyPipelineClaim(claim, {...base, recordSha256: '4'.repeat(64)}, {now: 1001}).verified, false);
  const expired = verifyPipelineClaim(claim, base, {now: 1010});
  assert.equal(expired.verified, false);
  assert.ok(errors(expired).includes('claim_expired'));
  assert.equal(fs.existsSync(claim.uidLockFile), true, 'expiry must not release an unknown execution lock');
});

test('claim rejects bare true and changed claim bytes', t => {
  const {root} = tempRoot(t);
  const base = {taskId: 'task-1', jobId: JOB_ID, uid: UID, sourceFingerprint: 'source-1', recordSha256: '1'.repeat(64), bindingSha256: '2'.repeat(64)};
  assert.equal(verifyPipelineClaim(true, base, {now: 1000}).verified, false);
  const claim = claimPipelineTask(root, base, {now: () => 1000, ttlMs: 1000});
  fs.appendFileSync(claim.claimFile, ' ');
  const changed = verifyPipelineClaim(claim, base, {now: 1001});
  assert.equal(changed.verified, false);
  assert.ok(errors(changed).includes('claim_file_sha256_mismatch'));
});

test('boss_text_send verifies actual files, public sender output, unique send and canonical CAS', t => {
  const {root} = tempRoot(t);
  const fixture = createSyntheticPipelineReceiptFixture(root);
  const result = verifyPipelineExecution(fixture.result, fixture);
  assert.equal(result.verified, true, JSON.stringify(result.errors));
  assert.equal(result.messageMid, 2);
  const completed = completePipelineClaim(fixture.claim);
  assert.equal(completed.completed, true, JSON.stringify(completed.errors));
  assert.equal(fs.existsSync(fixture.claim.uidLockFile), false);
  assert.equal(fs.existsSync(fixture.claim.claimFile), true);
  assert.equal(sha(fs.readFileSync(fixture.claim.claimFile)), fixture.claim.claimFileSha256);
  assert.equal(fs.existsSync(completed.completionFile), true);
  assert.equal(completePipelineClaim(fixture.claim).alreadyCompleted, true);
  assert.throws(() => claimPipelineTask(root, claimIdentity(fixture)), /completion receipt/u);
  const next = claimPipelineTask(root, {...claimIdentity(fixture), taskId: 'next-version', sourceFingerprint: 'new-source'});
  assert.notEqual(next.claimId, fixture.claim.claimId, 'a completed source must not block genuine later evidence for the same UID');
  assert.equal(verifyPipelineClaim(next, {...claimIdentity(fixture), taskId: 'next-version', sourceFingerprint: 'new-source'}).verified, true);
});

test('local_hold requires no sender and an exact canonical proposal ledger', t => {
  const {root} = tempRoot(t);
  const fixture = createSyntheticPipelineReceiptFixture(root, {kind: 'local_hold', casProposal: true});
  assert.equal(verifyPipelineExecution(fixture.result, fixture).verified, true);
  fixture.result.senderResult = fixture.result.ledgerAfter;
  const rejected = verifyPipelineExecution(fixture.result, fixture);
  assert.equal(rejected.verified, false);
  assert.ok(errors(rejected).includes('local_hold_sender_result'));
});

test('naked status, missing files and stale hashes never verify', t => {
  const {root} = tempRoot(t);
  const fixture = createSyntheticPipelineReceiptFixture(root);
  assert.equal(verifyPipelineExecution({ok: true, status: 'verified'}, fixture).verified, false);
  fixture.result.beforeHistory.sha256 = '0'.repeat(64);
  const badHash = verifyPipelineExecution(fixture.result, fixture);
  assert.ok(errors(badHash).includes('beforeHistory_sha256_mismatch'));
  delete fixture.result.senderResult;
  const missing = verifyPipelineExecution(fixture.result, fixture);
  assert.ok(errors(missing).includes('senderResult_missing'));
});

test('actual sender text, CAS wrapper and referenced files are independently rechecked', t => {
  const {root} = tempRoot(t);
  const text = createSyntheticPipelineReceiptFixture(path.join(root, 'text'));
  const sender = JSON.parse(fs.readFileSync(text.result.senderResult.path, 'utf8'));
  sender.textSha256 = '0'.repeat(64);
  text.result.senderResult = writeJson(text.result.senderResult.path, sender);
  assert.ok(errors(verifyPipelineExecution(text.result, text)).includes('sender_text_sha256_mismatch'));

  const cas = createSyntheticPipelineReceiptFixture(path.join(root, 'cas'));
  cas.result.casReceipt = writeJson(cas.result.casReceipt.path, {expectedRecordSha256: '0'.repeat(64), recordSha256: canonicalJsonSha256(cas.afterRecord)});
  assert.ok(errors(verifyPipelineExecution(cas.result, cas)).includes('cas_expected_not_bound'));

  const absent = createSyntheticPipelineReceiptFixture(path.join(root, 'absent'));
  fs.unlinkSync(absent.result.ledgerAfter.path);
  assert.ok(errors(verifyPipelineExecution(absent.result, absent)).includes('ledgerAfter_file_invalid'));
});

test('policy and HR sends preserve the current communication round', t => {
  const {root} = tempRoot(t);
  const policy = createSyntheticPipelineReceiptFixture(path.join(root, 'policy'), {proposalKind: 'policy'});
  const policyResult = verifyPipelineExecution(policy.result, policy);
  assert.equal(policyResult.verified, true, JSON.stringify(policyResult.errors));
  const hr = createSyntheticPipelineReceiptFixture(path.join(root, 'hr'), {proposalKind: 'hr_handoff'});
  const hrResult = verifyPipelineExecution(hr.result, hr);
  assert.equal(hrResult.verified, true, JSON.stringify(hrResult.errors));
});

test('post-send receipts cannot replace approved facts, score, profile or schema even with fresh file hashes and CAS', t => {
  const {root} = tempRoot(t);
  const mutations = [
    ledger => {ledger.job.job_profile_sha256 = 'd'.repeat(64);},
    ledger => {ledger.facts.confirmed = ['Unapproved claim'];},
    ledger => {ledger.score.evaluation_sha256 = 'e'.repeat(64);},
    ledger => {ledger.job_fit.score = 12;},
    ledger => {ledger.sources.push('Unapproved source');},
    ledger => {delete ledger.schema_version;},
    ledger => {ledger.candidate.extra = 'Unapproved identity data';},
    ledger => {ledger.history.complete = false;},
    ledger => {ledger.communication.extra = 'Unapproved field';},
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = createSyntheticPipelineReceiptFixture(path.join(root, String(index)));
    const ledger = structuredClone(fixture.afterRecord);
    mutate(ledger);
    fixture.result.ledgerAfter = writeJson(fixture.result.ledgerAfter.path, ledger);
    fixture.result.casReceipt = writeJson(fixture.result.casReceipt.path, {
      expectedRecordSha256: fixture.packet.recordSha256, recordSha256: canonicalJsonSha256(ledger),
    });
    const verified = verifyPipelineExecution(fixture.result, fixture);
    assert.equal(verified.verified, false, `mutation ${index}`);
    assert.ok(errors(verified).includes('ledger_after_unapproved_changes'), `mutation ${index}: ${JSON.stringify(verified.errors)}`);
  }
});

test('a policy send keeps an approved hold and cannot reset it to continue_contact', t => {
  const {root} = tempRoot(t);
  const fixture = createSyntheticPipelineReceiptFixture(root, {proposalKind: 'policy'});
  fixture.proposal.nextRecord.state = fixture.afterRecord.state = 'needs_more_info';
  fixture.proposal.nextRecord.recommendation = fixture.afterRecord.recommendation = 'hold';
  fixture.proposal.nextRecord.next_round = 0;
  fixture.result.ledgerAfter = writeJson(fixture.result.ledgerAfter.path, fixture.afterRecord);
  fixture.result.casReceipt = writeJson(fixture.result.casReceipt.path, {
    expectedRecordSha256: fixture.packet.recordSha256, recordSha256: canonicalJsonSha256(fixture.afterRecord),
  });
  const valid = verifyPipelineExecution(fixture.result, fixture);
  assert.equal(valid.verified, true, JSON.stringify(valid.errors));
  fixture.afterRecord.state = 'awaiting_candidate_reply';
  fixture.afterRecord.recommendation = 'continue_contact';
  fixture.result.ledgerAfter = writeJson(fixture.result.ledgerAfter.path, fixture.afterRecord);
  fixture.result.casReceipt = writeJson(fixture.result.casReceipt.path, {
    expectedRecordSha256: fixture.packet.recordSha256, recordSha256: canonicalJsonSha256(fixture.afterRecord),
  });
  const invalid = verifyPipelineExecution(fixture.result, fixture);
  assert.ok(errors(invalid).includes('ledger_after_state_mismatch'));
  assert.ok(errors(invalid).includes('ledger_after_recommendation_mismatch'));
});

test('wrong job, third-party history and two new records are rejected', t => {
  const {root} = tempRoot(t);
  const wrong = createSyntheticPipelineReceiptFixture(path.join(root, 'wrong'));
  wrong.result.jobId = 'job-2';
  assert.ok(errors(verifyPipelineExecution(wrong.result, wrong)).includes('result_job_id_mismatch'));

  const third = createSyntheticPipelineReceiptFixture(path.join(root, 'third'), {
    extraBefore: [{mid: 9, time: 9, from: {uid: 777}, to: {uid: OWN_UID}, body: {text: 'third party'}}],
  });
  assert.ok(errors(verifyPipelineExecution(third.result, third)).includes('beforeHistory_participants_not_unique'));

  const two = createSyntheticPipelineReceiptFixture(path.join(root, 'two'), {twoNew: true});
  assert.ok(errors(verifyPipelineExecution(two.result, two)).includes('history_new_message_count'));
});

test('unknown result preserves both claim bytes and UID lock', t => {
  const {root} = tempRoot(t);
  const fixture = createSyntheticPipelineReceiptFixture(root);
  const before = fs.readFileSync(fixture.claim.claimFile);
  const lockBefore = fs.readFileSync(fixture.claim.uidLockFile);
  assert.equal(verifyPipelineExecution({ok: false, status: 'unknown'}, fixture).verified, false);
  assert.deepEqual(fs.readFileSync(fixture.claim.claimFile), before);
  assert.deepEqual(fs.readFileSync(fixture.claim.uidLockFile), lockBefore);
  assert.equal(verifyPipelineClaim(fixture.claim, claimIdentity(fixture)).verified, true);
});
