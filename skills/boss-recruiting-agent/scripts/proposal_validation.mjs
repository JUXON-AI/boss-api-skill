import {hash} from '../../../scripts/runtime.mjs';
import {historyFingerprint} from '../../../scripts/runtime.mjs';
import {projectHistory} from '../../../scripts/batch.mjs';
import {canonicalJsonSha256, validateCandidateRecord} from './candidate_ledger.mjs';

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const KINDS = new Set(['substantive_round1', 'substantive_round2', 'policy', 'hr_handoff', 'hold']);
const TERMINAL_STATES = new Set(['stop_contact', 'current_role_mismatch', 'skipped_unknown_base', 'closed']);
const SAFETY_FIELDS = ['blocked', 'humanConversationHold', 'alreadyHandled', 'baseReadbackVerified', 'bossHandoffSent'];

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isOrdinaryText(message) {
  return isObject(message?.body) && (!Object.hasOwn(message.body, 'type') || message.body.type === 1)
    && typeof message.body.text === 'string' && !!message.body.text.trim();
}
function isHex(value) { return typeof value === 'string' && HEX_SHA256.test(value); }
function validMid(value) { return Number.isSafeInteger(value) || (typeof value === 'string' && value.length > 0); }
function numericMid(value) {
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  return null;
}
function midKey(value) {
  const numeric = numericMid(value);
  return numeric === null ? `string:${String(value)}` : `numeric:${numeric.toString()}`;
}
function numericTime(value) {
  if (Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  return null;
}
function compareTimeAndMid(left, right) {
  const leftTime = numericTime(left?.time);
  const rightTime = numericTime(right?.time);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  if (leftTime !== null && rightTime === null) return 1;
  if (leftTime === null && rightTime !== null) return -1;
  const leftMid = numericMid(left?.mid);
  const rightMid = numericMid(right?.mid);
  if (leftMid !== null && rightMid !== null && leftMid !== rightMid) return leftMid < rightMid ? -1 : 1;
  return String(left?.mid).localeCompare(String(right?.mid));
}
function safeHash(value) {
  try { return canonicalJsonSha256(value); } catch { return null; }
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function codePointLength(value) { return Array.from(value).length; }

function addError(errors, code, message) { errors.push({code, message}); }
function addWarning(warnings, code, message) { warnings.push({code, message}); }

function candidateFrom(record) {
  if (!isObject(record?.candidate)) return null;
  return {
    uid: record.candidate.uid,
    name: record.candidate.name,
    boss_job_id: record?.job?.boss_job_id,
  };
}

function sameCandidate(left, right) {
  return isObject(left) && isObject(right)
    && left.uid === right.uid
    && left.name === right.name
    && left.boss_job_id === right.boss_job_id;
}

function jobProfileBody(jobProfile) {
  return isObject(jobProfile?.job) ? jobProfile.job : jobProfile;
}

function latestMessage(messages, candidateUid) {
  let latest = null;
  for (const message of messages) {
    if (!validMid(message?.mid)) continue;
    if (latest === null || compareTimeAndMid(message, latest) > 0) latest = message;
  }
  if (latest === null) return {mid: null, direction: 'none'};
  return {
    mid: latest.mid,
    direction: latest?.from?.uid === candidateUid ? 'in' : 'out',
  };
}

function validateCitations({citations, messages, candidateUid, errors, warnings}) {
  if (!Array.isArray(citations)) {
    addError(errors, 'citations_invalid', 'proposal.citations must be an array');
    return;
  }
  const byMid = new Map();
  for (const message of messages) {
    if (validMid(message?.mid)) byMid.set(midKey(message.mid), message);
  }
  const seen = new Set();
  citations.forEach((citation, index) => {
    if (!isObject(citation) || !validMid(citation.mid) || typeof citation.quote !== 'string' || !citation.quote) {
      addError(errors, 'citation_invalid', `proposal.citations[${index}] must contain an exact mid and nonempty quote`);
      return;
    }
    const citationKey = `${midKey(citation.mid)}\u0000${citation.quote}`;
    if (seen.has(citationKey)) {
addWarning(warnings, 'duplicate_citation', `proposal.citations[${index}] repeats the same citation`);
      return;
    }
    seen.add(citationKey);
    const message = byMid.get(midKey(citation.mid));
    if (!message) {
      addError(errors, 'citation_mid_missing', `proposal.citations[${index}].mid is not in the complete history`);
      return;
    }
    if (message?.from?.uid !== candidateUid) {
      addError(errors, 'citation_not_candidate', `proposal.citations[${index}] must quote the candidate's own message`);
      return;
    }
    if (typeof message?.body?.text !== 'string' || !message.body.text.includes(citation.quote)) {
      addError(errors, 'citation_quote_mismatch', `proposal.citations[${index}].quote is not an exact substring of the cited candidate message`);
    }
  });
}

function addNaturalnessWarnings(text, warnings) {
  if (typeof text !== 'string' || !text.trim()) return;
  const cliches = ['好的，了解了', '了解了', '收到，我看一下', '感谢您的回复', '没问题'];
  if (cliches.some(value => text.includes(value))) {
    addWarning(warnings, 'boilerplate_language', 'text contains wording that may read as a boilerplate acknowledgement');
  }
  if (codePointLength(text) > 280) {
    addWarning(warnings, 'text_too_long', 'text exceeds 280 Unicode code points');
  }
  const requestOrQuestionCount = (text.match(/[？?]/gu) ?? []).length
    + (text.match(/请问|请|麻烦|需要|方便/gu) ?? []).length;
  const hasAdditionalPurpose = /另外|同时|还有|以及/u.test(text);
  const sentenceCount = text.split(/[。！？!?；;\n]+/u).filter(part => part.trim()).length;
  if (requestOrQuestionCount >= 2 && hasAdditionalPurpose && sentenceCount >= 2) {
    addWarning(warnings, 'multiple_primary_purposes', 'text appears to combine more than one primary purpose');
  }
}

/**
 * Pure proposal validation. It never sends, writes, executes a service, or mutates input.
 * Optional packet.reviewPolicy.newTechnologyAppeared may be false to require score reuse.
 */
export function validateProposal({packet, proposal, currentRecord, jobProfile, jobProfileBytes, jobProfileHashMode} = {}) {
  const errors = [];
  const warnings = [];
  let bindingSha256 = null;
  let proposalSha256 = null;
  let textSha256 = null;

  try {
    proposalSha256 = safeHash(proposal ?? null);
    if (typeof proposal?.text === 'string') textSha256 = hash(proposal.text);

    const packetCandidate = isObject(packet?.candidate) ? packet.candidate : null;
    const proposalCandidate = isObject(proposal?.candidate) ? proposal.candidate : null;
    const recordCandidate = candidateFrom(currentRecord);
    const safety = isObject(packet?.safety) ? packet.safety : {};
    const messages = Array.isArray(packet?.history?.messages) ? packet.history.messages : [];
    try { projectHistory({code: 0, zpData: {messages, hasMore: false}}, packetCandidate ?? {}); }
    catch { addError(errors, 'history_participants_invalid', 'history must contain only one candidate and one verified recruiter identity'); }
    const actualRecordSha256 = safeHash(currentRecord);
    let actualJobProfileSha256 = null;
    let actualJobProfileMode = null;
    const hasJobProfileBytes = Buffer.isBuffer(jobProfileBytes) || jobProfileBytes instanceof Uint8Array;
    if (hasJobProfileBytes) {
      actualJobProfileMode = 'bytes';
      if (jobProfileHashMode !== undefined && jobProfileHashMode !== 'bytes') {
        addError(errors, 'job_profile_hash_mode_conflict', 'jobProfileBytes requires jobProfileHashMode="bytes" when a mode is supplied');
      }
      try {
        const bytes = Buffer.from(jobProfileBytes.buffer, jobProfileBytes.byteOffset, jobProfileBytes.byteLength);
        const decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        const parsed = JSON.parse(decoded);
        actualJobProfileSha256 = hash(bytes);
        if (safeHash(parsed) !== safeHash(jobProfile)) {
          addError(errors, 'job_profile_bytes_mismatch', 'jobProfileBytes JSON does not canonicalize to the supplied jobProfile');
        }
      } catch (error) {
        addError(errors, 'job_profile_bytes_invalid', `jobProfileBytes is not valid UTF-8 JSON: ${errorMessage(error)}`);
      }
    } else if (jobProfileHashMode === 'canonical') {
      actualJobProfileMode = 'canonical';
      actualJobProfileSha256 = safeHash(jobProfile);
    } else if (jobProfileHashMode === 'bytes') {
      addError(errors, 'job_profile_bytes_missing', 'jobProfileHashMode="bytes" requires jobProfileBytes');
    } else {
      addError(errors, 'job_profile_hash_mode_required', 'provide jobProfileBytes or explicitly set jobProfileHashMode="canonical"');
    }
    let actualHistorySha256 = null;
    try { actualHistorySha256 = historyFingerprint(messages); } catch { /* Reported below. */ }

    bindingSha256 = safeHash({
      candidate: packetCandidate,
      ...(packet?.documentReplies ? {documentRepliesSha256: safeHash(packet.documentReplies)} : {}),
      claimed: {
        recordSha256: packet?.recordSha256,
        jobProfileSha256: packet?.jobProfileSha256,
        historySha256: packet?.history?.sha256,
      },
      actual: {
        recordSha256: actualRecordSha256,
        jobProfileSha256: actualJobProfileSha256,
        jobProfileHashMode: actualJobProfileMode,
        historySha256: actualHistorySha256,
      },
      proposal: {
        proposalSha256,
        textSha256,
      },
      safety,
    });

    if (!isObject(packet)) addError(errors, 'packet_invalid', 'packet must be an object');
    if (!isObject(proposal)) addError(errors, 'proposal_invalid', 'proposal must be an object');
    if (!isObject(jobProfile)) addError(errors, 'job_profile_invalid', 'jobProfile must be an object');

    for (const field of SAFETY_FIELDS) {
      if (typeof safety[field] !== 'boolean') addError(errors, 'safety_flag_invalid', `packet.safety.${field} must be boolean`);
    }

    if (!packetCandidate || !proposalCandidate || !recordCandidate) {
      addError(errors, 'candidate_missing', 'packet, proposal and currentRecord must each contain candidate identity');
    } else {
      if (!Number.isSafeInteger(packetCandidate.uid) || packetCandidate.uid < 1
        || typeof packetCandidate.name !== 'string' || !packetCandidate.name.trim()
        || typeof packetCandidate.boss_job_id !== 'string' || !packetCandidate.boss_job_id) {
        addError(errors, 'candidate_invalid', 'packet.candidate identity is invalid');
      }
      if (!sameCandidate(packetCandidate, proposalCandidate)) {
        addError(errors, 'candidate_proposal_mismatch', 'proposal.candidate does not match packet.candidate');
      }
      if (!sameCandidate(packetCandidate, recordCandidate)) {
        addError(errors, 'candidate_record_mismatch', 'currentRecord identity does not match packet.candidate');
      }
    }

    const profileBody = jobProfileBody(jobProfile);
    if (isObject(profileBody) && typeof profileBody.boss_job_id === 'string'
      && packetCandidate?.boss_job_id !== profileBody.boss_job_id) {
      addError(errors, 'candidate_job_profile_mismatch', 'packet.candidate.boss_job_id does not match jobProfile.boss_job_id');
    }

    if (!isHex(packet?.recordSha256)) addError(errors, 'record_sha_invalid', 'packet.recordSha256 must be SHA-256');
    if (!isHex(packet?.jobProfileSha256)) addError(errors, 'job_profile_sha_invalid', 'packet.jobProfileSha256 must be SHA-256');
    if (!isHex(packet?.history?.sha256)) addError(errors, 'history_sha_invalid', 'packet.history.sha256 must be SHA-256');
    if (!isHex(proposal?.expectedRecordSha256)) addError(errors, 'proposal_record_sha_invalid', 'proposal.expectedRecordSha256 must be SHA-256');
    if (!isHex(proposal?.jobProfileSha256)) addError(errors, 'proposal_job_profile_sha_invalid', 'proposal.jobProfileSha256 must be SHA-256');
    if (!isHex(proposal?.expectedHistorySha256)) addError(errors, 'proposal_history_sha_invalid', 'proposal.expectedHistorySha256 must be SHA-256');

    if (actualRecordSha256 && packet?.recordSha256 !== actualRecordSha256) {
      addError(errors, 'stale_record_cas', 'packet.recordSha256 does not match the actual currentRecord');
    }
    if (actualRecordSha256 && proposal?.expectedRecordSha256 !== actualRecordSha256) {
      addError(errors, 'proposal_stale_record_cas', 'proposal.expectedRecordSha256 does not match the actual currentRecord');
    }
    if (actualJobProfileSha256 && packet?.jobProfileSha256 !== actualJobProfileSha256) {
      addError(errors, 'stale_job_profile', 'packet.jobProfileSha256 does not match the actual jobProfile');
    }
    if (actualJobProfileSha256 && proposal?.jobProfileSha256 !== actualJobProfileSha256) {
      addError(errors, 'proposal_stale_job_profile', 'proposal.jobProfileSha256 does not match the actual jobProfile');
    }
    if (actualJobProfileSha256 && currentRecord?.job?.job_profile_sha256 !== actualJobProfileSha256) {
      addError(errors, 'record_job_profile_mismatch', 'currentRecord job profile hash does not match the actual jobProfile');
    }

    if (packet?.history?.complete !== true) {
      addError(errors, 'history_incomplete', 'packet.history.complete must be true');
    }
    if (!Array.isArray(packet?.history?.messages)) {
      addError(errors, 'history_messages_invalid', 'packet.history.messages must be an array');
    }
    if (!actualHistorySha256) {
      addError(errors, 'history_fingerprint_unavailable', 'packet.history.messages could not be fingerprinted');
    } else {
      if (packet?.history?.sha256 !== actualHistorySha256) addError(errors, 'stale_packet_history', 'packet.history.sha256 does not match its messages');
      if (proposal?.expectedHistorySha256 !== actualHistorySha256) addError(errors, 'proposal_stale_history', 'proposal.expectedHistorySha256 does not match packet history');
    }

    try {
      validateCandidateRecord(currentRecord);
    } catch (error) {
      addError(errors, 'current_record_invalid', errorMessage(error));
    }

    let nextRecordValid = false;
    if (!isObject(proposal?.nextRecord)) {
      addError(errors, 'next_record_missing', 'proposal.nextRecord must be an object');
    } else {
      try {
        validateCandidateRecord(proposal.nextRecord);
        nextRecordValid = true;
      } catch (error) {
        addError(errors, 'next_record_invalid', errorMessage(error));
      }
      if (packetCandidate && !sameCandidate(packetCandidate, candidateFrom(proposal.nextRecord))) {
        addError(errors, 'next_record_identity_mismatch', 'proposal.nextRecord identity does not match packet.candidate');
      }
      if (proposal.nextRecord?.job?.job_profile_sha256 !== actualJobProfileSha256) {
        addError(errors, 'next_record_job_profile_mismatch', 'proposal.nextRecord job profile hash does not match the actual jobProfile');
      }
      if (proposal.nextRecord?.history?.sha256 !== actualHistorySha256) {
        addError(errors, 'next_record_history_mismatch', 'proposal.nextRecord history hash does not match packet history');
      }
    }

    const mids = new Set();
    for (const [index, message] of messages.entries()) {
      if (!validMid(message?.mid)) {
        addError(errors, 'history_mid_invalid', `packet.history.messages[${index}].mid is invalid`);
        continue;
      }
      const key = midKey(message.mid);
      if (mids.has(key)) addError(errors, 'history_mid_duplicate', `packet.history.messages contains duplicate mid ${String(message.mid)}`);
      mids.add(key);
    }
    if (Array.isArray(packet?.history?.messages)) {
      const latest = latestMessage(messages, packetCandidate?.uid);
      if (proposal?.nextRecord?.history?.last_mid !== latest.mid
        || proposal?.nextRecord?.history?.last_direction !== latest.direction) {
        addError(errors, 'history_tail_mismatch', 'proposal.nextRecord history tail does not match the complete packet history');
      }
    }

    validateCitations({
      citations: proposal?.citations,
      messages,
      candidateUid: packetCandidate?.uid,
      errors,
      warnings,
    });

    if (!KINDS.has(proposal?.kind)) {
      addError(errors, 'proposal_kind_invalid', 'proposal.kind is invalid');
    } else if (proposal.kind === 'hold') {
      if (proposal.text !== null) addError(errors, 'hold_text_not_null', 'hold proposals must use text:null');
    } else if (typeof proposal.text !== 'string' || !proposal.text.trim()) {
      addError(errors, 'proposal_text_required', `${proposal.kind} proposals require nonempty text`);
    } else if (proposal.text.includes('\u0000')) {
      addError(errors, 'proposal_text_control_character', 'proposal text must not contain NUL');
    }
    if (typeof proposal?.text === 'string' && proposal.text.length > 1200) addError(errors, 'proposal_text_too_long', 'Sender text limit is 1200 UTF-16 code units');

    if (safety.blocked === true) addError(errors, 'candidate_blocked', 'packet safety marks the candidate blocked');
    if (safety.alreadyHandled === true) addError(errors, 'already_handled', 'packet safety marks this work as already handled');
    if (safety.humanConversationHold === true && proposal?.kind !== 'hold') {
      addError(errors, 'human_conversation_hold', 'a human conversation hold permits only a hold proposal');
    }
    if (safety.bossHandoffSent === true && proposal?.kind === 'hr_handoff') {
      addError(errors, 'handoff_already_sent', 'BOSS handoff was already sent; do not create another hr_handoff proposal');
    }
    if (safety.bossHandoffSent === true && safety.baseReadbackVerified !== true) {
      addError(errors, 'safety_state_inconsistent', 'bossHandoffSent requires baseReadbackVerified=true');
    }

    const latestPermission = latestMessage(messages, packetCandidate?.uid);
    const permissionMessage = messages.find(message => midKey(message.mid) === midKey(latestPermission.mid));
    const firstResumePermission = currentRecord?.state === 'skipped_unknown_base' && proposal?.kind === 'policy'
      && currentRecord.communication.round === 0 && currentRecord.score.ability_base_score === null
      && proposal.text === '可以，直接在BOSS上发就行。'
      && proposal.nextRecord?.state === 'skipped_unknown_base' && proposal.nextRecord?.recommendation === 'skip'
      && proposal.nextRecord?.next_round === 0 && proposal.nextRecord?.communication?.round === 0
      && safeHash(currentRecord.score) === safeHash(proposal.nextRecord.score)
      && latestPermission.direction === 'in' && isOrdinaryText(permissionMessage)
      && /(?:可以|能|方便|可否|是否|(?<!不)需要发.{0,8}简历.{0,8}[吗嘛])/u.test(permissionMessage.body.text)
      && /(?:发.{0,8}简历|简历.{0,8}发|(?:看一下|看看).{0,8}简历|简历.{0,8}(?:看一下|看看))/u.test(permissionMessage.body.text)
      && proposal.citations?.some(citation => midKey(citation.mid) === midKey(permissionMessage.mid))
      && !messages.some(message => message.from?.uid !== packetCandidate?.uid && isOrdinaryText(message));
    if (TERMINAL_STATES.has(currentRecord?.state) && !firstResumePermission) {
      addError(errors, 'terminal_state', `candidate state ${currentRecord.state} is terminal`);
    }
    if (currentRecord?.state === 'ai_screened_pass' && ['substantive_round1', 'substantive_round2'].includes(proposal?.kind)) {
      addError(errors, 'substantive_after_pass', 'ai_screened_pass cannot continue substantive interviewing');
    }
    if (currentRecord?.state === 'hr_review' && ['substantive_round1', 'substantive_round2', 'hr_handoff'].includes(proposal?.kind)) {
      addError(errors, 'state_blocks_action', `candidate state ${currentRecord.state} blocks ${proposal.kind}`);
    }

    const currentRound = currentRecord?.communication?.round;
    const nextRound = proposal?.nextRecord?.communication?.round;
    const profilePolicy = isObject(profileBody?.message_policy) ? profileBody.message_policy : {};
    const maxSubstantiveRounds = Number.isInteger(profilePolicy.max_substantive_rounds)
      ? profilePolicy.max_substantive_rounds : 2;

    if (proposal?.kind === 'substantive_round1' || proposal?.kind === 'substantive_round2') {
      const round = proposal.kind === 'substantive_round1' ? 1 : 2;
      if (round === 2) {
        // The normal client uses body.type=1 for recruiter text. Resume receipt
        // and interview/platform cards are retained in full history, but are not
        // a substantive recruiter question or a manually sent text anchor.
        const outbounds = messages.filter(m => m.to?.uid === packetCandidate?.uid && m.from?.uid !== packetCandidate?.uid
          && isOrdinaryText(m));
        const lastOut = outbounds.reduce((last, m) => !last || compareTimeAndMid(m, last) > 0 ? m : last, null);
        if (lastOut && midKey(lastOut.mid) !== midKey(currentRecord?.communication?.last_outbound_mid)) {
          addError(errors, 'round2_outbound_anchor_stale', 'Record last_outbound_mid must equal the latest actual recruiter outbound in the complete history');
        }
        if (!lastOut || lastOut.to?.uid !== packetCandidate?.uid || lastOut.from?.uid === packetCandidate?.uid) {
          addError(errors, 'round2_last_outbound_invalid', 'The last outbound mid must identify the recruiter message to this candidate');
        }
        const replies = messages.filter(m => m.from?.uid === packetCandidate?.uid && isOrdinaryText(m)
          && lastOut && compareTimeAndMid(m, lastOut) > 0);
        // A received, identity-bound resume is also a reply. A request/card alone
        // is not: retain the accepted request, later delivery and exact body citation.
        let documentReply = false;
        for (const doc of Array.isArray(packet.documentReplies) ? packet.documentReplies : []) {
          const request = messages.find(m => midKey(m.mid) === midKey(doc?.requestMid));
          const delivery = messages.find(m => midKey(m.mid) === midKey(doc?.deliveryMid));
          const bound = isObject(doc) && typeof doc.id === 'string' && !!doc.id
            && sameCandidate(packetCandidate, doc.candidate) && doc.identityVerified === true
            && isHex(doc.fileSha256) && isHex(doc.textSha256)
            && typeof doc.text === 'string' && !!doc.text.trim() && hash(doc.text) === doc.textSha256
            && request?.from?.uid === packetCandidate?.uid && request?.to?.uid === lastOut?.from?.uid
            && request?.body?.type === 7 && request?.body?.dialog?.operated === true
            && delivery?.from?.uid === packetCandidate?.uid && delivery?.to?.uid === lastOut?.from?.uid
            && delivery?.body?.type === 12 && isObject(delivery?.body?.hyperLink)
            && lastOut && compareTimeAndMid(delivery, lastOut) > 0
            && compareTimeAndMid(delivery, request) > 0;
          const cited = bound && Array.isArray(proposal.documentCitations)
            && proposal.documentCitations.some(c => c?.documentId === doc.id
              && c.fileSha256 === doc.fileSha256 && c.textSha256 === doc.textSha256
              && typeof c.quote === 'string' && !!c.quote.trim() && doc.text.includes(c.quote));
          if (!bound || !cited) addError(errors, 'round2_document_reply_invalid', 'Resume reply requires matched identity, accepted request, later delivery, body hash and exact document citation');
          else documentReply = true;
        }
        if (!replies.length && !documentReply) addError(errors, 'round2_requires_candidate_reply', 'Round two requires candidate text or a verified received resume after the last actual outbound');
        if (!documentReply && (!Array.isArray(proposal.citations) || !proposal.citations.some(c => replies.some(m => String(m.mid) === String(c.mid))))) {
          addError(errors, 'round2_requires_reply_citation', 'Round two must quote at least one actual candidate reply after the last outbound');
        }
      }
      if (round > maxSubstantiveRounds) {
        addError(errors, 'substantive_round_limit', `job profile permits only ${maxSubstantiveRounds} substantive rounds`);
      }
      if (currentRound !== round - 1) {
        addError(errors, 'substantive_round_stale', `${proposal.kind} requires currentRecord.communication.round=${round - 1}`);
      }
      if (nextRecordValid) {
        if (nextRound !== currentRound) addError(errors, 'next_record_round_mismatch', `pre-send proposal.nextRecord.communication.round must remain ${currentRound}`);
        if (proposal.nextRecord?.next_round !== round) addError(errors, 'next_record_semantic_round_mismatch', `proposal.nextRecord.next_round must be ${round}`);
        if (!['ready_for_contact', 'needs_more_info'].includes(proposal.nextRecord?.state)) addError(errors, 'next_record_state_mismatch', 'pre-send substantive decisions must use ready_for_contact or needs_more_info');
        if (proposal.nextRecord?.recommendation !== 'continue_contact') addError(errors, 'next_record_recommendation_mismatch', 'substantive proposals require recommendation=continue_contact');
        if (proposal.kind === 'substantive_round2') {
          if (typeof proposal.nextRecord?.score?.ability_base_score !== 'number' || proposal.nextRecord.score.ability_base_score < 60) {
            addError(errors, 'round2_ability_gate', 'substantive_round2 requires deterministic ability_base_score >= 60');
          }
          if (typeof proposal.nextRecord?.score?.evidence_coverage_percent !== 'number' || proposal.nextRecord.score.evidence_coverage_percent < 70) {
            addError(errors, 'round2_coverage_gate', 'substantive_round2 requires evidence_coverage_percent >= 70');
          }
          if (typeof proposal.nextRecord?.score?.final_signal_score !== 'number' || proposal.nextRecord.score.final_signal_score < 65) {
            addError(errors, 'round2_signal_gate', 'substantive_round2 requires final_signal_score >= 65');
          }
        }
      }
    }

    if (proposal?.kind === 'policy') {
      if (nextRecordValid && nextRound !== currentRound) {
        addError(errors, 'policy_round_changed', 'policy proposals must retain the actual communication.round');
      }
    }

    if (proposal?.kind === 'hold') {
      if (nextRecordValid) {
        if (nextRound !== currentRound) addError(errors, 'hold_round_changed', 'hold proposals must retain the actual communication.round');
        const stopping = proposal.nextRecord?.recommendation === 'stop'
          && ['current_role_mismatch', 'stop_contact'].includes(proposal.nextRecord?.state);
        if (stopping) {
          if (proposal.nextRecord?.job_fit?.hard_condition_status !== 'conflict') addError(errors, 'stop_conflict_missing', 'a no-send stop requires a reviewed hard-condition conflict');
          const last = latestMessage(messages, packetCandidate?.uid);
          if (last.direction !== 'in' || !proposal.citations?.some(c => midKey(c.mid) === midKey(last.mid))) addError(errors, 'stop_candidate_citation_missing', 'a no-send stop must cite the latest actual candidate message');
          if (safeHash(currentRecord?.score) !== safeHash(proposal.nextRecord?.score)) addError(errors, 'stop_score_changed', 'a hard-condition stop must preserve the reviewed ability score');
        } else if (proposal.nextRecord?.recommendation !== 'hold') addError(errors, 'hold_recommendation_mismatch', 'hold proposals require recommendation=hold');
        if (proposal.nextRecord?.next_round !== 0) addError(errors, 'hold_next_round_mismatch', 'hold proposals require next_round=0');
      }
    }

    if (proposal?.kind === 'hr_handoff') {
      if (safety.baseReadbackVerified !== true) {
        addError(errors, 'hr_before_base_readback', 'hr_handoff is forbidden before verified talent-base readback');
      }
      if (currentRecord?.state !== 'ai_screened_pass') {
        addError(errors, 'hr_state_not_eligible', 'pre-send hr_handoff requires currentRecord.state=ai_screened_pass');
      }
      if (currentRecord?.recommendation !== 'ready_for_hr') {
        addError(errors, 'hr_recommendation_not_eligible', 'currentRecord.recommendation must be ready_for_hr');
      }
      if (nextRecordValid) {
        if (nextRound !== currentRound) addError(errors, 'handoff_round_changed', 'pre-send hr_handoff must retain the actual communication.round');
        if (proposal.nextRecord?.state !== 'ai_screened_pass') addError(errors, 'handoff_state_mismatch', 'pre-send hr_handoff must keep nextRecord.state=ai_screened_pass');
        if (proposal.nextRecord?.recommendation !== 'ready_for_hr') addError(errors, 'handoff_recommendation_mismatch', 'hr_handoff requires recommendation=ready_for_hr');
        if (proposal.nextRecord?.next_round !== 0) addError(errors, 'handoff_next_round_mismatch', 'hr_handoff requires next_round=0');
      }
    }

    const technologyPolicy = packet?.reviewPolicy?.newTechnologyAppeared ?? packet?.policy?.newTechnologyAppeared;
    if (technologyPolicy !== undefined && typeof technologyPolicy !== 'boolean') {
      addError(errors, 'technology_policy_invalid', 'packet.reviewPolicy.newTechnologyAppeared must be boolean when present');
    } else if (technologyPolicy !== true && nextRecordValid) {
      const currentScore = safeHash(currentRecord?.score);
      const nextScore = safeHash(proposal.nextRecord?.score);
      if (!currentScore || currentScore !== nextScore) {
        addError(errors, 'score_changed_without_new_technology', 'proposal.nextRecord changed the reviewed score without a declared new technology');
      }
    }

    for (const [label, record] of [['current', currentRecord], ['next', proposal?.nextRecord]]) {
      if (!isObject(record?.facts) || ['confirmed', 'unverified', 'unknown'].some(key => !Array.isArray(record.facts[key]) || record.facts[key].some(x => typeof x !== 'string'))) {
        addError(errors, `${label}_facts_invalid`, 'facts must contain confirmed/unverified/unknown string arrays');
      }
    }

    addNaturalnessWarnings(proposal?.text, warnings);
  } catch (error) {
    addError(errors, 'validation_internal_error', errorMessage(error));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    bindingSha256,
    proposalSha256,
    textSha256,
  };
}
