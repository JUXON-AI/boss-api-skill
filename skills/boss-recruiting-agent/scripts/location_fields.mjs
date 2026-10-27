const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CURRENT_RESIDENCE_KIND = 'current_residence';
const SCHOOL_LOCATION_KIND = 'school_location';
const RESIDENCE_LABEL = '（资料现居地）';
const SCHOOL_DEFAULT_LABEL = '（学校所在地默认）';

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIdentifier(value) {
  return isNonEmptyString(value)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function identifiersEqual(left, right) {
  return isIdentifier(left) && isIdentifier(right) && String(left) === String(right);
}

function validateCandidate(candidate) {
  if (!isObject(candidate)) fail('candidate must be an object');
  if (!isIdentifier(candidate.uid)) fail('candidate.uid is required');
  if (!isNonEmptyString(candidate.name)) fail('candidate.name is required');
  if (!isIdentifier(candidate.jobId)) fail('candidate.jobId is required');
}

function pick(record, evidence, field) {
  if (hasOwn(evidence, field)) return evidence[field];
  return record[field];
}

function validateCommonEvidence(record, label, expectedKind, candidate) {
  if (!isObject(record)) fail(`${label} must be an object`);
  if (record.kind !== expectedKind) fail(`${label}.kind must be ${expectedKind}`);

  let evidence = record;
  if (hasOwn(record, 'evidence')) {
    if (!isObject(record.evidence)) fail(`${label}.evidence must be an object`);
    evidence = record.evidence;
  }

  const uid = pick(record, evidence, 'uid');
  const name = pick(record, evidence, 'name');
  const jobId = pick(record, evidence, 'jobId');
  if (!identifiersEqual(uid, candidate.uid)) fail(`${label} uid does not match candidate.uid`);
  if (typeof name !== 'string' || name !== candidate.name) {
    fail(`${label} name does not match candidate.name`);
  }
  if (!identifiersEqual(jobId, candidate.jobId)) fail(`${label} jobId does not match candidate.jobId`);

  const source = pick(record, evidence, 'source');
  if (!isNonEmptyString(source)) fail(`${label} source is required`);
  const sourceSha256 = pick(record, evidence, 'sourceSha256');
  if (typeof sourceSha256 !== 'string' || !SHA256_PATTERN.test(sourceSha256)) {
    fail(`${label} sourceSha256 must be a 64-character SHA-256`);
  }

  return {
    evidence,
    source,
    sourceSha256,
    location: pick(record, evidence, 'location'),
  };
}

function validateCurrentResidence(candidate, currentResidence) {
  if (currentResidence === undefined || currentResidence === null) return null;
  const common = validateCommonEvidence(
    currentResidence,
    'currentResidence',
    CURRENT_RESIDENCE_KIND,
    candidate,
  );
  if (!isNonEmptyString(common.location)) fail('currentResidence location is required');
  return {
    kind: CURRENT_RESIDENCE_KIND,
    uid: candidate.uid,
    name: candidate.name,
    jobId: candidate.jobId,
    source: common.source,
    sourceSha256: common.sourceSha256,
    location: common.location.trim(),
  };
}

function isHttpSourceUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

function validateSchoolDefault(candidate, schoolDefault) {
  if (schoolDefault === undefined || schoolDefault === null) return null;
  const common = validateCommonEvidence(
    schoolDefault,
    'schoolDefault',
    SCHOOL_LOCATION_KIND,
    candidate,
  );
  const school = pick(schoolDefault, common.evidence, 'school');
  if (!isNonEmptyString(school)) fail('schoolDefault school is required');
  const sourceURL = pick(schoolDefault, common.evidence, 'sourceURL');
  if (!isHttpSourceUrl(sourceURL)) {
    fail('schoolDefault sourceURL must be an official HTTP(S) geography source URL');
  }
  const ambiguity = pick(schoolDefault, common.evidence, 'ambiguity');
  if (ambiguity !== undefined && typeof ambiguity !== 'boolean') {
    fail('schoolDefault ambiguity must be a boolean when provided');
  }

  return {
    kind: SCHOOL_LOCATION_KIND,
    uid: candidate.uid,
    name: candidate.name,
    jobId: candidate.jobId,
    source: common.source,
    sourceSha256: common.sourceSha256,
    location: isNonEmptyString(common.location) ? common.location.trim() : null,
    school: school.trim(),
    sourceURL,
    ambiguity: ambiguity === true,
  };
}

function existingLocation(currentValue) {
  return currentValue !== undefined
    && currentValue !== null
    && (typeof currentValue !== 'string' || currentValue.trim().length > 0);
}

/**
 * Plan a fill-only location patch from structurally verified evidence.
 *
 * Evidence may be flat or nested under `evidence`. Both kinds bind the exact
 * candidate uid, name, and jobId to a non-empty source, a SHA-256, and a
 * location. schoolDefault additionally needs the school, an official HTTP(S)
 * geography sourceURL, and ambiguity state. This pure function does not read
 * source bytes; actual digest and source-authenticity checks stay in the caller.
 *
 * The field is descriptive only and must not be used for scoring.
 */
export function planLocationFieldPatch({
  candidate,
  currentValue,
  currentResidence,
  schoolDefault,
  useSchoolDefault = false,
} = {}) {
  validateCandidate(candidate);
  if (typeof useSchoolDefault !== 'boolean') fail('useSchoolDefault must be a boolean');

  // Validate every supplied source so malformed evidence cannot hide behind
  // the residence-priority path.
  const residence = validateCurrentResidence(candidate, currentResidence);
  const school = validateSchoolDefault(candidate, schoolDefault);

  let incoming = null;
  let unknownReason;
  if (residence) {
    incoming = {
      value: `${residence.location}${RESIDENCE_LABEL}`,
      status: 'confirmed',
      evidence: residence,
    };
  } else if (!useSchoolDefault) {
    unknownReason = school ? 'school_default_not_enabled' : 'current_residence_missing';
  } else if (!school || school.ambiguity || !school.location) {
    unknownReason = 'school_location_unverified';
  } else {
    incoming = {
      value: `${school.location}${SCHOOL_DEFAULT_LABEL}`,
      status: 'school_default',
      evidence: school,
    };
  }

  if (existingLocation(currentValue)) {
    if (!incoming) {
      return {
        patch: {},
        status: 'unchanged',
        evidence: null,
        reason: 'existing_value_preserved',
      };
    }
    const unchanged = currentValue === incoming.value;
    return {
      patch: {},
      status: unchanged ? 'unchanged' : 'conflict',
      evidence: incoming.evidence,
      reason: unchanged ? 'current_value_matches' : 'non_empty_current_value_differs',
    };
  }

  if (!incoming) {
    return {patch: {}, status: 'unknown', evidence: null, reason: unknownReason};
  }

  return {
    patch: {'现居地': incoming.value},
    status: incoming.status,
    evidence: incoming.evidence,
  };
}
