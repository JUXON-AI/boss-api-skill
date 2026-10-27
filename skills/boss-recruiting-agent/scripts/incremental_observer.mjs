import crypto from 'node:crypto';

const DEFAULT_FULL_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const SENSITIVE_METADATA_KEY_RE = /(?:security|token|secret|credential|cookie|authorization|signature|signed|encrypt|session|password|access|refresh)/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validUid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validJobId(value) {
  return (typeof value === 'string' && value.trim() !== '') || (Number.isSafeInteger(value) && value >= 0);
}

function validName(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function jobKey(value) {
  return String(value);
}

function identityKey(candidate) {
  return `${encodeURIComponent(jobKey(candidate.jobId))}::${candidate.uid}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function safeIssue(code, message, details = {}) {
  const issue = {code, message};
  if (validUid(details.uid)) issue.uid = details.uid;
  if (validName(details.name)) issue.name = details.name;
  if (validJobId(details.jobId)) issue.jobId = details.jobId;
  if (Number.isSafeInteger(details.mid) && details.mid > 0) issue.mid = details.mid;
  return issue;
}

function normalizeCandidate(value, code, issues, label) {
  if (!isObject(value)) {
    issues.push(safeIssue(code, `${label} must be an object`));
    return null;
  }
  if (!validUid(value.uid)) {
    issues.push(safeIssue(code, `${label}.uid must be a positive safe integer`, value));
    return null;
  }
  if (!validName(value.name)) {
    issues.push(safeIssue(code, `${label}.name must be a nonempty string`, value));
    return null;
  }
  if (!validJobId(value.jobId)) {
    issues.push(safeIssue(code, `${label}.jobId must be a nonempty string or nonnegative safe integer`, value));
    return null;
  }
  return {uid: value.uid, name: value.name, jobId: value.jobId};
}

function sanitizeMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!isObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_METADATA_KEY_RE.test(key)) continue;
    if (value[key] === undefined) continue;
    output[key] = sanitizeMetadata(value[key]);
  }
  return output;
}

function contactMetadataFingerprint(contact) {
  return sha256(JSON.stringify(canonical(sanitizeMetadata({
    uid: contact.uid,
    name: contact.name,
    jobId: contact.jobId,
    lastTS: contact.lastTS ?? null,
    relationType: contact.relationType ?? null,
    ...Object.fromEntries(Object.entries(contact).filter(([key]) => !['uid', 'name', 'jobId', 'lastTS', 'relationType'].includes(key))),
  }))));
}

function normalizeMids(value, code, issues, label) {
  if (!Array.isArray(value)) {
    issues.push(safeIssue(code, `${label} must be an array`));
    return null;
  }
  const seen = new Set();
  const mids = [];
  for (const mid of value) {
    if (!Number.isSafeInteger(mid) || mid <= 0) {
      issues.push(safeIssue(code, `${label} contains an invalid message mid`));
      return null;
    }
    if (seen.has(mid)) {
      issues.push(safeIssue(code, `${label} contains duplicate message mids`, {mid}));
      return null;
    }
    seen.add(mid);
    mids.push(mid);
  }
  return mids.sort((a, b) => a - b);
}

function normalizeCheckpoint(checkpoint, issues) {
  const empty = {version: 1, entries: {}};
  if (checkpoint === undefined || checkpoint === null) return empty;
  if (!isObject(checkpoint)) {
    issues.push(safeIssue('invalid_checkpoint', 'checkpoint must be an object'));
    return empty;
  }
  if (checkpoint.entries === undefined && Object.keys(checkpoint).length === 0) return empty;
  if (!isObject(checkpoint.entries)) {
    issues.push(safeIssue('invalid_checkpoint', 'checkpoint.entries must be an object'));
    return empty;
  }
  const entries = {};
  for (const [key, entry] of Object.entries(checkpoint.entries)) {
    if (!isObject(entry)) {
      issues.push(safeIssue('invalid_checkpoint_entry', 'checkpoint entry must be an object'));
      continue;
    }
    const candidate = normalizeCandidate(entry.candidate, 'invalid_checkpoint_entry', issues, 'checkpoint candidate');
    if (!candidate) continue;
    if (key !== identityKey(candidate)) {
      issues.push(safeIssue('invalid_checkpoint_key', 'checkpoint key must bind the entry jobId and UID', candidate));
      continue;
    }
    const metadataFingerprint = entry.metadataFingerprint;
    const mids = normalizeMids(entry.mids, 'invalid_checkpoint_entry', issues, 'checkpoint mids');
    if (!FINGERPRINT_RE.test(metadataFingerprint ?? '') || mids === null || !Number.isFinite(entry.lastFullScanAt) || entry.lastFullScanAt < 0) {
      issues.push(safeIssue('invalid_checkpoint_entry', 'checkpoint entry has invalid fingerprint, mids, or watermark', candidate));
      continue;
    }
    entries[key] = {candidate, metadataFingerprint, mids, lastFullScanAt: entry.lastFullScanAt};
  }
  return {version: 1, entries};
}

function normalizeCurrentContacts(contacts, currentJobId, issues) {
  const valid = [];
  const blockedUids = new Set();
  const currentByUid = new Map();
  if (!Array.isArray(contacts)) {
    issues.push(safeIssue('invalid_contacts', 'contacts must be an array'));
    return {valid, blockedUids};
  }
  for (const contact of contacts) {
    const candidate = normalizeCandidate(contact, 'invalid_contact', issues, 'contact');
    if (!candidate) continue;
    if (!Number.isFinite(contact.lastTS)) {
      issues.push(safeIssue('invalid_contact', 'contact.lastTS must be a finite number', candidate));
      continue;
    }
    if (!Number.isSafeInteger(contact.relationType)) {
      issues.push(safeIssue('invalid_contact', 'contact.relationType must be a safe integer', candidate));
      continue;
    }
    const normalized = {...candidate, lastTS: contact.lastTS, relationType: contact.relationType};
    valid.push({raw: contact, normalized});
    if (jobKey(candidate.jobId) !== jobKey(currentJobId)) continue;
    const rows = currentByUid.get(candidate.uid) ?? [];
    rows.push(normalized);
    currentByUid.set(candidate.uid, rows);
  }
  for (const [uid, rows] of currentByUid) {
    const fingerprints = new Set(rows.map(contactMetadataFingerprint));
    if (fingerprints.size > 1) {
      blockedUids.add(uid);
      issues.push(safeIssue('duplicate_contact_conflict', 'conflicting contacts for the same UID and current job are not trusted', rows[0]));
    }
  }
  return {valid, blockedUids};
}

function findCurrentContact(validContacts, candidate, currentJobId) {
  return validContacts.filter(contact => contact.normalized.uid === candidate.uid
    && contact.normalized.name === candidate.name
    && jobKey(contact.normalized.jobId) === jobKey(currentJobId));
}

export function planIncremental({
  contacts,
  scope,
  checkpoint = {},
  now = Date.now(),
  fullScanIntervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
  jobId,
}) {
  const issues = [];
  const reads = [];
  const newCandidates = [];
  if (!validJobId(jobId)) {
    issues.push(safeIssue('invalid_job_id', 'jobId must be a nonempty string or nonnegative safe integer'));
    return {reads, newCandidates, issues};
  }
  if (!Number.isFinite(now) || now < 0) {
    issues.push(safeIssue('invalid_now', 'now must be a nonnegative finite number'));
    return {reads, newCandidates, issues};
  }
  if (!Number.isFinite(fullScanIntervalMs) || fullScanIntervalMs <= 0) {
    issues.push(safeIssue('invalid_full_scan_interval', 'fullScanIntervalMs must be a positive finite number'));
    return {reads, newCandidates, issues};
  }

  const checkpointState = normalizeCheckpoint(checkpoint, issues);
  const checkpointByKey = new Map(Object.entries(checkpointState.entries));
  const current = normalizeCurrentContacts(contacts, jobId, issues);
  const normalizedScope = [];
  const blockedScopeUids = new Set();
  const scopeByUid = new Map();
  if (!Array.isArray(scope)) {
    issues.push(safeIssue('invalid_scope', 'scope must be an array'));
    return {reads, newCandidates, issues};
  }
  for (const value of scope) {
    const candidate = normalizeCandidate(value, 'invalid_scope_identity', issues, 'scope identity');
    if (!candidate) continue;
    normalizedScope.push(candidate);
    const rows = scopeByUid.get(candidate.uid) ?? [];
    rows.push(candidate);
    scopeByUid.set(candidate.uid, rows);
  }
  for (const [uid, rows] of scopeByUid) {
    const keys = new Set(rows.map(identityKey));
    const conflictingSameKey = [...keys].some(key => (
      new Set(rows.filter(row => identityKey(row) === key).map(row => row.name)).size > 1
    ));
    if (keys.size > 1 || conflictingSameKey) {
      blockedScopeUids.add(uid);
      issues.push(safeIssue('duplicate_scope_conflict', 'conflicting scope identities for one UID are not trusted', {uid}));
    }
  }
  const uniqueScope = [];
  const uniqueScopeKeys = new Set();
  for (const candidate of normalizedScope) {
    const key = JSON.stringify([jobKey(candidate.jobId), candidate.uid, candidate.name]);
    if (uniqueScopeKeys.has(key)) continue;
    uniqueScopeKeys.add(key);
    uniqueScope.push(candidate);
  }

  for (const candidate of uniqueScope) {
    if (blockedScopeUids.has(candidate.uid) || current.blockedUids.has(candidate.uid)) continue;
    const matches = findCurrentContact(current.valid, candidate, jobId);
    if (matches.length !== 1) {
      issues.push(safeIssue('identity_mismatch', 'scope UID/name/job does not have exactly one trusted current-job contact', candidate));
      continue;
    }
    const contact = matches[0].raw;
    const fingerprint = contactMetadataFingerprint(contact);
    const existing = checkpointByKey.get(identityKey(candidate));
    let reason = null;
    if (!existing) reason = 'no_checkpoint';
    else if (existing.candidate.name !== candidate.name || existing.metadataFingerprint !== fingerprint) reason = 'metadata_changed';
    else if (now < existing.lastFullScanAt || now - existing.lastFullScanAt >= fullScanIntervalMs) reason = 'full_scan_due';
    if (reason) reads.push({candidate, reason, metadataFingerprint: fingerprint});
  }

  const scopeUids = new Set(uniqueScope.map(candidate => candidate.uid));
  const emittedNewUids = new Set();
  for (const contact of current.valid) {
    const candidate = contact.normalized;
    if (jobKey(candidate.jobId) !== jobKey(jobId) || candidate.relationType !== 5) continue;
    if (scopeUids.has(candidate.uid) || current.blockedUids.has(candidate.uid) || emittedNewUids.has(candidate.uid)) continue;
    emittedNewUids.add(candidate.uid);
    newCandidates.push({uid: candidate.uid, name: candidate.name, jobId: candidate.jobId});
  }

  return {reads, newCandidates, issues};
}
export function commitObservations({checkpoint = {}, successes, now = Date.now()}) {
  const issues = [];
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint, issues);
  if (!Number.isFinite(now) || now < 0 || !Array.isArray(successes)) return normalizedCheckpoint;

  const entries = new Map(Object.entries(normalizedCheckpoint.entries));
  const acceptedByKey = new Map();
  for (const success of successes) {
    if (!isObject(success) || success.complete !== true) continue;
    const candidate = normalizeCandidate(success.candidate, 'invalid_success', issues, 'success candidate');
    if (!candidate || !FINGERPRINT_RE.test(success.metadataFingerprint ?? '')) continue;
    const mids = normalizeMids(success.mids, 'invalid_success', issues, 'success mids');
    if (mids === null) continue;
    const key = identityKey(candidate);
    const accepted = acceptedByKey.get(key) ?? [];
    accepted.push({candidate, metadataFingerprint: success.metadataFingerprint, mids});
    acceptedByKey.set(key, accepted);
  }

  for (const [key, accepted] of acceptedByKey) {
    const fingerprints = new Set(accepted.map(item => item.metadataFingerprint));
    const names = new Set(accepted.map(item => item.candidate.name));
    if (fingerprints.size !== 1 || names.size !== 1) continue;
    const previous = entries.get(key);
    const candidate = accepted[0].candidate;
    if (previous && previous.candidate.name !== candidate.name) continue;
    const mids = [...new Set([...(previous?.mids ?? []), ...accepted.flatMap(item => item.mids)])].sort((a, b) => a - b);
    entries.set(key, {
      candidate: {uid: candidate.uid, name: candidate.name, jobId: candidate.jobId},
      metadataFingerprint: accepted[0].metadataFingerprint,
      mids,
      lastFullScanAt: now,
    });
  }

  const sorted = [...entries.entries()].sort(([leftKey, left], [rightKey, right]) => (
    jobKey(left.candidate.jobId).localeCompare(jobKey(right.candidate.jobId))
    || left.candidate.uid - right.candidate.uid
    || leftKey.localeCompare(rightKey)
  ));
  return {version: 1, entries: Object.fromEntries(sorted)};
}
function attachmentFields(body) {
  const fields = [];
  if (isObject(body.hyperLink) && typeof body.hyperLink.url === 'string' && body.hyperLink.url) fields.push('hyperLink');
  for (const key of ['attachment', 'attachmentInfo', 'file', 'image', 'resume']) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== false) fields.push(key);
  }
  return fields;
}

function platformType(message, body) {
  const values = [body.platformType, body.eventType, body.noticeType, body.systemType, message.platformType, message.eventType];
  const value = values.find(item => typeof item === 'string' && item.trim() !== '');
  if (value) return value;
  // Observed normal-client wire cards. They remain platform data and never
  // become text acceptance evidence or permission to operate their buttons.
  if (body.type === 4 && isObject(body.action) && Number.isSafeInteger(body.action.aid) && body.action.aid > 0) return 'boss_action';
  if (body.type === 7 && isObject(body.dialog) && body.dialog.type === 2
    && typeof body.dialog.operated === 'boolean' && Array.isArray(body.dialog.buttons)) return 'boss_dialog';
  return null;
}

export function diffInbound({candidate, messages, previousMids = [], handledMids = []}) {
  const issues = [];
  const candidateTextMids = [];
  const platformMids = [];
  const normalizedCandidate = normalizeCandidate(candidate, 'invalid_candidate', issues, 'candidate');
  if (!normalizedCandidate) return {candidateTextMids, platformMids, issues};

  const previous = normalizeMids(previousMids, 'invalid_previous_mids', issues, 'previousMids');
  const handled = normalizeMids(handledMids, 'invalid_handled_mids', issues, 'handledMids');
  if (previous === null || handled === null) return {candidateTextMids, platformMids, issues};
  if (!Array.isArray(messages)) {
    issues.push(safeIssue('invalid_messages', 'messages must be an array'));
    return {candidateTextMids, platformMids, issues};
  }

  const midCounts = new Map();
  for (const message of messages) {
    if (isObject(message) && Number.isSafeInteger(message.mid) && message.mid > 0) {
      midCounts.set(message.mid, (midCounts.get(message.mid) ?? 0) + 1);
    }
  }
  const known = new Set([...previous, ...handled]);
  for (const message of messages) {
    if (!isObject(message)) {
      issues.push(safeIssue('unknown_message_structure', 'message must be an object'));
      continue;
    }
    if (!Number.isSafeInteger(message.mid) || message.mid <= 0) {
      issues.push(safeIssue('unknown_message_structure', 'message.mid must be a positive safe integer'));
      continue;
    }
    const mid = message.mid;
    const duplicate = (midCounts.get(mid) ?? 0) > 1;
    if (duplicate) issues.push(safeIssue('duplicate_message_mid', 'message mids must be unique', {mid}));

    const fromUid = message.from?.uid;
    const toUid = message.to?.uid;
    if (!validUid(fromUid) || !validUid(toUid) || fromUid === toUid) {
      issues.push(safeIssue('unknown_message_structure', 'message.from.uid and message.to.uid must identify two participants', {mid}));
      continue;
    }
    const inbound = fromUid === normalizedCandidate.uid;
    const outbound = toUid === normalizedCandidate.uid;
    if (!inbound && !outbound) {
      issues.push(safeIssue('message_identity_mismatch', 'message participants do not include the selected candidate', {mid}));
      continue;
    }

    const body = message.body;
    if (!isObject(body)) {
      issues.push(safeIssue('unknown_message_structure', 'message.body must be an object', {mid}));
      continue;
    }
    if (body.text !== undefined && typeof body.text !== 'string') {
      issues.push(safeIssue('unknown_message_structure', 'message.body.text must be a string when present', {mid}));
      continue;
    }
    const bodyText = typeof body.text === 'string' ? body.text : '';
    const hasText = bodyText.trim() !== '';
    const hasAttachment = attachmentFields(body).length > 0;
    const hasPlatform = platformType(message, body) !== null;
    if (!hasText && !hasAttachment && !hasPlatform) {
      issues.push(safeIssue('unknown_message_structure', 'message body is neither text, attachment, nor a known platform event', {mid}));
      continue;
    }
    if (!inbound || known.has(mid) || duplicate) continue;
    if (hasText && !hasAttachment && !hasPlatform) candidateTextMids.push(mid);
    else platformMids.push(mid);
  }

  return {
    candidateTextMids: [...new Set(candidateTextMids)].sort((a, b) => a - b),
    platformMids: [...new Set(platformMids)].sort((a, b) => a - b),
    issues,
  };
}


