import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {SCORING_POLICY_VERSION} from '../../../../scripts/scoring.mjs';
import {hash, historyFingerprint} from '../../../../scripts/runtime.mjs';
import {claimPipelineTask} from '../pipeline_receipts.mjs';
import {canonicalJsonSha256} from '../candidate_ledger.mjs';

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
function messages(extra = []) {
  return [
    {mid: 1, time: 1, from: {uid: UID}, to: {uid: OWN_UID}, securityId: 'rotate-before', body: {text: 'Candidate answer'}},
    ...extra,
  ];
}
function record({kind = 'send', round = 0, history, extraMessages = []} = {}) {
  const beforeMessages = messages(extraMessages), historySha = historyFingerprint(beforeMessages);
  const base = {
    schema_version: 1,
    policy_version: SCORING_POLICY_VERSION,
    job: {boss_job_id: JOB_ID, job_profile_sha256: JOB_PROFILE_SHA},
    candidate: {uid: UID, name: 'Candidate A'},
    history: {
      sha256: historySha,
      complete: true,
      checked_at: '2026-10-27T01:00:00.000Z',
      last_mid: beforeMessages.at(-1).mid,
      last_direction: 'in',
    },
    job_fit: {score: 85, hard_condition_status: 'pass'},
    score: {
      dimensions: {core_role_skills: 80, project_depth: 80, engineering_habits: 80, learning_and_collaboration: 80},
      ability_base_score: 80, evidence_coverage_percent: 100, competitions: [], github_projects: [],
      competition_bonus: 0, github_bonus: 0, proof_bonus: 0, final_signal_score: 80,
      evaluation_sha256: 'c'.repeat(64),
    },
    state: kind === 'hold' ? 'needs_more_info' : 'ready_for_contact',
    facts: {confirmed: ['Identity matched'], unverified: [], unknown: []},
    communication: {
      round,
      last_outbound_mid: null,
      last_outbound_at: null,
      pending_inbound_mids: beforeMessages.map(message => message.mid),
    },
    recommendation: kind === 'hold' ? 'hold' : 'continue_contact',
    next_round: kind === 'hold' ? 0 : round + 1,
    next_action: kind === 'hold' ? 'Keep the task on local hold' : 'Send the reviewed first-round message',
    sources: ['synthetic-fixture'],
    updated_at: '2026-10-27T01:01:00.000Z',
  };
  return base;
}
function sentRecord(current, afterMessages, kind = 'substantive_round1') {
  return {
    ...current,
    history: {
      ...current.history,
      sha256: historyFingerprint(afterMessages),
      checked_at: '2026-10-27T01:02:00.000Z',
      last_mid: afterMessages.at(-1).mid,
      last_direction: 'out',
    },
    state: kind === 'hr_handoff' ? 'hr_review' : kind === 'policy' ? current.state : 'awaiting_candidate_reply',
    communication: {
      ...current.communication,
      round: current.communication.round + (kind === 'substantive_round1' || kind === 'substantive_round2' ? 1 : 0),
      last_outbound_mid: afterMessages.at(-1).mid,
      last_outbound_at: '2026-10-27T01:02:00.000Z',
      pending_inbound_mids: [],
    },
    recommendation: kind === 'hr_handoff' ? 'ready_for_hr' : kind === 'policy' ? current.recommendation : 'continue_contact',
    next_round: 0,
    next_action: kind === 'hr_handoff' ? 'Wait for HR review' : 'Wait for the candidate reply',
    updated_at: '2026-10-27T01:02:00.000Z',
  };
}
function historyFile(file, messagesValue, format = 'normalized') {
  return writeJson(file, format === 'raw'
    ? {code: 0, zpData: {hasMore: false, messages: messagesValue}}
    : {complete: true, messages: messagesValue});
}

/** Pure temporary-file fixture for production happy-path integration tests. */
export function createSyntheticPipelineReceiptFixture(root, options = {}) {
  const kind = options.kind ?? 'boss_text_send';
  const proposalKind = options.kind === 'local_hold' ? 'hold' : (options.proposalKind ?? 'substantive_round1');
  const extraBefore = options.extraBefore ?? [];
  const beforeMessages = messages(extraBefore);
  const afterMessages = options.twoNew
    ? [
      ...beforeMessages,
      {mid: 2, time: 2, from: {uid: OWN_UID}, to: {uid: UID}, body: {text: options.text ?? 'Approved text'}},
      {mid: 3, time: 3, from: {uid: OWN_UID}, to: {uid: UID}, body: {text: options.text ?? 'Approved text'}},
    ]
    : [...beforeMessages, {mid: 2, time: 2, from: {uid: OWN_UID}, to: {uid: UID}, body: {text: options.text ?? 'Approved text'}}];
  const current = record({kind: proposalKind === 'hold' ? 'hold' : 'send', extraMessages: extraBefore});
  const nextRecord = proposalKind === 'hold' ? record({kind: 'hold', extraMessages: extraBefore}) : structuredClone(current);
  const ledger = kind === 'local_hold' ? structuredClone(nextRecord) : sentRecord(current, afterMessages, proposalKind);
  const historySha = historyFingerprint(beforeMessages);
  const text = kind === 'local_hold' ? null : (options.text ?? 'Approved text');
  const packet = {
    candidate: {uid: UID, name: 'Candidate A', boss_job_id: JOB_ID},
    currentRecord: current,
    recordSha256: canonicalJsonSha256(current),
    jobProfileSha256: JOB_PROFILE_SHA,
    history: {complete: true, messages: beforeMessages, sha256: historySha},
    safety: {blocked: false, humanConversationHold: kind === 'local_hold', alreadyHandled: false, baseReadbackVerified: false, bossHandoffSent: false},
  };
  const proposal = {
    candidate: {uid: UID, name: 'Candidate A', boss_job_id: JOB_ID},
    expectedRecordSha256: canonicalJsonSha256(current),
    jobProfileSha256: JOB_PROFILE_SHA,
    expectedHistorySha256: historySha,
    kind: proposalKind,
    text,
    nextRecord,
    citations: [],
  };
  const claim = claimPipelineTask(root, {
    taskId: 'task-1', jobId: JOB_ID, uid: UID, sourceFingerprint: historySha,
    recordSha256: packet.recordSha256, bindingSha256: BINDING,
  });
  const before = historyFile(path.join(root, 'before.json'), beforeMessages, 'normalized');
  const after = historyFile(path.join(root, 'after.json'), kind === 'local_hold' ? beforeMessages : afterMessages, options.afterFormat ?? 'raw');
  const ledgerAfter = writeJson(path.join(root, 'ledger-after.json'), ledger);
  const expectedRecordSha256 = options.casProposal ? canonicalJsonSha256(nextRecord) : packet.recordSha256;
  const casReceipt = writeJson(path.join(root, 'cas.json'), {expectedRecordSha256, recordSha256: canonicalJsonSha256(ledger)});
  const result = {ok: true, kind, jobId: JOB_ID, uid: UID, claimId: claim.claimId, beforeHistory: before, afterHistory: after, ledgerAfter, casReceipt};
  if (kind === 'boss_text_send') {
    result.senderResult = writeJson(path.join(root, 'sender.json'), {
      at: '2026-10-27T01:02:00.000Z', recipient: {uid: UID, name: 'Candidate A'}, attempts: 1,
      textSha256: hash(text), sdkInvoked: true, historyConfirmed: true, messageMid: 2, matchingNewRecords: 1,
      deliveryConfirmed: false, readConfirmed: false,
    });
  }
  return {packet, proposal, claim, result, currentRecord: current, afterRecord: ledger, beforeMessages, afterMessages};
}
