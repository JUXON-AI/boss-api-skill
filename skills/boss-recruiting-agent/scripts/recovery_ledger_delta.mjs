import crypto from 'node:crypto';
import {ABILITY_DIMENSION_WEIGHTS} from '../../../scripts/scoring.mjs';
import {canonicalJsonSha256, validateCandidateRecord} from './candidate_ledger.mjs';

const ALLOWED_AFTER_STATES = new Set([
  'needs_more_info',
  'awaiting_candidate_reply',
  'skipped_unknown_base',
]);
const DIMENSION_KEYS = Object.freeze(Object.keys(ABILITY_DIMENSION_WEIGHTS));

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMid(value) {
  return Number.isSafeInteger(value) || (typeof value === 'string' && value.length > 0);
}

function midKey(value) {
  return String(value);
}

function sameCanonical(left, right) {
  return canonicalJsonSha256({value: left}) === canonicalJsonSha256({value: right});
}

function textSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireReceipt(receipt, record, label) {
  if (!isObject(receipt) || receipt.ok !== true) fail(`${label}.ok must be true`);
  if (receipt.recordSha256 !== canonicalJsonSha256(record)) {
    fail(`${label}.recordSha256 does not match the canonical record hash`);
  }
}

function validatedRecord(record, label) {
  try {
    return validateCandidateRecord(record).record;
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
}

function matchingWhitelistEntry(allowedCandidates, record, jobId) {
  if (!Array.isArray(allowedCandidates)) fail('allowedCandidates must be an array');
  const matches = allowedCandidates.filter(candidate => (
    isObject(candidate)
    && candidate.uid === record.candidate.uid
    && candidate.name === record.candidate.name
    && candidate.jobId === jobId
  ));
  if (matches.length !== 1) fail('candidate is not an exact member of the authorized whitelist');
  const [entry] = matches;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 3 || keys[0] !== 'jobId' || keys[1] !== 'name' || keys[2] !== 'uid') {
    fail('allowedCandidates entries must contain exactly uid, name, and jobId');
  }
  return entry;
}

function assertIdentity(beforeRecord, afterRecord, preRecord, jobId, uid) {
  const check = (record, label) => {
    if (record.candidate.uid !== uid) fail(`${label} candidate UID changed`);
    if (record.candidate.name !== beforeRecord.candidate.name) fail(`${label} candidate name changed`);
    if (record.job.boss_job_id !== beforeRecord.job.boss_job_id) fail(`${label} job changed`);
    if (record.job.job_profile_sha256 !== beforeRecord.job.job_profile_sha256) fail(`${label} job profile hash changed`);
  };
  if (jobId !== beforeRecord.job.boss_job_id) fail('jobId does not match the candidate records');
  check(beforeRecord, 'beforeRecord');
  check(afterRecord, 'afterRecord');
  if (preRecord) check(preRecord, 'preRecord');
}

function assertDimensionShape(dimensions, label) {
  if (!isObject(dimensions)) fail(`${label} must be an object`);
  const keys = Object.keys(dimensions).sort();
  const expected = [...DIMENSION_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly the scored dimensions`);
  }
}

function validateScoreDelta({beforeRecord, afterRecord, review, historyMessages, newTextMids, uid, documentEvidence = []}) {
  assertDimensionShape(beforeRecord.score.dimensions, 'beforeRecord.score.dimensions');
  assertDimensionShape(afterRecord.score.dimensions, 'afterRecord.score.dimensions');

  const beforeDimensions = beforeRecord.score.dimensions;
  const afterDimensions = afterRecord.score.dimensions;
  const changedDimensions = DIMENSION_KEYS.filter(key => beforeDimensions[key] !== afterDimensions[key]);
  const scoreChanged = changedDimensions.length > 0;

  if (!sameCanonical(beforeRecord.score.competitions, afterRecord.score.competitions)) {
    fail('score.competitions cannot change during recovery');
  }
  if (!sameCanonical(beforeRecord.score.github_projects, afterRecord.score.github_projects)) {
    fail('score.github_projects cannot change during recovery');
  }

  if (!scoreChanged) {
    if (!sameCanonical(beforeRecord.score, afterRecord.score)) {
      fail('score fields cannot change when no dimension changes');
    }
    return {scoreChanged: false, changedDimensions};
  }

  if (!isObject(review) || !sameCanonical(review.dimensions, afterDimensions)) {
    fail('review.dimensions must exactly equal afterRecord.score.dimensions when dimensions change');
  }
  if (!Array.isArray(review.dimensionEvidence)) fail('review.dimensionEvidence must be an array');
  if (!Array.isArray(historyMessages)) fail('historyMessages must be an array');
  if (!Array.isArray(newTextMids) || newTextMids.length === 0 || newTextMids.some(mid => !isMid(mid))) {
    fail('newTextMids must be a non-empty array of message ids');
  }

  const byMid = new Map();
  for (const message of historyMessages) {
    if (!isObject(message) || !isMid(message.mid)) fail('historyMessages contains a message without a valid mid');
    const key = midKey(message.mid);
    if (byMid.has(key)) fail('historyMessages contains duplicate mids');
    byMid.set(key, message);
  }
  const newMids = new Set(newTextMids.map(midKey));
  const coveredDimensions = new Set();
  let newEvidenceCount = 0;

  for (const evidence of review.dimensionEvidence) {
    if (!isObject(evidence)) fail('review.dimensionEvidence entries must be objects');
    if (!DIMENSION_KEYS.includes(evidence.dimension)) fail('dimension evidence names an unknown dimension');
    if (!(evidence.dimension in afterDimensions) || evidence.score !== afterDimensions[evidence.dimension]) {
      fail('dimension evidence score must exactly match the reviewed score');
    }
    if (evidence.sourceType === 'document') {
      const document = documentEvidence.find(d => d.uid === uid && d.name === beforeRecord.candidate.name && d.jobId === beforeRecord.job.boss_job_id && d.textSource === evidence.sourcePath && d.textSha256 === evidence.sourceSha256);
      if (!document || typeof document.text !== 'string' || textSha256(document.text) !== document.textSha256 || !/^[a-f0-9]{64}$/.test(document.fileSha256 ?? '') || document.accepted !== true || typeof evidence.quote !== 'string' || !evidence.quote || !document.text.includes(evidence.quote)) fail('document evidence must bind exact candidate, accepted PDF digest and exact UTF-8 text quote');
      coveredDimensions.add(evidence.dimension);
      if (document.newlyReceived === true) newEvidenceCount += 1;
      continue;
    }
    if (!isMid(evidence.mid) || typeof evidence.quote !== 'string' || evidence.quote.length === 0) {
      fail('dimension evidence requires a valid mid and non-empty quote');
    }
    const message = byMid.get(midKey(evidence.mid));
    if (!message || message.from?.uid !== uid || typeof message.body?.text !== 'string' || !message.body.text.includes(evidence.quote)) {
      fail('dimension evidence must quote the exact body.text of a candidate message for the same UID');
    }
    coveredDimensions.add(evidence.dimension);
    if (newMids.has(midKey(evidence.mid))) newEvidenceCount += 1;
  }

  for (const dimension of DIMENSION_KEYS) {
    if (afterDimensions[dimension] !== null && !coveredDimensions.has(dimension)) {
      fail(`non-null dimension ${dimension} lacks candidate evidence`);
    }
  }
  if (newEvidenceCount === 0) fail('score changes require at least one quote from newTextMids');
  return {scoreChanged: true, changedDimensions};
}

function validateNoSendPath({beforeRecord, afterRecord}) {
  if (afterRecord.communication.round !== beforeRecord.communication.round) {
    fail('communication.round cannot change without send evidence');
  }
  if (afterRecord.next_round !== 0) fail('afterRecord.next_round must be 0 without send evidence');
  if (!['hold', 'skip'].includes(afterRecord.recommendation)) {
    fail('a no-send recovery must recommend hold or skip');
  }
}

function assertRecipient(recipient, uid, name, label) {
  if (!isObject(recipient) || recipient.uid !== uid || recipient.name !== name) {
    fail(`${label} recipient must exactly match the candidate UID and name`);
  }
}

function messageMidSet(messages, label) {
  if (!Array.isArray(messages)) fail(`${label} must be an array`);
  const ids = new Set();
  for (const message of messages) {
    if (!isObject(message) || !isMid(message.mid)) fail(`${label} contains a message without a valid mid`);
    const key = midKey(message.mid);
    if (ids.has(key)) fail(`${label} contains duplicate mids`);
    ids.add(key);
  }
  return ids;
}

function validateSendPath({beforeRecord, afterRecord, sendEvidence, recruiterUid}) {
  if (!isObject(sendEvidence)) fail('sendEvidence must be an object');
  const {approval, attempt, result, beforeMessages, afterMessages, preRecord, preReceipt} = sendEvidence;
  const uid = afterRecord.candidate.uid;
  const name = afterRecord.candidate.name;

  const validatedPre = validatedRecord(preRecord, 'sendEvidence.preRecord');
  requireReceipt(preReceipt, validatedPre, 'sendEvidence.preReceipt');
  assertIdentity(beforeRecord, afterRecord, validatedPre, beforeRecord.job.boss_job_id, uid);
  if (!sameCanonical(validatedPre.score, afterRecord.score)) {
    fail('sendEvidence.preRecord.score must exactly equal afterRecord.score');
  }
  if (validatedPre.communication.round !== beforeRecord.communication.round) {
    fail('sendEvidence.preRecord cannot reset communication.round');
  }

  const plannedRound = validatedPre.next_round;
  if (!Number.isInteger(plannedRound) || plannedRound < 1 || plannedRound > 2) {
    fail('sendEvidence.preRecord.next_round must plan round 1 or 2');
  }
  if (beforeRecord.communication.round + 1 !== plannedRound) {
    fail('communication.round must advance exactly one step to the planned round');
  }
  if (afterRecord.communication.round !== plannedRound || afterRecord.communication.round > 2) {
    fail('afterRecord.communication.round must equal the planned round and be at most 2');
  }
  if (plannedRound === 1) {
    if (beforeRecord.communication.round !== 0) fail('round 1 requires a true round 0 baseline');
    if (!(afterRecord.score.ability_base_score > 0) || !(afterRecord.score.evidence_coverage_percent > 0)) {
      fail('round 1 requires a numeric ability base and evidence coverage greater than zero');
    }
  } else {
    if (beforeRecord.communication.round !== 1) fail('round 2 requires a true round 1 baseline');
    const thresholds = afterRecord.screening_policy?.thresholds ?? {ability_base: 60, coverage: 70, signal: 65};
    if (!(afterRecord.score.ability_base_score >= thresholds.ability_base)) fail(`round 2 requires ability_base_score at least ${thresholds.ability_base}`);
    if (!(afterRecord.score.evidence_coverage_percent >= thresholds.coverage)) fail(`round 2 requires evidence coverage at least ${thresholds.coverage}`);
    if (!(afterRecord.score.final_signal_score >= thresholds.signal)) fail(`round 2 requires final signal score at least ${thresholds.signal}`);
  }

  if (!isObject(approval)) fail('sendEvidence.approval must be an object');
  assertRecipient(approval.recipient, uid, name, 'approval');
  if (typeof approval.text !== 'string' || approval.text.trim() === '') fail('approval.text must be non-empty');
  const approvedTextSha256 = textSha256(approval.text);
  if (approval.textSha256 !== approvedTextSha256) fail('approval.textSha256 must equal the actual UTF-8 body digest');
  if (approval.approved !== true || !isObject(approval.approval) || approval.approval.recipientCount !== 1) {
    fail('approval must authorize exactly one recipient');
  }
  if (approval.approval.approvedTextSha256 !== approvedTextSha256) {
    fail('approval.approval.approvedTextSha256 must equal the actual UTF-8 body digest');
  }

  if (!isObject(attempt) || attempt.attempts !== 1) fail('attempt.attempts must be exactly 1');
  assertRecipient(attempt.recipient, uid, name, 'attempt');
  if (attempt.textSha256 !== approvedTextSha256) fail('attempt body digest does not match approval.text');

  if (!isObject(result)) fail('sendEvidence.result must be an object');
  if (result.attempts !== 1 || result.sdkInvoked !== true || result.historyConfirmed !== true || result.matchingNewRecords !== 1) {
    fail('result must prove one SDK invocation and exactly one confirmed new history record');
  }
  assertRecipient(result.recipient, uid, name, 'result');
  if (result.textSha256 !== approvedTextSha256) fail('result body digest does not match approval.text');
  if (!isMid(result.messageMid)) fail('result.messageMid must identify the new outbound message');

  const beforeMids = messageMidSet(beforeMessages, 'sendEvidence.beforeMessages');
  messageMidSet(afterMessages, 'sendEvidence.afterMessages');
  if (!Number.isSafeInteger(recruiterUid) || recruiterUid === uid) fail('exact recruiterUid is required for sends');
  for (const message of [...beforeMessages, ...afterMessages]) {
    if (!((message.from?.uid === uid && message.to?.uid === recruiterUid) || (message.from?.uid === recruiterUid && message.to?.uid === uid))) fail('history contains a third-party participant');
  }
  if (beforeMessages.some(message => message.body?.text === approval.text)) {
    fail('the approved outbound text already exists in beforeMessages');
  }
  const newMessages = afterMessages.filter(message => !beforeMids.has(midKey(message.mid)));
  const newOutbound = newMessages.filter(message => message.from?.uid === recruiterUid);
  const matching = newOutbound.filter(message => (
    message.to?.uid === uid
    && message.body?.text === approval.text
  ));
  if (matching.length !== 1) fail('send history must contain exactly one new matching outbound record');
  const matchingMid = midKey(matching[0].mid);
  if (newOutbound.length !== 1) fail('send history must contain no other new outbound records');
  if (midKey(result.messageMid) !== matchingMid) {
    fail('result.messageMid must equal the unique new matching outbound mid');
  }
  if (midKey(afterRecord.communication.last_outbound_mid) !== matchingMid) {
    fail('afterRecord.communication.last_outbound_mid must equal result.messageMid');
  }

  if (afterRecord.state !== 'awaiting_candidate_reply') {
    fail('a confirmed send must leave state awaiting_candidate_reply');
  }
  if (afterRecord.next_round !== 0) fail('a confirmed send must set next_round to 0');
  if (afterRecord.recommendation !== 'continue_contact') {
    fail('a confirmed send must recommend continue_contact');
  }
}

export function verifyRecoveryDelta(input) {
  if (!isObject(input)) fail('recovery delta input must be an object');
  const {
    jobId,
    allowedCandidates,
    beforeRecord,
    afterRecord,
    review,
    historyMessages,
    newTextMids,
    receipt,
    sendEvidence = null,
    recruiterUid,
    documentEvidence = [],
  } = input;

  const before = validatedRecord(beforeRecord, 'beforeRecord');
  const after = validatedRecord(afterRecord, 'afterRecord');
  if (!sameCanonical(before.screening_policy ?? null, after.screening_policy ?? null)) fail('recovery delta cannot migrate the job screening policy');
  const uid = before.candidate.uid;

  matchingWhitelistEntry(allowedCandidates, before, jobId);
  assertIdentity(before, after, null, jobId, uid);
  requireReceipt(receipt, after, 'receipt');
  if (!ALLOWED_AFTER_STATES.has(after.state)) {
    fail('afterRecord.state is not permitted for recovery deltas');
  }
  if (after.communication.round > 2) fail('communication.round cannot exceed 2');

  const {scoreChanged} = validateScoreDelta({
    beforeRecord: before,
    afterRecord: after,
    review,
    historyMessages,
    newTextMids,
    uid,
    documentEvidence,
  });

  if (sendEvidence === null) {
    validateNoSendPath({beforeRecord: before, afterRecord: after});
    return {accepted: true, uid, scoreChanged, sdkCalls: 0};
  }

  validateSendPath({beforeRecord: before, afterRecord: after, sendEvidence, recruiterUid});
  return {accepted: true, uid, scoreChanged, sdkCalls: 1};
}

