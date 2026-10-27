import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {extractProfileFields, planProfileFieldPatch} from './profile_fields.mjs';
import {buildTalentLocationPatch} from './talent_location_fields.mjs';

const FIELD_NAMES = Object.freeze({age: '年龄', gender: '性别', school: '院校'});
const GENDER_EXPRESSION = '1===this.item.gender?"男":0===this.item.gender?"女":""';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safeId = value => (typeof value === 'string' && value.trim().length > 0)
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const idEquals = (a, b) => safeId(a) && safeId(b) && String(a) === String(b);

function readBoundJson(file, expectedSha256) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/i, 'expected source byte SHA-256 required');
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), expectedSha256, 'source bytes changed');
  return JSON.parse(bytes.toString('utf8'));
}

/** Verify the actual client source bytes and the supported explicit enum expression. */
export function readVerifiedGenderMapping(file) {
  if (!file) return undefined;
  const mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(mapping.verified, true);
  const bytes = fs.readFileSync(mapping.source);
  assert.equal(hash(bytes), mapping.sourceSha256, 'gender mapping source bytes changed');
  assert.equal(mapping.evidence?.expression, GENDER_EXPRESSION, 'unsupported gender mapping expression');
  assert.ok(Number.isSafeInteger(mapping.evidence.offset) && mapping.evidence.offset >= 0);
  const text = bytes.toString('utf8');
  assert.equal(text.slice(mapping.evidence.offset, mapping.evidence.offset + GENDER_EXPRESSION.length), GENDER_EXPRESSION);
  assert.deepEqual(mapping.values, {'0': '女', '1': '男'}, 'enum labels disagree with verified source');
  return mapping;
}

function sourceMessages(snapshot) {
  const messages = snapshot.history?.original_order_redacted
    ?? snapshot.history?.originalOrderRedacted
    ?? snapshot.response?.zpData?.messages
    ?? snapshot.zpData?.messages
    ?? snapshot.messages;
  assert.ok(Array.isArray(messages), 'recognized original history messages required');
  return messages;
}

function assertSnapshotTarget(snapshot, candidate) {
  if (snapshot.candidate) {
    assert.ok(idEquals(snapshot.candidate.uid, candidate.uid), 'snapshot candidate UID mismatch');
    assert.equal(snapshot.candidate.name, candidate.name, 'snapshot contact name mismatch');
    if (snapshot.candidate.jobId !== undefined) assert.ok(idEquals(snapshot.candidate.jobId, candidate.jobId));
  }
  const identity = snapshot.identity ?? snapshot.history?.identity;
  if (identity?.candidateUid !== undefined) assert.ok(idEquals(identity.candidateUid, candidate.uid));
  if (identity?.candidateName !== undefined) assert.equal(identity.candidateName, candidate.name);
}

function profileIdentity(candidate, snapshot, messages, source, sourceSha256, aliasesFile) {
  const names = new Set(messages.filter(m => m.body?.resume && idEquals(m.from?.uid, candidate.uid)).map(m => m.body.resume.user?.name));
  if (!names.size || (names.size === 1 && names.has(candidate.name))) return {candidate};
  assert.ok(aliasesFile, 'profile card name differs; explicit identity evidence required');
  const registry = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
  const alias = registry.accepted.find(a => idEquals(a.uid, candidate.uid)
    && idEquals(a.jobId, candidate.jobId) && a.candidateName === candidate.name
    && path.resolve(a.source) === path.resolve(source) && a.sourceSha256 === sourceSha256);
  assert.ok(alias && names.size === 1 && names.has(alias.profileName), 'accepted profile alias not found');
  // An alias is accepted only when this same immutable SDK snapshot independently
  // binds the contact's real name, UID and job, in addition to the card's UID/job.
  assert.ok(snapshot.candidate && idEquals(snapshot.candidate.uid, candidate.uid));
  assert.equal(snapshot.candidate.name, candidate.name);
  assert.ok(idEquals(snapshot.candidate.jobId, candidate.jobId));
  for (const m of messages.filter(m => m.body?.resume)) {
    assert.ok(idEquals(m.from?.uid, candidate.uid));
    assert.ok(idEquals(m.body.resume.user?.uid, candidate.uid));
    assert.ok(idEquals(m.body.resume.jobId, candidate.jobId));
  }
  return {candidate: {...candidate, name: alias.profileName}, alias};
}

/** File-I/O boundary: verify real snapshot and mapping bytes before pure extraction. */
export function readVerifiedProfileFields({candidate, source, sourceSha256, genderMappingFile, aliasesFile}) {
  const snapshot = readBoundJson(source, sourceSha256);
  assertSnapshotTarget(snapshot, candidate);
  const messages = sourceMessages(snapshot);
  const identity = profileIdentity(candidate, snapshot, messages, source, sourceSha256, aliasesFile);
  const genderMapping = readVerifiedGenderMapping(genderMappingFile);
  const metadata = extractProfileFields({candidate: identity.candidate, snapshots: [{source, sourceSha256, messages}], genderMapping});
  metadata.candidate = {...candidate};
  if (identity.alias) metadata.identityAliasEvidence = identity.alias;
  metadata.verifiedSource = {source, sourceSha256};
  return metadata;
}

/** Build a fill-only Base patch, restricted to the three descriptive fields. */
export function buildTalentProfilePatch({candidate, currentValues = {}, ...sourceOptions}) {
  const metadata = readVerifiedProfileFields({candidate, ...sourceOptions});
  const current = Object.fromEntries(Object.entries(FIELD_NAMES).map(([key, name]) => [key, currentValues[name]]));
  const plan = planProfileFieldPatch({candidate, currentValues: current, metadata});
  const translate = value => Object.fromEntries(Object.entries(value).map(([key, v]) => [FIELD_NAMES[key], v]));
  return {
    candidate: {...candidate},
    patch: translate(plan.patch),
    unchanged: translate(plan.unchanged),
    unavailable: translate(plan.unavailable),
    conflicts: plan.conflicts.map(c => ({...c, field: FIELD_NAMES[c.field]})),
    evidence: translate(metadata.evidence),
    sourceVerification: metadata.verifiedSource,
    ...(metadata.identityAliasEvidence ? {identityAliasEvidence: metadata.identityAliasEvidence} : {}),
  };
}

/** Shared create-payload hook. Admission and API execution remain caller-owned. */
export function buildTalentCreateValues({values, locationPolicyFile, currentResidence, ...sourceOptions}) {
  assert.ok(values && typeof values === 'object' && !Array.isArray(values));
  const profile = buildTalentProfilePatch({...sourceOptions, currentValues: values});
  assert.equal(profile.conflicts.length, 0, 'confirmed profile fields conflict with create values');
  // Count the JSON payload that the CLI will actually receive, not undefined keys.
  const location = buildTalentLocationPatch({...sourceOptions, locationPolicyFile, currentResidence,
    school: profile.patch['院校'] ?? values['院校'], currentValue: values['现居地']});
  assert.notEqual(location.status, 'conflict', 'current location conflicts with create values');
  const enriched = JSON.parse(JSON.stringify({...values, ...profile.patch, ...location.patch}));
  return {
    values: enriched,
    profile,
    location,
    writtenFields: Object.keys(enriched).length,
    omittedFields: ['年龄', '性别', '院校', '现居地', '院校评分', '附件'].filter(name => !Object.hasOwn(enriched, name)),
  };
}
