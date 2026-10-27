import fs from 'node:fs';
import {hash, checkApproval} from '../../../scripts/runtime.mjs';

export function buildPipelineAcceptance({packet, proposal, validation, mainReviewSource, userAuthorization}) {
  if (!validation?.valid || typeof userAuthorization !== 'string' || !userAuthorization.trim()) throw new Error('A verified proposal and current user authorization are required');
  const senderApproval = proposal.text === null ? null : {
    contractVersion: 2, jobId: packet.candidate.boss_job_id,
    recipient: {uid: packet.candidate.uid, name: packet.candidate.name}, text: proposal.text, textSha256: validation.textSha256,
    expectedHistorySha256: packet.history.sha256, approved: true,
    approval: {userMessage: userAuthorization, approvedTextSha256: validation.textSha256, recipientCount: 1},
  };
  if (senderApproval) checkApproval(senderApproval);
  return {schemaVersion: 1, approved: true, candidate: {...packet.candidate}, bindingSha256: validation.bindingSha256,
    proposalSha256: validation.proposalSha256, textSha256: validation.textSha256,
    recordSha256: packet.recordSha256, historySha256: packet.history.sha256, jobProfileSha256: packet.jobProfileSha256,
    mainReviewSource, senderApproval};
}
export function verifyPipelineAcceptance(approval, {packet, proposal, validation}) {
  try {
    if (approval?.schemaVersion !== 1 || approval.approved !== true || approval.bindingSha256 !== validation.bindingSha256 ||
        approval.proposalSha256 !== validation.proposalSha256 || approval.textSha256 !== validation.textSha256 ||
        approval.recordSha256 !== packet.recordSha256 || approval.historySha256 !== packet.history.sha256 ||
        approval.jobProfileSha256 !== packet.jobProfileSha256 || approval.candidate?.uid !== packet.candidate.uid ||
        approval.candidate?.name !== packet.candidate.name || approval.candidate?.boss_job_id !== packet.candidate.boss_job_id) return false;
    if (hash(fs.readFileSync(approval.mainReviewSource.path)) !== approval.mainReviewSource.sha256) return false;
    if (proposal.text === null) return approval.senderApproval === null;
    checkApproval(approval.senderApproval);
    return approval.senderApproval.contractVersion === 2 && approval.senderApproval.jobId === packet.candidate.boss_job_id &&
      approval.senderApproval.recipient.uid === packet.candidate.uid && approval.senderApproval.recipient.name === packet.candidate.name &&
      approval.senderApproval.text === proposal.text && approval.senderApproval.textSha256 === validation.textSha256 &&
      approval.senderApproval.expectedHistorySha256 === packet.history.sha256;
  } catch { return false; }
}
export function senderArguments(approval, {approvalFile, attemptFile, outputFile, page}) {
  checkApproval(approval.senderApproval);
  if (approval.senderApproval.contractVersion !== 2 || !approval.senderApproval.jobId ||
      approval.candidate.boss_job_id !== approval.senderApproval.jobId || !Number.isInteger(page) || page < 1 || page > 100) throw new Error('A job-bound v2 approval and fresh contact page are required');
  return ['send', '--approval', approvalFile, '--attempt', attemptFile, '--output', outputFile, '--job-id', approval.senderApproval.jobId, '--page', String(page)];
}
