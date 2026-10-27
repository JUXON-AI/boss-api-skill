import { createHash } from 'node:crypto';

function requireValue(condition, reason) {
  if (!condition) throw new TypeError(`Unsafe resume acceptance plan: ${reason}`);
}

function record(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  `${label} must be a plain object`);
  return value;
}

// IDs remain decimal strings. In particular, never round an ID through Number().
function safeId(value, label) {
  if (typeof value === 'number') {
    requireValue(Number.isSafeInteger(value) && value > 0, `${label} must be a safe positive ID`);
    return String(value);
  }
  requireValue(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && value.length <= 64,
    `${label} must be a canonical positive decimal ID`);
  return value;
}

function safeName(value, label) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  `${label} must be a nonempty name without surrounding whitespace or control characters`);
  return value;
}

// Original filename is data only; preserve spaces and never treat it as a path.
function safeResumeName(value) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'resumeName must be nonblank, at most 512 characters, and contain no control characters');
  return value;
}

// Canonical parsed JSON: sorted object keys, original array order, finite numbers.
// These hashes bind the supplied JS representation, not original wire/file bytes.
// Identity IDs are validated separately by safeId; metadata may contain large numbers.
function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value) && !Object.is(value, -0),
      'nonfinite number or negative zero in supplied data');
    return JSON.stringify(value);
  }
  requireValue(typeof value === 'object' && value !== null, 'supplied data must be JSON-compatible');
  requireValue(!ancestors.has(value), 'cyclic supplied data');
  requireValue(Object.getOwnPropertySymbols(value).length === 0, 'symbol keys in supplied data');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    requireValue(keys.length === value.length && keys.every((key, index) => key === String(index)),
      'sparse or decorated array in supplied data');
    result = '[' + keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValue(descriptor && Object.hasOwn(descriptor, 'value'), 'accessor in supplied data');
      return canonicalJson(descriptor.value, ancestors);
    }).join(',') + ']';
  } else {
    record(value, 'supplied data');
    result = '{' + Object.getOwnPropertyNames(value).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
        'accessor or hidden property in supplied data');
      return JSON.stringify(key) + ':' + canonicalJson(descriptor.value, ancestors);
    }).join(',') + '}';
  }
  ancestors.delete(value);
  return result;
}

const sha256 = bytes => createHash('sha256').update(bytes, 'utf8').digest('hex');

function checkedCandidate(value, label) {
  record(value, label);
  return {
    uid: safeId(value.uid, `${label}.uid`),
    name: safeName(value.name, `${label}.name`),
    jobId: safeId(value.jobId, `${label}.jobId`),
  };
}

function checkedAttachment(dialog, uid) {
  requireValue(Array.isArray(dialog.buttons), 'dialog.buttons must be an array');
  const consentButtons = dialog.buttons.filter(button => {
    record(button, 'dialog button');
    return button.text === '同意';
  });
  requireValue(consentButtons.length === 1, 'exactly one 同意 button is required');
  const button = consentButtons[0];
  requireValue(typeof button.url === 'string' && button.url === button.url.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(button.url), 'consent button URL must be a clean string');
  const url = new URL(button.url);
  requireValue(url.protocol === 'bosszp:' && url.host === 'bosszhipin.app' &&
    url.pathname === '/openwith' && !url.username && !url.password,
  'only the exact bosszp host and openwith path are allowed');
  requireValue(!url.hash && !button.url.includes('#') &&
    JSON.stringify([...url.searchParams.keys()].sort()) === JSON.stringify(['aid', 'extends', 'type', 'uid']),
  'unexpected URL parameters or fragment');
  requireValue(url.searchParams.get('type') === 'sendaction' && url.searchParams.get('uid') === uid &&
    url.searchParams.get('aid') === '41', 'wrong attachment action or URL identity');
  let attachment;
  try {
    attachment = JSON.parse(url.searchParams.get('extends'));
  } catch {
    throw new TypeError('Unsafe resume acceptance plan: extends must be JSON');
  }
  record(attachment, 'attachment');
  canonicalJson(attachment);
  return {
    resumeId: safeId(attachment.resumeId, 'resumeId'),
    resumeName: safeResumeName(attachment.resumeName),
  };
}

/**
 * Pure, fail-closed planner. Invalid or ambiguous inputs throw TypeError.
 * Message schema: {mid,type,from:{uid,name?},to:{uid},body:{type,dialog}};
 * dialog.buttons contains {text,url}, with exactly one 同意 button for aid=41.
 * history.candidate must exactly match candidate's uid/name/jobId; complete must
 * be true. Optional identity/job fields on the selected message must also agree.
 * Prior attempt schema: {uid,requestMid,...}, or {candidate:{uid},requestMid,...}.
 * A matching mid blocks regardless of UID/outcome. Same-UID older requests block
 * unless their supplied status/outcome fields are terminal: succeeded, failed,
 * or completed. Missing, unknown, or unfinished outcomes pause new acceptance.
 * Returned IDs are decimal strings; no SDK, fingerprint, file or service access.
 */
export function planResumeAcceptance({ candidate, ownUid, scope, history, requestMid, priorAttempts = [] }) {
  // Validate the complete input representation before reading nested properties.
  const historyBytes = canonicalJson(history);
  canonicalJson({ candidate, ownUid, scope, requestMid, priorAttempts });
  const target = checkedCandidate(candidate, 'candidate');
  const own = safeId(ownUid, 'ownUid');
  const mid = safeId(requestMid, 'requestMid');
  requireValue(own !== target.uid, 'candidate cannot be ownUid');
  record(scope, 'scope');
  requireValue(safeId(scope.jobId, 'scope.jobId') === target.jobId, 'candidate job outside scope');
  requireValue(Array.isArray(scope.targetUids) && scope.targetUids.length > 0,
    'scope.targetUids must be a nonempty array');
  const scopedUids = scope.targetUids.map(uid => safeId(uid, 'scope.targetUids entry'));
  requireValue(scopedUids.includes(target.uid), 'candidate UID outside scope');
  record(history, 'history');
  requireValue(history.complete === true, 'history must be complete');
  const historicalCandidate = checkedCandidate(history.candidate, 'history.candidate');
  requireValue(['uid', 'name', 'jobId'].every(key => target[key] === historicalCandidate[key]),
    'history candidate UID/name/job mismatch');
  requireValue(Array.isArray(history.messages), 'history.messages must be an array');
  const matches = history.messages.filter(message => {
    record(message, 'history message');
    return safeId(message.mid, 'history message.mid') === mid;
  });
  requireValue(matches.length === 1, 'request mid must identify exactly one history message');
  const message = matches[0];
  requireValue(message.type === 1, 'request message.type must be 1');
  record(message.from, 'message.from');
  record(message.to, 'message.to');
  requireValue(safeId(message.from.uid, 'message.from.uid') === target.uid &&
    safeId(message.to.uid, 'message.to.uid') === own, 'request must be inbound from candidate to ownUid');
  if (Object.hasOwn(message.from, 'name')) {
    requireValue(safeName(message.from.name, 'message.from.name') === target.name, 'sender name mismatch');
  }
  for (const owner of [message, message.from, message.body]) {
    record(owner, 'message identity container');
    if (Object.hasOwn(owner, 'jobId')) {
      requireValue(safeId(owner.jobId, 'message jobId') === target.jobId, 'message job mismatch');
    }
  }
  record(message.body, 'message.body');
  requireValue(message.body.type === 7, 'request body.type must be 7');
  const dialog = record(message.body.dialog, 'message.body.dialog');
  requireValue(dialog.type === 2, 'only candidate-initiated resume dialog.type=2 is allowed');
  requireValue(dialog.operated === false || dialog.operated === true, 'dialog.operated must be boolean');
  const attachment = checkedAttachment(dialog, target.uid);
  requireValue(Array.isArray(priorAttempts), 'priorAttempts must be an array');
  const attempts = priorAttempts.map(attempt => {
    record(attempt, 'prior attempt');
    const uid = safeId(attempt.uid ?? attempt.candidate?.uid, 'prior attempt uid');
    if (attempt.candidate !== undefined) {
      record(attempt.candidate, 'prior attempt candidate');
      requireValue(safeId(attempt.candidate.uid, 'prior attempt candidate uid') === uid,
        'conflicting prior attempt identity');
    }
    const outcomeFields = ['status', 'outcome'].filter(key => Object.hasOwn(attempt, key));
    const completed = outcomeFields.length > 0 && outcomeFields.every(key =>
      ['succeeded', 'failed', 'completed'].includes(attempt[key]));
    return { uid, mid: safeId(attempt.requestMid, 'prior attempt requestMid'), completed };
  });
  if (dialog.operated === true) return { action: 'already_operated_noop' };
  requireValue(!attempts.some(attempt => attempt.mid === mid ||
    (attempt.uid === target.uid && !attempt.completed)),
  'prior attempt matches request mid or candidate UID with unknown/unfinished outcome; no retry is allowed');
  return {
    action: 'accept_candidate_resume',
    candidate: target,
    requestMid: mid,
    ...attachment,
    bodySha256: sha256(canonicalJson(message.body)),
    historySha256: sha256(historyBytes),
    request: { mid, type: 3, scene: 1 },
  };
}

/**
 * Caller-provided I/O only. readFreshHistory() returns the planner history shape;
 * readBack() returns {messages:[...]}. writeAttempt(plan) must atomically record
 * the attempt before returning and reject on collision/failure (false also aborts).
 * No operation is retried, including after an unknown accept or read-back outcome.
 */
export async function executeResumeAcceptance(input, { readFreshHistory, writeAttempt, invokeAccept, readBack }) {
  requireValue([readFreshHistory, writeAttempt, invokeAccept, readBack].every(port => typeof port === 'function'),
    'all four I/O ports must be functions');
  const history = await readFreshHistory();
  const plan = planResumeAcceptance({ ...input, history });
  if (plan.action === 'already_operated_noop') return plan;
  const own = safeId(input.ownUid, 'ownUid');
  const attempt = await writeAttempt(plan);
  requireValue(attempt !== false, 'atomic attempt write failed or collided');
  const response = await invokeAccept(plan.request);
  requireValue(response?.code === 0 && response?.zpData?.status === 0,
    'accept response must have code=0 and zpData.status=0; no retry');
  const verifiedHistory = record(await readBack(), 'read-back history');
  requireValue(Array.isArray(verifiedHistory.messages), 'read-back messages must be an array');
  const matches = verifiedHistory.messages.filter(message =>
    message !== null && typeof message === 'object' &&
    (typeof message.mid === 'string' || typeof message.mid === 'number') &&
    String(message.mid) === plan.requestMid);
  requireValue(matches.length === 1, 'read-back must contain exactly one matching request mid');
  const message = record(matches[0], 'read-back message');
  requireValue(safeId(message.mid, 'read-back mid') === plan.requestMid,
    'read-back request mid mismatch');
  record(message.from, 'read-back sender');
  record(message.to, 'read-back recipient');
  requireValue(safeId(message.from.uid, 'read-back sender uid') === plan.candidate.uid &&
    safeId(message.to.uid, 'read-back recipient uid') === own,
  'read-back request must be inbound from candidate to ownUid');
  requireValue(message.body?.dialog?.operated === true,
    'read-back request must have body.dialog.operated=true');
  return { accepted: true, plan };
}
