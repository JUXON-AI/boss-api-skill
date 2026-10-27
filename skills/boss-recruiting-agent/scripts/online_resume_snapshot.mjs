#!/usr/bin/env node
import crypto from 'node:crypto';

const KIND = 'boss_online_resume_summary_snapshot';
const GENERATED_LABEL = 'BOSS线上简历摘要（非完整正文）';
const MAX_VALUE_DEPTH = 32;

const SECTION_FIELDS = Object.freeze({
  education: Object.freeze([
    'school',
    'major',
    'degreeName',
    'startDateDesc',
    'endDateDesc',
    'educationDescription',
  ]),
  work: Object.freeze([
    'company',
    'brandName',
    'positionName',
    'department',
    'jobName',
    'startDateDesc',
    'endDateDesc',
    'startYearMonStr',
    'endYearMonStr',
    'workDescription',
    'responsibility',
  ]),
  projects: Object.freeze([
    'name',
    'roleName',
    'startDateDesc',
    'endDateDesc',
    'projectDescription',
    'description',
    'responsibility',
    'achievement',
  ]),
});

const SENSITIVE_TOKENS = Object.freeze([
  'security',
  'encrypt',
  'avatar',
  'phone',
  'mobile',
  'email',
  'mail',
  'hyperlink',
  'url',
  'uri',
  'token',
  'cookie',
  'auth',
  'credential',
  'password',
  'secret',
  'session',
  'contact',
  'route',
  'path',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message) {
  throw new Error(`online_resume_snapshot: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(object, key, context) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(`${context}.${key} must be a data property`);
  }
  return descriptor.value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeJobId(value, context) {
  if (nonEmptyString(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail(`${context} must be a non-empty string or positive safe integer`);
}

function normalizeIdentity(candidate, context) {
  if (!isPlainObject(candidate)) fail(`${context} must be a plain object`);
  const uid = ownDataValue(candidate, 'uid', context);
  const name = ownDataValue(candidate, 'name', context);
  const jobId = normalizeJobId(ownDataValue(candidate, 'jobId', context), `${context}.jobId`);
  if (!Number.isSafeInteger(uid) || uid < 1) fail(`${context}.uid must be a positive safe integer`);
  if (!nonEmptyString(name)) fail(`${context}.name must be a non-empty string`);
  return {uid, name, jobId};
}

function isSensitiveKey(key) {
  if (FORBIDDEN_KEYS.has(key)) return true;
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized.endsWith('id')) return true;
  return SENSITIVE_TOKENS.some(token => normalized.includes(token));
}

function copyInertValue(value, context, depth = 0, ancestors = new WeakSet()) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return nonEmptyString(value) ? value : undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${context} must contain only finite numbers`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') fail(`${context} contains an unsupported value type`);
  if (depth >= MAX_VALUE_DEPTH) fail(`${context} exceeds the maximum nesting depth`);
  if (ancestors.has(value)) fail(`${context} must not contain circular references`);
  if (!Array.isArray(value) && !isPlainObject(value)) fail(`${context} must use arrays and plain objects only`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail(`${context}[${index}] must be a data property`);
        }
        const copied = copyInertValue(descriptor.value, `${context}[${index}]`, depth + 1, ancestors);
        if (copied !== undefined) output.push(copied);
      }
      return output.length > 0 ? output : undefined;
    }

    const output = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveKey(key)) continue;
      const nested = ownDataValue(value, key, context);
      const copied = copyInertValue(nested, `${context}.${key}`, depth + 1, ancestors);
      if (copied !== undefined) output[key] = copied;
    }
    return Object.keys(output).length > 0 ? output : undefined;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeSection(entries, fields, sectionName) {
  if (!Array.isArray(entries)) fail(`source.resume.summary.${sectionName} must be an array`);
  const output = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const context = `source.resume.summary.${sectionName}[${index}]`;
    if (!isPlainObject(entry)) fail(`${context} must be a plain object`);
    const cleaned = {};
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
      const value = ownDataValue(entry, field, context);
      const copied = copyInertValue(value, `${context}.${field}`);
      if (copied !== undefined) cleaned[field] = copied;
    }
    if (Object.keys(cleaned).length > 0) output.push(cleaned);
  }
  return output;
}

function requireTimestamp(value, context) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${context} must be an ISO timestamp`);
  }
  return value;
}

export function buildOnlineResumeSnapshot({candidate, source, sourceSha256, sourcePath}) {
  const identity = normalizeIdentity(candidate, 'candidate');
  if (!isPlainObject(source)) fail('source must be a plain object');
  const sourceIdentity = normalizeIdentity(ownDataValue(source, 'candidate', 'source'), 'source.candidate');
  if (sourceIdentity.uid !== identity.uid
      || sourceIdentity.name !== identity.name
      || sourceIdentity.jobId !== identity.jobId) {
    fail('candidate UID, name, and jobId must exactly match source.candidate');
  }

  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
    fail('sourceSha256 must be a 64-character lowercase hex SHA-256');
  }
  if (!nonEmptyString(sourcePath)) fail('sourcePath must be a non-empty evidence metadata string');

  const schemaVersion = ownDataValue(source, 'schemaVersion', 'source');
  if (schemaVersion !== 1) fail('source.schemaVersion must be 1');
  const capturedAt = requireTimestamp(ownDataValue(source, 'at', 'source'), 'source.at');

  const resume = ownDataValue(source, 'resume', 'source');
  if (!isPlainObject(resume)) fail('source.resume must be a plain object');
  if (ownDataValue(resume, 'status', 'source.resume') !== 'summary') {
    fail('source.resume.status must be summary');
  }
  const obtainedAt = requireTimestamp(
    ownDataValue(resume, 'obtainedAt', 'source.resume'),
    'source.resume.obtainedAt',
  );
  const summary = ownDataValue(resume, 'summary', 'source.resume');
  if (!isPlainObject(summary)) fail('source.resume.summary must be a plain object');
  if (ownDataValue(summary, 'fullTextVerified', 'source.resume.summary') !== false) {
    fail('source.resume.summary.fullTextVerified must be false');
  }

  const sections = {
    education: sanitizeSection(
      ownDataValue(summary, 'education', 'source.resume.summary'),
      SECTION_FIELDS.education,
      'education',
    ),
    work: sanitizeSection(
      ownDataValue(summary, 'work', 'source.resume.summary'),
      SECTION_FIELDS.work,
      'work',
    ),
    projects: sanitizeSection(
      ownDataValue(summary, 'projects', 'source.resume.summary'),
      SECTION_FIELDS.projects,
      'projects',
    ),
  };

  if (sections.education.length + sections.work.length + sections.projects.length === 0) {
    fail('at least one real education, work, or project entry is required; card-only data is rejected');
  }

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${identity.jobId}${identity.uid}${sourceSha256}${KIND}`)
    .digest('hex');

  return {
    candidate: {
      uid: identity.uid,
      name: identity.name,
      jobId: identity.jobId,
    },
    kind: KIND,
    fullTextVerified: false,
    source: {
      path: sourcePath,
      sha256: sourceSha256,
      capturedAt: obtainedAt,
    },
    generatedLabel: GENERATED_LABEL,
    sections,
    idempotencyKey,
  };
}
