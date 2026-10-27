import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {validateProposal} from './proposal_validation.mjs';
import {runReviewPipeline} from './review_pipeline.mjs';
import {buildPipelineAcceptance} from './pipeline_approval.mjs';
import {claimPipelineTask} from './pipeline_receipts.mjs';
import {createSyntheticPipelineReceiptFixture} from './test-helpers/pipeline-fixture.mjs';

function file(file, value) {fs.writeFileSync(file, JSON.stringify(value)); return {path: file, sha256: hash(fs.readFileSync(file))};}
function prepare(root) {
  const f = createSyntheticPipelineReceiptFixture(path.join(root, 'receipts'));
  const jobProfile = {boss_job_id: f.packet.candidate.boss_job_id, message_policy: {max_substantive_rounds: 2}};
  const jobSha = canonicalJsonSha256(jobProfile);
  f.currentRecord.job.job_profile_sha256 = jobSha;
  f.proposal.nextRecord.job.job_profile_sha256 = jobSha;
  f.packet.recordSha256 = canonicalJsonSha256(f.currentRecord);
  f.packet.jobProfileSha256 = jobSha;
  f.proposal.expectedRecordSha256 = f.packet.recordSha256;
  f.proposal.jobProfileSha256 = jobSha;
  f.packet.reviewPolicy = {newTechnologyAppeared: false};
  f.afterRecord.job.job_profile_sha256 = jobSha;
  f.result.ledgerAfter = file(f.result.ledgerAfter.path, f.afterRecord);
  f.result.casReceipt = file(f.result.casReceipt.path, {expectedRecordSha256: f.packet.recordSha256, recordSha256: canonicalJsonSha256(f.afterRecord)});
  const mainSource = file(path.join(root, 'main-review.json'), {reviewedBy: 'main', synthetic: true});
  const task = {taskId: 'production-contract-fixture', packet: f.packet, currentRecord: f.currentRecord, jobProfile,
    sourceFingerprint: hash(f.packet.history.sha256 + jobSha)};
  return {f, mainSource, task};
}
for (const validProof of [true, false]) test(`production pipeline ${validProof ? 'verifies real fixture files and completes' : 'rejects a naked verified status and keeps the claim'}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-production-contract-'));
  try {
    const {f, task, mainSource} = prepare(root);
    let claim;
    const result = await runReviewPipeline({tasks: [task],
      review: async () => f.proposal,
      validate: args => validateProposal({...args, jobProfileHashMode: 'canonical'}),
      accept: ({packet, proposal, validation}) => buildPipelineAcceptance({packet, proposal, validation, mainReviewSource: mainSource, userAuthorization: '合成授权；不运行服务'}),
      claim: context => {claim = claimPipelineTask(path.join(root, 'actual-claims'), {
        taskId: context.taskId, jobId: context.bossJobId, uid: context.uid, sourceFingerprint: context.sourceFingerprint,
        recordSha256: context.packet.recordSha256, bindingSha256: context.validation.bindingSha256}); return claim;},
      execute: context => validProof ? {...f.result, claimId: context.claim.claimId} : {ok: true, status: 'verified'},
    });
    if (validProof) {
      assert.equal(result.executedCount, 1, JSON.stringify(result.results));
      assert.equal(fs.existsSync(claim.uidLockFile), false);
    } else {
      assert.equal(result.executedCount, 0, JSON.stringify(result.results));
      assert.equal(result.results[0].status, 'execution_evidence_rejected');
      assert.equal(fs.existsSync(claim.uidLockFile), true);
    }
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
