import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {historyFingerprint, newSentMatches} from '../../../scripts/runtime.mjs';
import {privateDirectory} from '../../../scripts/platform.mjs';
import {canonicalJsonSha256, validateCandidateRecord} from './candidate_ledger.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SEND_KINDS = new Set(['substantive_round1', 'substantive_round2', 'policy', 'hr_handoff']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fileSha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function textSha256(text) { return fileSha256(Buffer.from(text, 'utf8')); }
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

function nowValue(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) throw codedError('clock_invalid', 'now must resolve to a nonnegative integer millisecond timestamp');
  return value;
}
function addError(errors, code, message) { errors.push({code, message}); }
function finishVerification(errors, extra = {}) {
  const unique = [], seen = new Set();
  for (const error of errors) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'unknown_error';
    if (seen.has(code)) continue;
    seen.add(code);
    unique.push({code, message: typeof error?.message === 'string' && error.message ? error.message : code});
  }
  return {verified: unique.length === 0, errors: unique, ...extra};
}
function safePathEqual(left, right) {
  const a = path.resolve(String(left)), b = path.resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function readRegularFile(file) {
  if (typeof file !== 'string' || !file) throw codedError('path_invalid', 'receipt path must be a nonempty string');
  const absolute = path.resolve(file), stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw codedError('path_not_regular_file', `receipt path is not a regular file: ${absolute}`);
  return {path: absolute, bytes: fs.readFileSync(absolute)};
}
function parseJson(bytes, label, errors) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { addError(errors, 'json_invalid', `${label} is not valid UTF-8 JSON: ${errorMessage(error)}`); return null; }
}
function evidenceFile(reference, label, errors) {
  if (!isObject(reference) || typeof reference.path !== 'string' || !reference.path || typeof reference.sha256 !== 'string' || !SHA256.test(reference.sha256)) {
    addError(errors, `${label}_missing`, `${label} must contain a real path and lowercase SHA-256`);
    return null;
  }
  let file;
  try { file = readRegularFile(reference.path); }
  catch (error) { addError(errors, `${label}_file_invalid`, `${label} file is unavailable: ${errorMessage(error)}`); return null; }
  const actualSha256 = fileSha256(file.bytes);
  if (actualSha256 !== reference.sha256) addError(errors, `${label}_sha256_mismatch`, `${label} declared SHA-256 does not match its actual bytes`);
  return {...file, actualSha256, json: parseJson(file.bytes, label, errors)};
}
function createExclusiveFile(file, bytes) {
  let fd = null, created = false;
  try {
    fd = fs.openSync(file, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
    if (created) { try { fs.unlinkSync(file); } catch {} }
    throw error;
  } finally { if (fd !== null) fs.closeSync(fd); }
}
function claimPaths(root, {jobId, uid, sourceFingerprint}) {
  const identityKey = fileSha256(Buffer.from(JSON.stringify({jobId, uid}), 'utf8'));
  const sourceKey = fileSha256(Buffer.from(JSON.stringify({jobId, uid, sourceFingerprint}), 'utf8'));
  return {
    root,
    uidLockFile: path.join(root, `pipeline-${identityKey}.lock`),
    claimFile: path.join(root, `pipeline-${sourceKey}.claim.json`),
    completionFile: path.join(root, `pipeline-${sourceKey}.completion.json`),
  };
}
function claimFromPaths(value, paths) {
  return {
    schemaVersion: value.schemaVersion, claimId: value.claimId, taskId: value.taskId,
    jobId: value.jobId, uid: value.uid, sourceFingerprint: value.sourceFingerprint,
    recordSha256: value.recordSha256, bindingSha256: value.bindingSha256,
    acquiredAt: value.acquiredAt, expiresAt: value.expiresAt,
    claimFile: paths.claimFile, claimFileSha256: value.claimFileSha256, uidLockFile: paths.uidLockFile,
  };
}
function validateClaimInput(input, options) {
  if (!isObject(input)) throw codedError('claim_input_invalid', 'claim input must be an object');
  if (typeof input.taskId !== 'string' || !input.taskId) throw codedError('task_id_invalid', 'taskId must be a nonempty string');
  if (typeof input.jobId !== 'string' || !input.jobId) throw codedError('job_id_invalid', 'jobId must be a nonempty string');
  if (!Number.isSafeInteger(input.uid) || input.uid < 1) throw codedError('uid_invalid', 'uid must be a positive integer');
  if (typeof input.sourceFingerprint !== 'string' || !input.sourceFingerprint) throw codedError('source_fingerprint_invalid', 'sourceFingerprint must be a nonempty string');
  if (typeof input.recordSha256 !== 'string' || !SHA256.test(input.recordSha256)) throw codedError('record_sha256_invalid', 'recordSha256 must be lowercase SHA-256');
  if (typeof input.bindingSha256 !== 'string' || !SHA256.test(input.bindingSha256)) throw codedError('binding_sha256_invalid', 'bindingSha256 must be lowercase SHA-256');
  if (!isObject(options)) throw codedError('claim_options_invalid', 'claim options must be an object');
  const ttlMs = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw codedError('ttl_invalid', 'ttlMs must be a positive integer');
  return {ttlMs};
}

/** Creates a permanent source claim and an exclusive per-job/UID lock. */
export function claimPipelineTask(root, input, {now = Date.now, ttlMs = 300_000} = {}) {
  if (typeof root !== 'string' || !root) throw codedError('root_invalid', 'root must be a nonempty path');
  const normalized = validateClaimInput(input, {ttlMs});
  const acquiredAt = nowValue(now);
  if (!Number.isSafeInteger(acquiredAt + normalized.ttlMs)) throw codedError('expiry_invalid', 'claim expiry exceeds the safe integer range');
  const rootPath = path.resolve(root);
  privateDirectory(rootPath);
  const paths = claimPaths(rootPath, input), expiresAt = acquiredAt + normalized.ttlMs;
  const uidLockToken = crypto.randomBytes(32).toString('hex');
  const claimId = crypto.randomBytes(16).toString('hex');
  const lock = {
    schemaVersion: 1, token: uidLockToken, claimId, taskId: input.taskId, jobId: input.jobId,
    uid: input.uid, sourceFingerprint: input.sourceFingerprint, acquiredAt, expiresAt, claimFile: paths.claimFile,
  };
  const pending = {
    ...claimFromPaths({...input, schemaVersion: 1, claimId, acquiredAt, expiresAt, claimFileSha256: ''}, paths),
    uidLockToken,
  };
  const lockBytes = jsonBytes(lock);
  let lockCreated = false;
  if (fs.existsSync(paths.completionFile)) throw codedError('uid_completed', 'this job/UID already has a permanent completion receipt');
  if (fs.existsSync(paths.claimFile)) throw codedError('claim_exists', 'this source is already permanently claimed');
  try {
    createExclusiveFile(paths.uidLockFile, lockBytes); lockCreated = true;
    if (fs.existsSync(paths.completionFile)) throw codedError('uid_completed', 'this job/UID already has a permanent completion receipt');
    if (fs.existsSync(paths.claimFile)) throw codedError('claim_exists', 'this source is already permanently claimed');
    pending.claimFileSha256 = '';
    const claimBytes = jsonBytes(pending);
    const actualClaimSha256 = fileSha256(claimBytes);
    createExclusiveFile(paths.claimFile, claimBytes);
    return {...claimFromPaths(pending, paths), claimFileSha256: actualClaimSha256};
  } catch (error) {
    if (lockCreated) {
      try {
        const current = fs.readFileSync(paths.uidLockFile);
        if (current.equals(lockBytes)) fs.unlinkSync(paths.uidLockFile);
      } catch {}
    }
    if (error?.code === 'EEXIST') {
      if (fs.existsSync(paths.completionFile)) throw codedError('uid_completed', 'this job/UID already has a permanent completion receipt');
      if (fs.existsSync(paths.claimFile)) throw codedError('claim_exists', 'this source is already permanently claimed');
      throw codedError('uid_locked', 'this job/UID is locked by another source');
    }
    throw error;
  }
}

function claimExpected(claim) {
  return {
    taskId: claim?.taskId, jobId: claim?.jobId, uid: claim?.uid,
    sourceFingerprint: claim?.sourceFingerprint, recordSha256: claim?.recordSha256, bindingSha256: claim?.bindingSha256,
  };
}
function expectedClaimMatchesClaim(expected) {
  return isObject(expected)
    && typeof expected.taskId === 'string' && expected.taskId
    && typeof expected.jobId === 'string' && expected.jobId
    && Number.isSafeInteger(expected.uid) && expected.uid > 0
    && typeof expected.sourceFingerprint === 'string' && expected.sourceFingerprint
    && typeof expected.recordSha256 === 'string' && SHA256.test(expected.recordSha256)
    && typeof expected.bindingSha256 === 'string' && SHA256.test(expected.bindingSha256);
}

/** Revalidates claim bytes, source identity, matching lock token, CAS binding and expiry. */
export function verifyPipelineClaim(claim, expected, options = {}) {
  const errors = [];
  const {now = Date.now} = isObject(options) ? options : {};
  try {
    if (!isObject(claim)) {
      addError(errors, 'claim_invalid', 'claim must be the structured object returned by claimPipelineTask');
      return finishVerification(errors);
    }
    if (!expectedClaimMatchesClaim(expected)) addError(errors, 'claim_expected_invalid', 'exact task/job/UID/source/record/binding identity is required');
    if (claim.schemaVersion !== 1) addError(errors, 'claim_schema_invalid', 'claim.schemaVersion must be 1');
    if (typeof claim.claimId !== 'string' || !/^[a-f0-9]{32}$/u.test(claim.claimId)) addError(errors, 'claim_id_invalid', 'claimId is invalid');
    for (const field of ['taskId', 'jobId', 'sourceFingerprint']) {
      if (typeof claim[field] !== 'string' || !claim[field]) addError(errors, `claim_${field}_invalid`, `claim.${field} must be a nonempty string`);
    }
    if (!Number.isSafeInteger(claim.uid) || claim.uid < 1) addError(errors, 'claim_uid_invalid', 'claim.uid must be a positive integer');
    for (const field of ['recordSha256', 'bindingSha256', 'claimFileSha256']) {
      if (typeof claim[field] !== 'string' || !SHA256.test(claim[field])) addError(errors, `claim_${field}_invalid`, `claim.${field} must be lowercase SHA-256`);
    }
    if (!Number.isSafeInteger(claim.acquiredAt) || claim.acquiredAt < 0 || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= claim.acquiredAt) {
      addError(errors, 'claim_time_invalid', 'claim acquisition/expiry timestamps are invalid');
    }
    if (expectedClaimMatchesClaim(expected)) {
      for (const field of ['taskId', 'jobId', 'uid', 'sourceFingerprint', 'recordSha256', 'bindingSha256']) {
        if (claim[field] !== expected[field]) addError(errors, 'claim_identity_mismatch', `claim.${field} does not match the requested task`);
      }
    }
    const directory = typeof claim.claimFile === 'string' && claim.claimFile ? path.dirname(path.resolve(claim.claimFile)) : null;
    if (!directory) {
      addError(errors, 'claim_file_invalid', 'claim.claimFile must be an absolute or resolvable path');
      return finishVerification(errors);
    }
    const paths = claimPaths(directory, claim);
    if (!safePathEqual(claim.claimFile, paths.claimFile)) addError(errors, 'claim_file_path_invalid', 'claim file name does not match its bound identity/source');
    if (!safePathEqual(claim.uidLockFile, paths.uidLockFile)) addError(errors, 'claim_lock_path_invalid', 'UID lock path does not match its bound job/UID');
    let claimFile;
    try { claimFile = readRegularFile(paths.claimFile); }
    catch (error) { addError(errors, 'claim_file_unavailable', `claim file cannot be read: ${errorMessage(error)}`); }
    let persisted = null;
    if (claimFile) {
      if (fileSha256(claimFile.bytes) !== claim.claimFileSha256) addError(errors, 'claim_file_sha256_mismatch', 'claim file bytes do not match claimFileSha256');
      persisted = parseJson(claimFile.bytes, 'claim file', errors);
    }
    if (isObject(persisted)) {
      if (persisted.schemaVersion !== 1 || persisted.claimId !== claim.claimId) addError(errors, 'claim_file_identity_mismatch', 'claim file schema/claimId does not match the returned claim');
      for (const field of ['taskId', 'jobId', 'uid', 'sourceFingerprint', 'recordSha256', 'bindingSha256', 'acquiredAt', 'expiresAt', 'claimFile', 'uidLockFile']) {
        if (persisted[field] !== claim[field]) addError(errors, 'claim_file_field_mismatch', `claim file field ${field} does not match the returned claim`);
      }
      if (typeof persisted.uidLockToken !== 'string' || !SHA256.test(persisted.uidLockToken)) addError(errors, 'claim_lock_token_invalid', 'claim file does not contain a valid UID lock token');
    }
    let lockFile = null;
    try { lockFile = readRegularFile(paths.uidLockFile); }
    catch (error) { addError(errors, 'uid_lock_unavailable', `UID lock cannot be read: ${errorMessage(error)}`); }
    if (lockFile) {
      const lock = parseJson(lockFile.bytes, 'UID lock', errors);
      if (isObject(lock)) {
        if (lock.schemaVersion !== 1 || lock.claimId !== claim.claimId) addError(errors, 'uid_lock_claim_mismatch', 'UID lock schema/claimId does not match the claim');
        for (const field of ['taskId', 'jobId', 'uid', 'sourceFingerprint', 'acquiredAt', 'expiresAt', 'claimFile']) {
          if (lock[field] !== claim[field]) addError(errors, 'uid_lock_field_mismatch', `UID lock field ${field} does not match the claim`);
        }
        if (isObject(persisted) && lock.token !== persisted.uidLockToken) addError(errors, 'uid_lock_token_mismatch', 'UID lock token does not match the claim file token');
      }
    }
    if (Number.isSafeInteger(claim.expiresAt)) {
      let current;
      try { current = nowValue(now); } catch (error) { addError(errors, 'clock_invalid', errorMessage(error)); }
      if (Number.isSafeInteger(current) && current >= claim.expiresAt) addError(errors, 'claim_expired', 'claim has expired');
    }
  } catch (error) { addError(errors, 'claim_verification_internal_error', errorMessage(error)); }
  return finishVerification(errors);
}

function completionValue(claim, completedAt) {
  return {
    schemaVersion: 1, claimId: claim.claimId, taskId: claim.taskId, jobId: claim.jobId,
    uid: claim.uid, sourceFingerprint: claim.sourceFingerprint, recordSha256: claim.recordSha256,
    bindingSha256: claim.bindingSha256, acquiredAt: claim.acquiredAt, expiresAt: claim.expiresAt,
    completedAt, claimFile: claim.claimFile, claimFileSha256: claim.claimFileSha256, uidLockFile: claim.uidLockFile,
  };
}
function completionMatches(value, claim) {
  if (!isObject(value) || value.schemaVersion !== 1 || value.claimId !== claim.claimId) return false;
  for (const field of ['taskId', 'jobId', 'uid', 'sourceFingerprint', 'recordSha256', 'bindingSha256', 'acquiredAt', 'expiresAt', 'claimFile', 'claimFileSha256', 'uidLockFile']) {
    if (value[field] !== claim[field]) return false;
  }
  return Number.isSafeInteger(value.completedAt) && value.completedAt >= 0;
}
function removeMatchingUidLock(claim) {
  const lockFile = readRegularFile(claim.uidLockFile);
  const lock = JSON.parse(lockFile.bytes.toString('utf8'));
  if (!isObject(lock) || lock.claimId !== claim.claimId || lock.token === undefined) return false;
  const claimFile = readRegularFile(claim.claimFile);
  const persisted = JSON.parse(claimFile.bytes.toString('utf8'));
  if (!isObject(persisted) || persisted.uidLockToken !== lock.token) return false;
  fs.unlinkSync(path.resolve(claim.uidLockFile));
  return true;
}

/** Persists a permanent completion, then removes only the lock whose token matches. */
export function completePipelineClaim(claim) {
  const errors = [];
  try {
    if (!isObject(claim)) {
      addError(errors, 'claim_invalid', 'claim must be a structured pipeline claim');
      return {completed: false, errors};
    }
    if (typeof claim.claimFile !== 'string' || !claim.claimFile) {
      addError(errors, 'claim_file_invalid', 'claim.claimFile is required');
      return {completed: false, errors};
    }
    const directory = path.dirname(path.resolve(claim.claimFile));
    const paths = claimPaths(directory, claim);
    let existing = null;
    if (fs.existsSync(paths.completionFile)) {
      try {
        const file = readRegularFile(paths.completionFile);
        existing = JSON.parse(file.bytes.toString('utf8'));
        if (!completionMatches(existing, claim)) {
          addError(errors, 'completion_conflict', 'a different permanent completion already exists for this job/UID');
          return {completed: false, errors};
        }
      } catch (error) {
        addError(errors, 'completion_unreadable', `existing completion receipt cannot be read: ${errorMessage(error)}`);
        return {completed: false, errors};
      }
    }
    if (!existing) {
      const verified = verifyPipelineClaim(claim, claimExpected(claim), {now: Date.now});
      if (!verified.verified) return {completed: false, errors: verified.errors};
    }
    const record = existing ?? completionValue(claim, Date.now());
    let completionBytes = existing ? readRegularFile(paths.completionFile).bytes : null;
    if (!existing) {
      completionBytes = jsonBytes(record);
      try { createExclusiveFile(paths.completionFile, completionBytes); }
      catch (error) {
        if (error?.code !== 'EEXIST') {
          addError(errors, 'completion_write_failed', `completion receipt could not be written: ${errorMessage(error)}`);
          return {completed: false, errors};
        }
        const raced = readRegularFile(paths.completionFile);
        const racedValue = JSON.parse(raced.bytes.toString('utf8'));
        if (!completionMatches(racedValue, claim)) {
          addError(errors, 'completion_conflict', 'a different completion receipt won the write race');
          return {completed: false, errors};
        }
        existing = racedValue; completionBytes = raced.bytes;
      }
    }
    if (fs.existsSync(paths.uidLockFile)) {
      try {
        if (!removeMatchingUidLock(claim)) addError(errors, 'uid_lock_changed', 'UID lock no longer belongs to the completed claim');
      } catch (error) { addError(errors, 'uid_lock_remove_failed', `matching UID lock could not be removed: ${errorMessage(error)}`); }
    }
    if (errors.length) return {completed: false, errors};
    const bytes = completionBytes ?? readRegularFile(paths.completionFile).bytes;
    return {
      completed: true, alreadyCompleted: Boolean(existing), claimId: claim.claimId,
      completionFile: paths.completionFile, completionFileSha256: fileSha256(bytes),
    };
  } catch (error) {
    addError(errors, 'completion_internal_error', errorMessage(error));
    return {completed: false, errors};
  }
}

function midKey(value) {
  if (Number.isSafeInteger(value) && value >= 0) return `numeric:${BigInt(value).toString()}`;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) return `numeric:${BigInt(value).toString()}`;
  if (typeof value === 'string' && value.length > 0) return `string:${value}`;
  return null;
}
function parseHistory(value, label, errors) {
  if (!isObject(value)) { addError(errors, `${label}_schema_invalid`, `${label} must contain complete history messages`); return null; }
  if (Object.hasOwn(value, 'code') && value.code !== 0) { addError(errors, `${label}_response_failed`, `${label} history response code must be 0`); return null; }
  let messages = null;
  if (value.complete === true && Array.isArray(value.messages)) messages = value.messages;
  else if (value?.zpData?.hasMore === false && Array.isArray(value.zpData.messages)) messages = value.zpData.messages;
  if (messages === null) { addError(errors, `${label}_incomplete`, `${label} must be {complete:true,messages} or {zpData:{hasMore:false,messages}}`); return null; }
  const seen = new Set();
  for (let index = 0; index < messages.length; index++) {
    const key = midKey(messages[index]?.mid);
    if (key === null) { addError(errors, `${label}_mid_invalid`, `${label}.messages[${index}].mid is invalid`); continue; }
    if (seen.has(key)) addError(errors, `${label}_mid_duplicate`, `${label} contains duplicate mid ${String(messages[index].mid)}`);
    seen.add(key);
  }
  return messages;
}
function conversationOwner(messages, candidateUid, label, errors) {
  if (!Array.isArray(messages)) return null;
  const participants = new Set();
  for (const [index, message] of messages.entries()) {
    if (!isObject(message) || !Number.isSafeInteger(message?.from?.uid) || message.from.uid < 1
      || !Number.isSafeInteger(message?.to?.uid) || message.to.uid < 1) {
      addError(errors, `${label}_participant_invalid`, `${label}.messages[${index}] must contain integer from/to UIDs`);
      continue;
    }
    participants.add(message.from.uid); participants.add(message.to.uid);
  }
  if (!participants.has(candidateUid)) addError(errors, `${label}_candidate_missing`, `${label} must include the claimed candidate participant`);
  const others = [...participants].filter(uid => uid !== candidateUid);
  if (others.length !== 1) { addError(errors, `${label}_participants_not_unique`, `${label} must contain exactly one candidate and one recruiter UID`); return null; }
  const ownerUid = others[0];
  if (messages.some(message => {
    const pair = new Set([message?.from?.uid, message?.to?.uid]);
    return pair.size !== 2 || !pair.has(candidateUid) || !pair.has(ownerUid);
  })) addError(errors, `${label}_third_party`, `${label} contains a third-party participant`);
  return ownerUid;
}
function stripSecurityId(message) {
  if (!isObject(message)) return message;
  const {securityId, ...rest} = message;
  return rest;
}
function verifySendHistories({beforeMessages, afterMessages, ownerUid, candidateUid, text, sender, proposal, errors}) {
  if (!Array.isArray(beforeMessages) || !Array.isArray(afterMessages)) return null;
  const beforeFingerprint = historyFingerprint(beforeMessages), afterFingerprint = historyFingerprint(afterMessages);
  if (proposal?.expectedHistorySha256 !== beforeFingerprint) addError(errors, 'before_history_proposal_mismatch', 'before history fingerprint does not match proposal.expectedHistorySha256');
  const afterByMid = new Map(afterMessages.map(message => [midKey(message?.mid), message]));
  for (const message of beforeMessages) {
    const after = afterByMid.get(midKey(message?.mid));
    if (!after || canonicalJsonSha256(stripSecurityId(after)) !== canonicalJsonSha256(stripSecurityId(message))) {
      addError(errors, 'history_prior_message_changed', 'after history changed or removed a pre-send message');
      break;
    }
  }
  const beforeMids = new Set(beforeMessages.map(message => midKey(message?.mid)));
  const newMessages = afterMessages.filter(message => !beforeMids.has(midKey(message?.mid)));
  if (newMessages.length !== 1) addError(errors, 'history_new_message_count', `after history must contain exactly one new mid, found ${newMessages.length}`);
  const matching = newSentMatches(beforeMessages, afterMessages, text, ownerUid, candidateUid);
  if (matching.length !== 1) addError(errors, 'history_matching_outbound_count', `after history must contain exactly one matching outbound, found ${matching.length}`);
  const matchingMid = midKey(matching[0]?.mid);
  if (newMessages.length === 1 && midKey(newMessages[0]?.mid) !== matchingMid) addError(errors, 'history_new_message_not_send', 'the unique new history record is not the confirmed outbound');
  if (matchingMid === null || midKey(sender.messageMid) !== matchingMid) addError(errors, 'sender_message_mid_mismatch', 'senderResult.messageMid must equal the unique new outbound mid');
  return {beforeFingerprint, afterFingerprint, matchingMid};
}
function verifyCasReceipt({cas, packet, proposal, ledger, errors}) {
  if (!isObject(cas)) return null;
  const keys = Object.keys(cas).sort();
  if (keys.length !== 2 || keys[0] !== 'expectedRecordSha256' || keys[1] !== 'recordSha256') addError(errors, 'cas_receipt_shape_invalid', 'casReceipt must be exactly {expectedRecordSha256,recordSha256}');
  if (typeof cas.expectedRecordSha256 !== 'string' || !SHA256.test(cas.expectedRecordSha256)) addError(errors, 'cas_expected_invalid', 'casReceipt.expectedRecordSha256 must be lowercase SHA-256');
  if (typeof cas.recordSha256 !== 'string' || !SHA256.test(cas.recordSha256)) addError(errors, 'cas_record_invalid', 'casReceipt.recordSha256 must be lowercase SHA-256');
  let nextRecordSha256 = null;
  try { nextRecordSha256 = canonicalJsonSha256(proposal?.nextRecord); } catch {}
  if (isObject(packet) && typeof packet.recordSha256 === 'string' && !SHA256.test(packet.recordSha256)) addError(errors, 'packet_record_sha_invalid', 'packet.recordSha256 must be lowercase SHA-256');
  if (nextRecordSha256 === null) addError(errors, 'proposal_next_record_invalid', 'proposal.nextRecord must be JSON serializable');
  const allowedExpected = new Set([packet?.recordSha256, nextRecordSha256].filter(Boolean));
  if (!allowedExpected.has(cas.expectedRecordSha256)) addError(errors, 'cas_expected_not_bound', 'casReceipt.expectedRecordSha256 must bind packet.recordSha256 or proposal.nextRecord');
  let actualSha256 = null;
  try { actualSha256 = canonicalJsonSha256(ledger); } catch {}
  if (actualSha256 === null || cas.recordSha256 !== actualSha256) addError(errors, 'cas_actual_mismatch', 'casReceipt.recordSha256 must equal canonical actual ledgerAfter');
  return {nextRecordSha256, actualSha256};
}
function verifyProposalAndPacket(packet, proposal, errors) {
  const packetCandidate = isObject(packet?.candidate) ? packet.candidate : null;
  const proposalCandidate = isObject(proposal?.candidate) ? proposal.candidate : null;
  const packetJobId = packetCandidate?.boss_job_id ?? packetCandidate?.jobId;
  if (!packetCandidate || !Number.isSafeInteger(packetCandidate.uid) || packetCandidate.uid < 1
    || typeof packetCandidate.name !== 'string' || !packetCandidate.name.trim() || typeof packetJobId !== 'string' || !packetJobId) {
    addError(errors, 'packet_candidate_invalid', 'packet candidate must bind job, name and UID'); return null;
  }
  if (!proposalCandidate || proposalCandidate.uid !== packetCandidate.uid || proposalCandidate.name !== packetCandidate.name
    || (proposalCandidate.boss_job_id ?? proposalCandidate.jobId) !== packetJobId) addError(errors, 'proposal_candidate_mismatch', 'proposal candidate must exactly match packet job, name and UID');
  if (proposal?.expectedRecordSha256 !== packet.recordSha256) addError(errors, 'proposal_record_cas_mismatch', 'proposal.expectedRecordSha256 must match packet.recordSha256');
  if (proposal?.expectedHistorySha256 !== packet?.history?.sha256) addError(errors, 'proposal_history_cas_mismatch', 'proposal.expectedHistorySha256 must match packet history SHA-256');
  try { validateCandidateRecord(proposal?.nextRecord); }
  catch (error) { addError(errors, 'proposal_next_record_invalid', `proposal.nextRecord is invalid: ${errorMessage(error)}`); }
  return {uid: packetCandidate.uid, name: packetCandidate.name, jobId: packetJobId};
}

function approvedStableFields(record) {
  const copy = structuredClone(record);
  for (const key of ['state', 'recommendation', 'next_round', 'next_action', 'updated_at']) delete copy[key];
  // Only actual send metadata may change. Unknown/schema additions stay bound.
  for (const key of ['sha256', 'checked_at', 'last_mid', 'last_direction']) delete copy.history?.[key];
  for (const key of ['round', 'last_outbound_mid', 'last_outbound_at', 'pending_inbound_mids']) delete copy.communication?.[key];
  return copy;
}

/** Verifies execution using actual files; never sends, writes or removes locks. */
export function verifyPipelineExecution(result, context = {}) {
  const errors = [];
  const {packet, proposal, claim} = isObject(context) ? context : {};
  try {
    if (!isObject(result)) {
      addError(errors, 'result_invalid', 'execution result must be an object');
      return finishVerification(errors);
    }
    if (result.ok !== true) addError(errors, 'result_not_ok', 'result.ok must be true; status alone is not proof');
    if (!['boss_text_send', 'local_hold'].includes(result.kind)) addError(errors, 'result_kind_invalid', 'result.kind must be boss_text_send or local_hold');
    const identity = verifyProposalAndPacket(packet, proposal, errors);
    if (!isObject(claim)) addError(errors, 'claim_invalid', 'structured pipeline claim is required');
    else {
      const claimResult = verifyPipelineClaim(claim, claimExpected(claim), {now: Date.now});
      for (const error of claimResult.errors) addError(errors, error.code, error.message);
      if (result.claimId !== claim.claimId) addError(errors, 'result_claim_id_mismatch', 'result.claimId does not match the structured claim');
      if (claim.recordSha256 !== packet?.recordSha256) addError(errors, 'claim_record_cas_mismatch', 'claim.recordSha256 does not match packet.recordSha256');
    }
    if (identity) {
      if (result.jobId !== identity.jobId) addError(errors, 'result_job_id_mismatch', 'result.jobId does not match packet candidate job');
      if (result.uid !== identity.uid) addError(errors, 'result_uid_mismatch', 'result.uid does not match packet candidate UID');
    }
    const beforeFile = evidenceFile(result.beforeHistory, 'beforeHistory', errors);
    const afterFile = evidenceFile(result.afterHistory, 'afterHistory', errors);
    const ledgerFile = evidenceFile(result.ledgerAfter, 'ledgerAfter', errors);
    const casFile = evidenceFile(result.casReceipt, 'casReceipt', errors);
    const beforeMessages = beforeFile?.json === null ? null : parseHistory(beforeFile?.json, 'beforeHistory', errors);
    const afterMessages = afterFile?.json === null ? null : parseHistory(afterFile?.json, 'afterHistory', errors);
    const ownerUid = conversationOwner(beforeMessages, identity?.uid, 'beforeHistory', errors);
    const afterOwnerUid = conversationOwner(afterMessages, identity?.uid, 'afterHistory', errors);
    if (ownerUid !== null && afterOwnerUid !== null && ownerUid !== afterOwnerUid) addError(errors, 'history_owner_changed', 'before and after histories identify different recruiter UIDs');

    if (result.kind === 'local_hold') {
      if (Object.hasOwn(result, 'senderResult')) addError(errors, 'local_hold_sender_result', 'local_hold must not include senderResult');
      if (proposal?.kind !== 'hold' || proposal?.text !== null) addError(errors, 'local_hold_proposal_invalid', 'local_hold requires proposal.kind=hold and text=null');
      if (Array.isArray(beforeMessages) && Array.isArray(afterMessages)) {
        const beforeSha = historyFingerprint(beforeMessages), afterSha = historyFingerprint(afterMessages);
        if (beforeSha !== proposal?.expectedHistorySha256) addError(errors, 'before_history_proposal_mismatch', 'before history fingerprint does not match proposal.expectedHistorySha256');
        if (afterSha !== beforeSha) addError(errors, 'local_hold_history_changed', 'local hold must not add or change history');
      }
      if (ledgerFile?.json) {
        try { validateCandidateRecord(ledgerFile.json); }
        catch (error) { addError(errors, 'ledger_after_invalid', `ledgerAfter is invalid: ${errorMessage(error)}`); }
        let same = false;
        try { same = canonicalJsonSha256(ledgerFile.json) === canonicalJsonSha256(proposal?.nextRecord); } catch {}
        if (!same) addError(errors, 'local_hold_ledger_mismatch', 'ledgerAfter must equal canonical proposal.nextRecord exactly');
      }
      if (casFile?.json) verifyCasReceipt({cas: casFile.json, packet, proposal, ledger: ledgerFile?.json, errors});
      return finishVerification(errors);
    }

    if (result.kind !== 'boss_text_send') return finishVerification(errors);
    if (!SEND_KINDS.has(proposal?.kind) || typeof proposal?.text !== 'string' || !proposal.text.trim()) addError(errors, 'send_proposal_invalid', 'boss_text_send requires a send proposal with nonempty text');
    const senderFile = evidenceFile(result.senderResult, 'senderResult', errors);
    const sender = senderFile?.json;
    if (!isObject(sender)) addError(errors, 'sender_result_invalid', 'senderResult must contain the public sender JSON object');
    else {
      if (sender.attempts !== 1 || sender.sdkInvoked !== true || sender.historyConfirmed !== true || sender.matchingNewRecords !== 1) addError(errors, 'sender_attempts_or_confirmation_invalid', 'senderResult must prove exactly one SDK attempt and one confirmed new record');
      if (midKey(sender.messageMid) === null) addError(errors, 'sender_message_mid_invalid', 'senderResult.messageMid is invalid');
      if (typeof proposal?.text !== 'string' || sender.textSha256 !== textSha256(proposal.text)) addError(errors, 'sender_text_sha256_mismatch', 'senderResult.textSha256 must equal the actual proposal text SHA-256');
      if (sender?.recipient?.uid !== identity?.uid || sender?.recipient?.name !== identity?.name) addError(errors, 'sender_recipient_mismatch', 'senderResult.recipient must exactly match packet UID and name');
    }
    let history = null;
    if (ownerUid !== null && afterOwnerUid !== null && isObject(sender) && typeof proposal?.text === 'string') {
      history = verifySendHistories({beforeMessages, afterMessages, ownerUid, candidateUid: identity?.uid, text: proposal.text, sender, proposal, errors});
    }

    if (ledgerFile?.json) {
      try { validateCandidateRecord(ledgerFile.json); }
      catch (error) { addError(errors, 'ledger_after_invalid', `ledgerAfter is invalid: ${errorMessage(error)}`); }
      const ledger = ledgerFile.json;
      if (canonicalJsonSha256(approvedStableFields(ledger)) !== canonicalJsonSha256(approvedStableFields(proposal.nextRecord))) {
        addError(errors, 'ledger_after_unapproved_changes', 'Post-send ledger may change only actual send metadata; approved job, candidate, score, facts, job_fit, sources and schema must remain identical');
      }
      if (ledger?.job?.boss_job_id !== identity?.jobId || ledger?.candidate?.uid !== identity?.uid || ledger?.candidate?.name !== identity?.name) {
        addError(errors, 'ledger_after_identity_mismatch', 'ledgerAfter must match packet job, UID and name');
      }
      const sentMid = midKey(sender?.messageMid);
      if (history && ledger?.history?.sha256 !== history.afterFingerprint) addError(errors, 'ledger_after_history_mismatch', 'ledgerAfter history.sha256 must equal afterHistory fingerprint');
      if (midKey(ledger?.history?.last_mid) !== sentMid || ledger?.history?.last_direction !== 'out') addError(errors, 'ledger_after_history_tail_mismatch', 'ledgerAfter history tail must be the sent outbound mid');
      const proposalRound = proposal?.nextRecord?.communication?.round;
      const substantive = proposal?.kind === 'substantive_round1' || proposal?.kind === 'substantive_round2';
      const expectedRound = Number.isInteger(proposalRound) ? proposalRound + (substantive ? 1 : 0) : null;
      if (expectedRound === null || ledger?.communication?.round !== expectedRound) addError(errors, 'ledger_after_round_mismatch', 'ledgerAfter communication.round does not follow the proposal round rule');
      if (midKey(ledger?.communication?.last_outbound_mid) !== sentMid) addError(errors, 'ledger_after_outbound_mid_mismatch', 'ledgerAfter communication.last_outbound_mid must equal senderResult.messageMid');
      if (!Array.isArray(ledger?.communication?.pending_inbound_mids) || ledger.communication.pending_inbound_mids.length !== 0) addError(errors, 'ledger_after_pending_inbound', 'confirmed send must clear pending_inbound_mids');
      if (typeof ledger?.communication?.last_outbound_at !== 'string' || !Number.isFinite(Date.parse(ledger.communication.last_outbound_at))) addError(errors, 'ledger_after_outbound_time_invalid', 'ledgerAfter communication.last_outbound_at must be an ISO timestamp');
      const expectedState = proposal?.kind === 'hr_handoff' ? 'hr_review' : proposal?.kind === 'policy' ? proposal.nextRecord.state : 'awaiting_candidate_reply';
      if (ledger?.state !== expectedState) addError(errors, 'ledger_after_state_mismatch', `ledgerAfter.state must be ${expectedState}`);
      const expectedRecommendation = proposal?.kind === 'hr_handoff' ? 'ready_for_hr' : proposal?.kind === 'policy' ? proposal.nextRecord.recommendation : 'continue_contact';
      if (ledger?.recommendation !== expectedRecommendation) addError(errors, 'ledger_after_recommendation_mismatch', `ledgerAfter.recommendation must be ${expectedRecommendation}`);
      if (ledger?.next_round !== 0) addError(errors, 'ledger_after_next_round_invalid', 'A confirmed outbound must leave next_round=0');
    }
    if (casFile?.json) verifyCasReceipt({cas: casFile.json, packet, proposal, ledger: ledgerFile?.json, errors});
    const messageMid = errors.length === 0 ? sender?.messageMid : undefined;
    return finishVerification(errors, messageMid === undefined ? {} : {messageMid});
  } catch (error) {
    addError(errors, 'execution_verification_internal_error', errorMessage(error));
    return finishVerification(errors);
  }
}
