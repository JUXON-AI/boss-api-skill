import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash, checkApproval} from '../../../scripts/runtime.mjs';
import {buildPipelineAcceptance, verifyPipelineAcceptance, senderArguments} from './pipeline_approval.mjs';

test('main acceptance binds proposal, actual source, record and exact job and produces a compatible sender approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-main-approval-'));
  try {
    const source = path.join(root, 'main-review.json'); fs.writeFileSync(source, '{"reviewedBy":"main","fixture":true}');
    const packet = {candidate: {uid: 42, name: '合成对象', boss_job_id: 'job-a'}, recordSha256: 'a'.repeat(64), jobProfileSha256: 'b'.repeat(64), history: {sha256: 'c'.repeat(64)}};
    const proposal = {text: '你提到可以连续实习半年，学校这边允许外出实习吗？'};
    const validation = {valid: true, bindingSha256: 'd'.repeat(64), proposalSha256: 'e'.repeat(64), textSha256: hash(proposal.text)};
    const approval = buildPipelineAcceptance({packet, proposal, validation, mainReviewSource: {path: source, sha256: hash(fs.readFileSync(source))}, userAuthorization: '合成单人测试授权'});
    assert.equal(verifyPipelineAcceptance(approval, {packet, proposal, validation}), true);
    checkApproval(approval.senderApproval);
    assert.equal(approval.senderApproval.contractVersion, 2);
    const args = senderArguments(approval, {approvalFile: 'send-approval.json', attemptFile: 'attempt.json', outputFile: 'result.json', page: 1});
    assert.equal(args[args.indexOf('--job-id') + 1], 'job-a');
    assert.equal(verifyPipelineAcceptance({...approval, candidate: {...packet.candidate, boss_job_id: 'job-b'}}, {packet, proposal, validation}), false);
    assert.equal(verifyPipelineAcceptance({...approval, textSha256: '0'.repeat(64)}, {packet, proposal, validation}), false);
    fs.writeFileSync(source, '{"changed":true}');
    assert.equal(verifyPipelineAcceptance(approval, {packet, proposal, validation}), false);
    assert.throws(() => checkApproval({...approval.senderApproval, jobId: undefined}), /job ID/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
