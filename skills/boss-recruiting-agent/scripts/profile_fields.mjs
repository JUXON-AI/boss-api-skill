const PROFILE_FIELDS = Object.freeze(['age', 'gender', 'school']);
const GENDER_LABELS = new Set(['男', '女', '其他']);
const AGE_MIN = 1;
const AGE_MAX = 120;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const NUMERIC_AGE_PATTERN = /^\d+岁?$/;

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

function isSchoolValue(value) {
  return isNonEmptyString(value) && value.trim() !== '未知';
}

function isIdentifier(value) {
  return isNonEmptyString(value)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function identifiersEqual(left, right) {
  return isIdentifier(left) && isIdentifier(right) && String(left) === String(right);
}

function isMid(value) {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

function validateCandidate(candidate) {
  if (!isObject(candidate)) fail('candidate must be an object');
  if (!isIdentifier(candidate.uid)) fail('candidate.uid is required');
  if (!isNonEmptyString(candidate.name)) fail('candidate.name is required');
  if (!isIdentifier(candidate.jobId)) fail('candidate.jobId is required');
}

function validateSnapshot(snapshot, index) {
  if (!isObject(snapshot)) fail(`snapshots[${index}] must be an object`);
  if (!isNonEmptyString(snapshot.source)) fail(`snapshots[${index}].source is required`);
  if (typeof snapshot.sourceSha256 !== 'string' || !SHA256_PATTERN.test(snapshot.sourceSha256)) {
    fail(`snapshots[${index}].sourceSha256 must be a SHA-256`);
  }
  if (!Array.isArray(snapshot.messages)) fail(`snapshots[${index}].messages must be an array`);
}

function parseMessageTime(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (Number.isInteger(value) && value >= 1_000_000_000 && value < 10_000_000_000) {
      const milliseconds = value * 1000;
      return Number.isFinite(milliseconds) ? milliseconds : null;
    }
    if (Number.isInteger(value) && value >= 1_000_000_000_000 && value <= 8_640_000_000_000_000) {
      return value;
    }
    return null;
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    if (text.length === 10) return numeric * 1000;
    if (text.length === 13) return numeric;
    return null;
  }

  // Require an explicit ISO calendar date and validate its written date before
  // Date.parse can normalize overflow or shift the day for a timezone offset.
  const calendar = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?=$|[Tt\s])/.exec(text);
  if (!calendar) return null;
  const year = Number(calendar[1]);
  const month = Number(calendar[2]);
  const day = Number(calendar[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;

  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  try {
    new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
  return milliseconds;
}

function evidenceFor(snapshot, message, path, rawValue) {
  if (!isMid(message.mid)) fail('resume card message mid is required');
  return {
    source: snapshot.source,
    sourceSha256: snapshot.sourceSha256,
    mid: message.mid,
    path,
    rawValue,
  };
}

function assertResumeIdentity(message, resume, candidate, snapshotIndex, messageIndex) {
  const location = `snapshots[${snapshotIndex}].messages[${messageIndex}]`;
  if (!isObject(message.from) || !identifiersEqual(message.from.uid, candidate.uid)) {
    fail(`${location}: resume card sender uid does not match candidate.uid`);
  }
  if (!isObject(resume.user) || !identifiersEqual(resume.user.uid, candidate.uid)) {
    fail(`${location}: resume user uid does not match candidate.uid`);
  }
  if (!hasOwn(resume, 'jobId') || !identifiersEqual(resume.jobId, candidate.jobId)) {
    fail(`${location}: resume jobId does not match candidate.jobId`);
  }
  if (typeof resume.user.name !== 'string' || resume.user.name !== candidate.name) {
    fail(`${location}: resume user name does not match candidate.name`);
  }
}

function ageObservation(value, evidence) {
  let age = null;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) age = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (NUMERIC_AGE_PATTERN.test(text)) age = Number(text.replace(/岁$/, ''));
  }

  if (age === null || age < AGE_MIN || age > AGE_MAX) {
    return {status: 'unknown', reason: 'invalid_age', evidence};
  }
  return {status: 'value', value: age, evidence};
}

function hasVerifiedGenderMapping(mapping) {
  return isObject(mapping)
    && mapping.verified === true
    && isObject(mapping.values)
    && isNonEmptyString(mapping.source)
    && typeof mapping.sourceSha256 === 'string'
    && SHA256_PATTERN.test(mapping.sourceSha256);
}

function genderObservation(value, evidence, genderMapping) {
  if (typeof value === 'string' && GENDER_LABELS.has(value)) {
    return {status: 'value', value, evidence};
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return {status: 'unknown', reason: 'invalid_gender', evidence};
  }
  if (!hasVerifiedGenderMapping(genderMapping)) {
    return {status: 'unknown', reason: 'unverified_numeric_gender_mapping', evidence};
  }

  const key = String(value);
  if (!hasOwn(genderMapping.values, key)) {
    return {status: 'unknown', reason: 'unmapped_numeric_gender', evidence};
  }
  const label = genderMapping.values[key];
  if (!GENDER_LABELS.has(label)) {
    return {status: 'unknown', reason: 'invalid_gender_mapping_label', evidence};
  }
  return {
    status: 'value',
    value: label,
    evidence: {
      ...evidence,
      genderMapping: {
        source: genderMapping.source,
        sourceSha256: genderMapping.sourceSha256,
        code: value,
        label,
      },
    },
  };
}

function schoolObservation(resume, makeEvidence) {
  const explicit = [];
  let seen = false;

  for (const field of ['school', 'schoolName']) {
    if (!hasOwn(resume, field) || resume[field] === undefined) continue;
    seen = true;
    const rawValue = resume[field];
    const evidence = makeEvidence(`body.resume.${field}`, rawValue);
    if (isSchoolValue(rawValue)) {
      explicit.push({value: rawValue, evidence});
    }
  }

  const explicitValues = new Map();
  for (const item of explicit) {
    if (!explicitValues.has(item.value)) explicitValues.set(item.value, item);
  }
  if (explicitValues.size > 1) {
    return {
      status: 'conflict',
      reason: 'multiple_explicit_schools',
      evidence: [...explicitValues.values()].map(item => item.evidence),
      values: [...explicitValues.keys()],
    };
  }
  if (explicitValues.size === 1) {
    const item = explicitValues.values().next().value;
    return {status: 'value', value: item.value, evidence: item.evidence};
  }

  const experiences = Array.isArray(resume.experiences) ? resume.experiences : [];
  const educationSchools = new Map();
  for (let index = 0; index < experiences.length; index += 1) {
    const experience = experiences[index];
    if (!isObject(experience) || experience.type !== 2) continue;
    seen = true;
    const rawValue = experience.organization;
    const evidence = makeEvidence(`body.resume.experiences[${index}].organization`, rawValue);
    if (isSchoolValue(rawValue) && !educationSchools.has(rawValue)) {
      educationSchools.set(rawValue, evidence);
    }
  }

  if (educationSchools.size > 1) {
    return {
      status: 'conflict',
      reason: 'multiple_schools_without_primary',
      evidence: [...educationSchools.values()],
      values: [...educationSchools.keys()],
    };
  }
  if (educationSchools.size === 1) {
    const [value, evidence] = educationSchools.entries().next().value;
    return {status: 'value', value, evidence};
  }
  if (seen) return {status: 'unknown', reason: 'invalid_school', evidence: null};
  return {status: 'missing'};
}

function collectObservations(candidate, snapshots, genderMapping) {
  const observations = Object.fromEntries(PROFILE_FIELDS.map(field => [field, []]));

  for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
    const snapshot = snapshots[snapshotIndex];
    for (let messageIndex = 0; messageIndex < snapshot.messages.length; messageIndex += 1) {
      const message = snapshot.messages[messageIndex];
      const resume = message?.body?.resume;
      if (!isObject(resume)) continue;

      assertResumeIdentity(message, resume, candidate, snapshotIndex, messageIndex);
      const timeMs = parseMessageTime(message.time);
      const makeEvidence = (path, rawValue) => evidenceFor(snapshot, message, path, rawValue);

      if (hasOwn(resume, 'age') && resume.age !== undefined) {
        const evidence = makeEvidence('body.resume.age', resume.age);
        observations.age.push({
          timeMs,
          ...(timeMs === null
            ? {status: 'unknown', reason: 'invalid_message_time', evidence}
            : ageObservation(resume.age, evidence)),
        });
      }

      if (hasOwn(resume, 'gender') && resume.gender !== undefined) {
        const evidence = makeEvidence('body.resume.gender', resume.gender);
        observations.gender.push({
          timeMs,
          ...(timeMs === null
            ? {status: 'unknown', reason: 'invalid_message_time', evidence}
            : genderObservation(resume.gender, evidence, genderMapping)),
        });
      }

      const school = schoolObservation(resume, makeEvidence);
      if (school.status !== 'missing') {
        observations.school.push({
          timeMs,
          status: timeMs === null ? 'unknown' : school.status,
          reason: timeMs === null ? 'invalid_message_time' : school.reason,
          value: school.value,
          evidence: school.evidence,
          values: school.values,
        });
      }
    }
  }

  return observations;
}

function selectField(field, observations) {
  if (observations.length === 0) return {status: 'unknown', reason: 'missing'};

  // An unsortable observation may be newer than every dated card. Never borrow
  // an older value for that field when its chronology cannot be established.
  if (observations.some(item => item.timeMs === null)) {
    return {status: 'unknown', reason: 'invalid_message_time'};
  }

  const latestTime = observations.reduce((latest, item) => Math.max(latest, item.timeMs), -Infinity);
  const latest = observations.filter(item => item.timeMs === latestTime);
  const valueItems = latest.filter(item => item.status === 'value');
  const values = new Map();
  for (const item of valueItems) {
    if (!values.has(item.value)) values.set(item.value, item);
  }
  const conflicts = latest.filter(item => item.status === 'conflict');

  if (conflicts.length > 0 || values.size > 1) {
    const evidence = [];
    for (const item of [...conflicts, ...valueItems]) {
      if (Array.isArray(item.evidence)) evidence.push(...item.evidence);
      else if (item.evidence) evidence.push(item.evidence);
    }
    return {
      status: 'conflict',
      reason: conflicts[0]?.reason ?? 'same_latest_time_different_values',
      timeMs: latestTime,
      values: [...new Set([...conflicts.flatMap(item => item.values ?? []), ...values.keys()])],
      evidence,
    };
  }

  if (values.size === 1) {
    return values.values().next().value;
  }

  const reasons = [...new Set(latest.map(item => item.reason).filter(Boolean))];
  return {
    status: 'unknown',
    reason: reasons.length === 1 ? reasons[0] : 'unusable_latest_value',
  };
}

/**
 * Extract only source-bound profile fields from resume cards for one candidate.
 * A resume card with any identity mismatch fails the entire extraction.
 * Pure data processing only: the caller's IO layer must verify snapshot hashes
 * against original files and verify the mapping source/hash and its applicability
 * to body.resume.gender before supplying verified:true. That flag is a caller
 * assertion, not proof of authenticity. This module checks structure, not files.
 */
export function extractProfileFields({candidate, snapshots, genderMapping} = {}) {
  validateCandidate(candidate);
  if (!Array.isArray(snapshots)) fail('snapshots must be an array');
  snapshots.forEach(validateSnapshot);

  const observations = collectObservations(candidate, snapshots, genderMapping);
  const values = {};
  const evidence = {};
  const unknown = {};
  const conflicts = [];

  for (const field of PROFILE_FIELDS) {
    const selected = selectField(field, observations[field]);
    if (selected.status === 'value') {
      values[field] = selected.value;
      evidence[field] = selected.evidence;
      continue;
    }
    if (selected.status === 'conflict') {
      conflicts.push({
        field,
        reason: selected.reason,
        time: new Date(selected.timeMs).toISOString(),
        values: selected.values,
        evidence: selected.evidence,
      });
      continue;
    }
    unknown[field] = selected.reason;
  }

  return {
    candidate: {uid: candidate.uid, name: candidate.name, jobId: candidate.jobId},
    values, evidence, unknown, conflicts,
  };
}

function isEmptyCurrentValue(field, value) {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (field !== 'age' && (value === '未知'
      || (Array.isArray(value) && value.length === 1 && value[0] === '未知')));
}

function valuesEqual(currentValue, incomingValue) {
  if (Object.is(currentValue, incomingValue)) return true;
  if (Array.isArray(currentValue) && currentValue.length === 1) {
    return valuesEqual(currentValue[0], incomingValue);
  }
  return false;
}

function validIncomingValue(field, value) {
  if (field === 'age') {
    return typeof value === 'number'
      && Number.isInteger(value)
      && value >= AGE_MIN
      && value <= AGE_MAX;
  }
  if (field === 'gender') return GENDER_LABELS.has(value);
  return isSchoolValue(value);
}

function metadataReason(metadata, field) {
  const conflicts = Array.isArray(metadata?.conflicts) ? metadata.conflicts : [];
  if (conflicts.some(conflict => conflict?.field === field)) return 'extraction_conflict';
  if (isObject(metadata?.unknown)) return metadata.unknown[field] ?? 'not_extracted';
  if (Array.isArray(metadata?.unknown)) {
    const row = metadata.unknown.find(item => item?.field === field);
    return row?.reason ?? 'not_extracted';
  }
  return 'not_extracted';
}

function assertFieldEvidence(field, value, evidence) {
  const invalid = () => fail(`metadata.evidence.${field} must contain complete, value-consistent source evidence`);
  if (!isObject(evidence)
      || !isNonEmptyString(evidence.source)
      || typeof evidence.sourceSha256 !== 'string'
      || !SHA256_PATTERN.test(evidence.sourceSha256)
      || !isMid(evidence.mid)
      || !hasOwn(evidence, 'rawValue')) invalid();

  if (field === 'age') {
    const observed = ageObservation(evidence.rawValue, evidence);
    if (evidence.path !== 'body.resume.age' || observed.status !== 'value' || observed.value !== value) invalid();
  } else if (field === 'gender') {
    if (evidence.path !== 'body.resume.gender') invalid();
    if (typeof evidence.rawValue === 'number') {
      const mapping = evidence.genderMapping;
      if (!Number.isSafeInteger(evidence.rawValue) || evidence.rawValue < 0
          || !isObject(mapping) || !isNonEmptyString(mapping.source)
          || typeof mapping.sourceSha256 !== 'string' || !SHA256_PATTERN.test(mapping.sourceSha256)
          || mapping.code !== evidence.rawValue || mapping.label !== value
          || !GENDER_LABELS.has(mapping.label)) invalid();
    } else if (!GENDER_LABELS.has(evidence.rawValue) || evidence.rawValue !== value) invalid();
  } else {
    if (typeof evidence.path !== 'string'
        || !/^body\.resume\.(school|schoolName|experiences\[(0|[1-9]\d*)\]\.organization)$/.test(evidence.path)
        || !isSchoolValue(evidence.rawValue) || evidence.rawValue !== value) invalid();
  }
}

function assertMetadata(candidate, metadata) {
  if (!isObject(metadata) || !isObject(metadata.values) || !isObject(metadata.evidence)
      || !isObject(metadata.candidate)) {
    fail('metadata must be an extractProfileFields result with candidate, values and evidence');
  }
  validateCandidate(metadata.candidate);
  for (const field of ['uid', 'name', 'jobId']) {
    const matches = field === 'name'
      ? candidate.name === metadata.candidate.name
      : identifiersEqual(candidate[field], metadata.candidate[field]);
    if (!matches) fail(`metadata.candidate.${field} does not match target candidate.${field}`);
  }
  for (const field of PROFILE_FIELDS) {
    if (hasOwn(metadata.values, field)) {
      assertFieldEvidence(field, metadata.values[field], metadata.evidence[field]);
    }
  }
}

/**
 * Build a canonical three-field patch without carrying unrelated metadata.
 * `candidate` is the target identity; `metadata` must be an extractProfileFields
 * result for that same identity with complete evidence for each known field.
 * Missing/mismatched identity or incomplete/inconsistent evidence throws.
 * Evidence validation is structural; original file and mapping authentication
 * belong to the caller's IO layer, as documented on extractProfileFields.
 */
export function planProfileFieldPatch({candidate, currentValues = {}, metadata} = {}) {
  validateCandidate(candidate);
  assertMetadata(candidate, metadata);
  const current = isObject(currentValues) ? currentValues : {};
  const metadataValues = metadata.values;

  const patch = {};
  const unchanged = {};
  const conflicts = [];
  const unavailable = {};

  for (const field of PROFILE_FIELDS) {
    const hasIncoming = hasOwn(metadataValues, field) && metadataValues[field] !== undefined;
    const incomingValue = hasIncoming ? metadataValues[field] : undefined;
    const currentValue = hasOwn(current, field) ? current[field] : undefined;

    if (!hasIncoming || incomingValue === null || incomingValue === '') {
      unavailable[field] = metadataReason(metadata, field);
      continue;
    }
    if (!validIncomingValue(field, incomingValue)) {
      unavailable[field] = 'invalid_incoming_value';
      continue;
    }

    if (isEmptyCurrentValue(field, currentValue)) {
      patch[field] = incomingValue;
    } else if (valuesEqual(currentValue, incomingValue)) {
      unchanged[field] = incomingValue;
    } else {
      conflicts.push({
        field,
        reason: 'non_empty_current_value_differs',
        currentValue,
        incomingValue,
      });
    }
  }

  return {patch, unchanged, conflicts, unavailable};
}
