const SHA256 = /^[a-f0-9]{64}$/i;
const DEGREE_FIELDS = Object.freeze(['degree', 'education', 'degreeName', 'educationName']);
const SCHOOL_FIELDS = Object.freeze(['school', 'schoolName']);
const DEGREES = new Map([
  ['专科', '专科'], ['大专', '专科'], ['本科', '本科'], ['硕士', '硕士'], ['博士', '博士'],
]);
const MAIN_RANK_CATEGORY = '中国大学排名（主榜）';

function fail(message) {
  throw new Error(`talent_education_fields: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function sameId(left, right) {
  return isIdentifier(left) && isIdentifier(right) && String(left) === String(right);
}

function validateInput({candidate, snapshot, source, sourceSha256, identityAlias}) {
  if (!isObject(candidate) || !isIdentifier(candidate.uid)
      || typeof candidate.name !== 'string' || !candidate.name.trim()
      || !isIdentifier(candidate.jobId)) {
    fail('candidate UID, name, and jobId are required');
  }
  if (!isObject(snapshot)) fail('snapshot must be an object');
  if (typeof source !== 'string' || !source.trim()) fail('source is required');
  if (typeof sourceSha256 !== 'string' || !SHA256.test(sourceSha256)) {
    fail('sourceSha256 must be a 64-character SHA-256');
  }
  if (identityAlias !== undefined) {
    if (!isObject(identityAlias)) fail('identityAlias must be an object');
    if (!sameId(identityAlias.uid, candidate.uid)) fail('identityAlias UID mismatch');
    if (!sameId(identityAlias.jobId, candidate.jobId)) fail('identityAlias jobId mismatch');
    if (identityAlias.candidateName !== candidate.name) fail('identityAlias candidateName mismatch');
    if (typeof identityAlias.profileName !== 'string' || !identityAlias.profileName.trim()) {
      fail('identityAlias profileName is required');
    }
    if (identityAlias.source !== source) fail('identityAlias source mismatch');
    if (identityAlias.sourceSha256 !== sourceSha256) fail('identityAlias sourceSha256 mismatch');
    if (!isIdentifier(identityAlias.mid)) fail('identityAlias mid is required');
    if (!isObject(snapshot.candidate)) fail('identityAlias requires snapshot.candidate');
    if (!sameId(snapshot.candidate.uid, candidate.uid)) fail('snapshot candidate UID mismatch');
    if (snapshot.candidate.name !== candidate.name) fail('snapshot candidate name mismatch');
    if (!sameId(snapshot.candidate.jobId, candidate.jobId)) fail('snapshot candidate jobId mismatch');
  }

  const checkIdentity = (record, uidKey, nameKey, jobKey, label) => {
    if (!isObject(record)) return;
    if (record[uidKey] !== undefined && !sameId(record[uidKey], candidate.uid)) {
      fail(`${label} UID mismatch`);
    }
    if (record[nameKey] !== undefined && record[nameKey] !== candidate.name) {
      fail(`${label} name mismatch`);
    }
    if (record[jobKey] !== undefined && !sameId(record[jobKey], candidate.jobId)) {
      fail(`${label} jobId mismatch`);
    }
  };
  checkIdentity(snapshot.candidate, 'uid', 'name', 'jobId', 'snapshot candidate');
  const identity = snapshot.identity ?? snapshot.history?.identity;
  if (isObject(identity)) {
    checkIdentity(identity, 'candidateUid', 'candidateName', 'candidateJobId', 'snapshot identity');
    checkIdentity(identity, 'uid', 'name', 'jobId', 'snapshot identity');
  }

  const messages = snapshot.history?.original_order_redacted
    ?? snapshot.history?.originalOrderRedacted
    ?? snapshot.history?.messages
    ?? snapshot.response?.zpData?.messages
    ?? snapshot.zpData?.messages
    ?? snapshot.messages;
  if (!Array.isArray(messages)) fail('recognized snapshot messages array is required');
  const cards = messages.filter(message => message?.body
    && Object.prototype.hasOwnProperty.call(message.body, 'resume'));
  if (cards.length === 0) fail('a resume card with exact candidate identity is required');
  let aliasCard;
  if (identityAlias !== undefined) {
    const matchingMid = cards.filter(message => sameId(message.mid, identityAlias.mid));
    if (matchingMid.length !== 1) fail('identityAlias mid must identify exactly one resume card');
    [aliasCard] = matchingMid;
  }

  for (const message of cards) {
    const resume = message.body.resume;
    if (!isObject(resume)) fail('resume card must contain an object');
    if (!sameId(message.from?.uid, candidate.uid)) fail('resume sender UID mismatch');
    if (!sameId(resume.user?.uid, candidate.uid)) fail('resume user UID mismatch');
    const expectedName = message === aliasCard ? identityAlias.profileName : candidate.name;
    if (typeof resume.user?.name !== 'string' || resume.user.name !== expectedName) {
      fail(message === aliasCard ? 'identityAlias profileName mismatch' : 'resume user name mismatch');
    }
    if (!sameId(resume.jobId, candidate.jobId)) fail('resume jobId mismatch');
  }
  return {cards, aliasCard};
}

function makeEvidence(source, sourceSha256, message, path, rawValue, identityAlias) {
  const aliasEvidence = identityAlias && {
    uid: identityAlias.uid,
    jobId: identityAlias.jobId,
    candidateName: identityAlias.candidateName,
    profileName: identityAlias.profileName,
    source: identityAlias.source,
    sourceSha256: identityAlias.sourceSha256,
    mid: identityAlias.mid,
  };
  return {
    source,
    sourceSha256,
    ...(message.mid !== undefined ? {mid: message.mid} : {}),
    path,
    rawValue,
    ...(aliasEvidence ? {identityAlias: aliasEvidence} : {}),
  };
}

function schoolValue(value) {
  return typeof value === 'string' && value.trim() && value.trim() !== '未知' ? value : undefined;
}

function selectObservation(field, observations, missingReason, invalidReason) {
  const distinct = new Map();
  for (const item of observations) {
    if (item.value !== undefined && !distinct.has(item.value)) distinct.set(item.value, []);
    if (item.value !== undefined) distinct.get(item.value).push(item.evidence);
  }
  if (distinct.size > 1) {
    return {
      conflict: {
        field,
        reason: `conflicting_explicit_${field}`,
        values: [...distinct.keys()],
        evidence: observations.filter(item => item.value !== undefined).map(item => item.evidence),
      },
    };
  }
  if (distinct.size === 1) {
    const [value, evidence] = distinct.entries().next().value;
    return {value, evidence};
  }
  return {unknown: observations.length ? invalidReason : missingReason};
}

/** Extract explicit degree and school strings from resume cards bound to one candidate. */
export function extractEducation({candidate, snapshot, source, sourceSha256, identityAlias} = {}) {
  const {cards, aliasCard} = validateInput({candidate, snapshot, source, sourceSha256, identityAlias});
  const observations = {degree: [], school: []};

  for (const message of cards) {
    const resume = message.body.resume;
    const aliasEvidence = message === aliasCard ? identityAlias : undefined;
    for (const field of DEGREE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(resume, field) || resume[field] === undefined) continue;
      const rawValue = resume[field];
      const value = typeof rawValue === 'string' ? DEGREES.get(rawValue.trim()) : undefined;
      observations.degree.push({
        value,
        evidence: makeEvidence(source, sourceSha256, message, `body.resume.${field}`, rawValue, aliasEvidence),
      });
    }
    const explicitSchools = [];
    for (const field of SCHOOL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(resume, field) || resume[field] === undefined) continue;
      const rawValue = resume[field];
      const value = schoolValue(rawValue);
      explicitSchools.push({
        value,
        evidence: makeEvidence(source, sourceSha256, message, `body.resume.${field}`, rawValue, aliasEvidence),
      });
    }
    observations.school.push(...explicitSchools);
    const hasExplicitSchool = explicitSchools.some(item => item.value !== undefined);
    if (!hasExplicitSchool && Array.isArray(resume.experiences)) {
      resume.experiences.forEach((experience, index) => {
        if (!isObject(experience) || experience.type !== 2) return;
        const rawValue = experience.organization;
        const value = schoolValue(rawValue);
        observations.school.push({
          value,
          evidence: makeEvidence(source, sourceSha256, message,
            `body.resume.experiences[${index}].organization`, rawValue, aliasEvidence),
        });
      });
    }
  }

  const degree = selectObservation('degree', observations.degree,
    'missing_explicit_degree', 'unrecognized_explicit_degree');
  const school = selectObservation('school', observations.school,
    'missing_explicit_school', 'unrecognized_explicit_school');
  const values = {};
  const evidence = {};
  const unknown = {};
  const conflicts = [];
  for (const [field, selected] of [['degree', degree], ['school', school]]) {
    if (selected.value !== undefined) {
      values[field] = selected.value;
      evidence[field] = selected.evidence;
    }
    if (selected.unknown) unknown[field] = selected.unknown;
    if (selected.conflict) conflicts.push(selected.conflict);
  }
  return {
    candidate: {uid: candidate.uid, name: candidate.name, jobId: candidate.jobId},
    values,
    evidence,
    unknown,
    conflicts,
  };
}

function parseRank(rank) {
  if (Number.isSafeInteger(rank) && rank > 0) return rank;
  if (typeof rank !== 'string') return undefined;
  const text = rank.trim();
  const lowerBound = /^([1-9]\d*)\+$/.exec(text);
  if (lowerBound && Number.isSafeInteger(Number(lowerBound[1]))) return text;
  const range = /^([1-9]\d*)\s*([-–—])\s*([1-9]\d*)$/.exec(text);
  if (!range || !Number.isSafeInteger(Number(range[1])) || !Number.isSafeInteger(Number(range[3]))
      || Number(range[1]) > Number(range[3])) return undefined;
  return text.replace(/\s*([-–—])\s*/, '$1');
}

function validateRank(rank, label) {
  const parsed = parseRank(rank);
  if (parsed === undefined) {
    fail(`${label} rank must be a positive integer, explicit range, or lower bound`);
  }
  return parsed;
}

function validateRanking(ranking) {
  if (!isObject(ranking) || ranking.year !== 2026) fail('ranking year must be 2026');
  if (typeof ranking.category !== 'string' || !ranking.category.trim()) fail('ranking category is required');
  if (typeof ranking.sourceSha256 !== 'string' || !SHA256.test(ranking.sourceSha256)) {
    fail('ranking sourceSha256 must be a 64-character SHA-256');
  }
  if (typeof ranking.sourceUrl !== 'string') fail('ranking sourceUrl must use the official ranking site');
  let url;
  try {
    url = new URL(ranking.sourceUrl);
  } catch {
    fail('ranking sourceUrl must use the official ranking site');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.shanghairanking.cn'
      || url.username || url.password || url.pathname === '/') {
    fail('ranking sourceUrl must use an official https://www.shanghairanking.cn/ path');
  }
  if (!Array.isArray(ranking.entries)) fail('ranking entries must be an array');
  const entries = ranking.entries.map((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name.trim()
        || entry.name !== entry.name.trim()) {
      fail(`ranking entries[${index}] must have an exact school name`);
    }
    return {name: entry.name, rank: validateRank(entry.rank, `ranking entries[${index}]`)};
  });
  return {...ranking, entries};
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

function currentDegree(value) {
  if (Array.isArray(value) && value.length === 1) [value] = value;
  return typeof value === 'string' ? DEGREES.get(value.trim()) : undefined;
}

function currentSchoolMatches(value, school, category) {
  if (value === school) return true;
  if (typeof value !== 'string') return false;
  const prefix = `${school}（`;
  if (!value.startsWith(prefix) || !value.endsWith('）')) return false;
  let currentRank = value.slice(prefix.length, -1).trim();
  const categorySuffix = `，${category}`;
  if (currentRank.endsWith(categorySuffix)) currentRank = currentRank.slice(0, -categorySuffix.length);
  const numeric = /^[1-9]\d*$/.test(currentRank) && Number.isSafeInteger(Number(currentRank));
  return numeric || parseRank(currentRank) !== undefined;
}

/** Build fill-only education fields using an already verified 2026 ranking object. */
export function buildEducationRankPatch({
  candidate, snapshot, source, sourceSha256, identityAlias, currentValues = {}, ranking,
} = {}) {
  if (!isObject(currentValues)) fail('currentValues must be an object');
  const extracted = extractEducation({candidate, snapshot, source, sourceSha256, identityAlias});
  const verifiedRanking = validateRanking(ranking);
  const patch = {};
  const evidence = {};
  const conflicts = extracted.conflicts.map(item => ({
    ...item,
    field: item.field === 'degree' ? '学历' : '院校',
  }));
  const unavailable = {};

  if (extracted.values.degree === undefined) {
    unavailable['学历'] = extracted.unknown.degree ?? 'conflicting_explicit_degree';
  } else {
    const current = currentValues['学历'];
    if (isEmpty(current)) {
      patch['学历'] = extracted.values.degree;
      evidence['学历'] = extracted.evidence.degree;
    } else if (currentDegree(current) === extracted.values.degree) {
      evidence['学历'] = extracted.evidence.degree;
    } else {
      conflicts.push({field: '学历', reason: 'current_degree_mismatch', current, value: extracted.values.degree,
        evidence: extracted.evidence.degree});
    }
  }

  const school = extracted.values.school;
  if (school === undefined) {
    unavailable['院校'] = extracted.unknown.school ?? 'conflicting_explicit_school';
  } else {
    const current = currentValues['院校'];
    if (!isEmpty(current) && !currentSchoolMatches(current, school, verifiedRanking.category)) {
      conflicts.push({field: '院校', reason: 'current_school_mismatch', current, value: school,
        evidence: extracted.evidence.school});
    } else {
      const matches = verifiedRanking.entries.filter(entry => entry.name === school);
      if (matches.length === 0) {
        unavailable['院校'] = 'school_not_in_verified_ranking';
      } else if (matches.length > 1) {
        conflicts.push({field: '院校', reason: 'duplicate_exact_school_entries', value: school,
          evidence: extracted.evidence.school});
        unavailable['院校'] = 'ambiguous_exact_school_ranking';
      } else {
        const entry = matches[0];
        const display = verifiedRanking.category === MAIN_RANK_CATEGORY
          ? `${school}（${entry.rank}）`
          : `${school}（${entry.rank}，${verifiedRanking.category}）`;
        evidence['院校'] = {
          school: extracted.evidence.school,
          ranking: {
            year: verifiedRanking.year,
            category: verifiedRanking.category,
            sourceUrl: verifiedRanking.sourceUrl,
            sourceSha256: verifiedRanking.sourceSha256,
            name: entry.name,
            rank: entry.rank,
          },
        };
        if (isEmpty(current) || current !== display) patch['院校'] = display;
      }
    }
  }

  return {patch, evidence, conflicts, unavailable};
}
