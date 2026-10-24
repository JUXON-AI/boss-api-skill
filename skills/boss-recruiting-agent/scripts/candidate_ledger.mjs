#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ABILITY_DIMENSION_WEIGHTS, SCORING_POLICY_VERSION, scoreInternship} from '../../../scripts/scoring.mjs';

const STATES = new Set([
  'ready_for_contact', 'needs_more_info', 'awaiting_candidate_reply',
  'ai_screened_pass', 'talent_pool_candidate', 'current_role_mismatch',
  'stop_contact', 'skipped_unknown_base', 'hr_review', 'closed',
]);

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isHex(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function round2(value) { return Math.round(value * 100) / 100; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonSha(value) { return sha256(JSON.stringify(canonical(value))); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fileSha(file) { return sha256(fs.readFileSync(file)); }
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true});
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(canonical(value), null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  fs.renameSync(temp, file);
}

export function upsertCandidateRecord(root, record, options = {}) {
  validateCandidateRecord(record);
  if (options.jobProfilePath && fileSha(options.jobProfilePath) !== record.job.job_profile_sha256) fail('job profile SHA-256 changed; re-review before updating the candidate record');
  const target = locate(root, record.job.boss_job_id, record.candidate.uid);
  const exists = fs.existsSync(target);
  if (exists && !options.expectedSha256) fail('updating an existing candidate record requires --expected-sha256');
  if (!exists && options.expectedSha256) fail('--expected-sha256 is only valid for an existing record');
  if (exists) {
    const actual = jsonSha(readJson(target));
    if (actual !== options.expectedSha256) fail('stale candidate record update rejected');
  }
  writeJsonAtomic(target, record);
  return {ok: true, created: !exists, path: target, recordSha256: jsonSha(record)};
}

export function validateCandidateRecord(record) {
  if (!isObject(record)) fail('candidate record must be an object');
  if (record.schema_version !== 1) fail('schema_version must be 1');
  if (record.policy_version !== SCORING_POLICY_VERSION) fail(`policy_version must be ${SCORING_POLICY_VERSION}`);
  if (!isHex(record.job?.job_profile_sha256)) fail('job.job_profile_sha256 must be SHA-256');
  if (typeof record.job?.boss_job_id !== 'string' || !record.job.boss_job_id) fail('job.boss_job_id is required');
  if (!Number.isSafeInteger(record.candidate?.uid) || record.candidate.uid < 1) fail('candidate.uid is invalid');
  if (typeof record.candidate?.name !== 'string' || !record.candidate.name.trim()) fail('candidate.name is required');
  if (!isHex(record.history?.sha256)) fail('history.sha256 must be SHA-256');
  if (record.history?.complete !== true) fail('history.complete must be true');
  if (!isDate(record.history?.checked_at)) fail('history.checked_at must be an ISO timestamp');
  if (!['in', 'out', 'none'].includes(record.history?.last_direction)) fail('history.last_direction is invalid');
  if (!STATES.has(record.state)) fail('state is invalid');
  if (!['continue_contact', 'ready_for_hr', 'hold', 'talent_pool', 'stop', 'skip'].includes(record.recommendation)) fail('recommendation is invalid');
  if (!Number.isInteger(record.next_round) || record.next_round < 0 || record.next_round > 2) fail('next_round must be 0..2');
  if (typeof record.next_action !== 'string' || !record.next_action.trim()) fail('next_action is required');
  if (!Array.isArray(record.sources) || record.sources.length === 0 || record.sources.some(item => typeof item !== 'string' || !item.trim())) fail('sources must be non-empty strings');
  if (!isDate(record.updated_at)) fail('updated_at must be an ISO timestamp');
  if (!isHex(record.score?.evaluation_sha256)) fail('score.evaluation_sha256 must be SHA-256');
  if (!Array.isArray(record.score?.competitions) || !Array.isArray(record.score?.github_projects)) fail('score proof arrays are required');
  if (!Number.isInteger(record.communication?.round) || record.communication.round < 0 || record.communication.round > 2) fail('communication.round must be 0..2');
  if (!Array.isArray(record.communication?.pending_inbound_mids)) fail('communication.pending_inbound_mids must be an array');
  const noReplyRequired = record.communication.no_reply_required;
  if (noReplyRequired !== undefined) {
    if (!isObject(noReplyRequired)) fail('communication.no_reply_required must be an object');
    if (Object.keys(noReplyRequired).some(key => !['mid', 'reason', 'source'].includes(key))) fail('communication.no_reply_required has an unsupported field');
    if (!(Number.isSafeInteger(noReplyRequired.mid) || (typeof noReplyRequired.mid === 'string' && noReplyRequired.mid))) fail('communication.no_reply_required.mid is invalid');
    if (noReplyRequired.mid !== record.history.last_mid) fail('communication.no_reply_required.mid must exactly match history.last_mid');
    if (typeof noReplyRequired.reason !== 'string' || !noReplyRequired.reason.trim()) fail('communication.no_reply_required.reason is required');
    if (typeof noReplyRequired.source !== 'string' || !record.sources.includes(noReplyRequired.source)) fail('communication.no_reply_required.source must reference record.sources');
    if (record.history.last_direction !== 'in') fail('communication.no_reply_required requires history.last_direction=in');
    if (record.communication.pending_inbound_mids.length !== 0) fail('communication.no_reply_required cannot coexist with pending inbound mids');
  }
  if (record.history.last_direction === 'in' && record.communication.pending_inbound_mids.length === 0 && noReplyRequired === undefined) fail('inbound-last history requires at least one pending inbound mid or no_reply_required');
  if (record.history.last_direction !== 'in' && record.communication.pending_inbound_mids.length !== 0) fail('pending inbound mids require history.last_direction=in');

  const calculated = scoreInternship(record.score.dimensions, {
    competitions: record.score.competitions,
    githubProjects: record.score.github_projects,
  });
  const comparable = [
    ['ability_base_score', calculated.abilityBaseScore],
    ['evidence_coverage_percent', calculated.evidenceCoveragePercent],
    ['competition_bonus', calculated.competitionBonus],
    ['github_bonus', calculated.githubBonus],
    ['proof_bonus', calculated.proofBonus],
    ['final_signal_score', calculated.finalSignalScore],
  ];
  for (const [key, expected] of comparable) {
    const actual = record.score[key];
    if (typeof expected === 'number' && (typeof actual !== 'number' || Math.abs(actual - expected) > 0.001)) {
      fail(`score.${key} does not match deterministic recomputation: expected ${expected}, got ${actual}`);
    }
    if (expected === null && actual !== null) fail(`score.${key} must be null`); 
  }
  if (calculated.abilityBaseScore === null) {
    if (record.state !== 'skipped_unknown_base' || record.recommendation !== 'skip' || record.next_round !== 0) {
      fail('unknown ability base must be skipped with recommendation=skip and next_round=0');
    }
  }
  if (!['unknown', 'pass', 'partial', 'conflict'].includes(record.job_fit?.hard_condition_status)) fail('job_fit.hard_condition_status is invalid');
  if (record.job_fit?.score !== null && (!Number.isFinite(record.job_fit?.score) || record.job_fit.score < 0 || record.job_fit.score > 100)) fail('job_fit.score must be null or 0..100');
  if (record.state === 'ai_screened_pass') {
    if (calculated.abilityBaseScore === null || calculated.abilityBaseScore < 60) fail('ai_screened_pass requires ability_base_score >= 60');
    if (calculated.evidenceCoveragePercent < 70) fail('ai_screened_pass requires evidence coverage >= 70');
    if (calculated.finalSignalScore === null || calculated.finalSignalScore < 65) fail('ai_screened_pass requires final_signal_score >= 65');
    if (record.recommendation !== 'ready_for_hr' || record.next_round !== 0) fail('ai_screened_pass requires ready_for_hr and next_round=0');
    if (record.job_fit?.hard_condition_status !== 'pass' || record.job_fit?.score === null || record.job_fit.score < 60) fail('ai_screened_pass requires passing job fit with score >= 60');
  }
  return {record, score: calculated};
}

function locate(root, jobId, uid) {
  const target = path.resolve(root, String(jobId), `${uid}.json`);
  const base = path.resolve(root);
  if (!target.startsWith(base + path.sep)) fail('candidate path escapes ledger root');
  return target;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail('Usage: candidate_ledger.mjs <hash|upsert|show|verify|index> [--flag value]');
    options[key.slice(2)] = value;
  }
  return {command, options};
}

function allRecordFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
    }
  };
  visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

export function verifyLedger(root) {
  const base = path.resolve(root);
  const rows = [];
  const identities = new Set();
  for (const file of allRecordFiles(base)) {
    const {record, score} = validateCandidateRecord(readJson(file));
    const expected = locate(base, record.job.boss_job_id, record.candidate.uid);
    if (path.resolve(file) !== expected) fail(`record path does not match identity: ${file}`);
    const identity = `${record.job.boss_job_id}:${record.candidate.uid}`;
    if (identities.has(identity)) fail(`duplicate candidate identity ${identity}`);
    identities.add(identity);
    rows.push({file, recordSha256: jsonSha(record), record, score});
  }
  return rows;
}

function main() {
  const {command, options} = parseArgs(process.argv.slice(2));
  if (command === 'hash') {
    if (!options.file) fail('hash requires --file');
    console.log(JSON.stringify({ok: true, file: path.resolve(options.file), sha256: fileSha(options.file)}, null, 2));
    return;
  }
  if (command === 'upsert') {
    if (!options.dir || !options.record) fail('upsert requires --dir and --record');
    const result = upsertCandidateRecord(options.dir, readJson(options.record), {
      expectedSha256: options['expected-sha256'],
      jobProfilePath: options['job-profile'],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'show') {
    if (!options.dir || !options['job-id'] || !options.uid) fail('show requires --dir --job-id --uid');
    const file = locate(options.dir, options['job-id'], Number(options.uid));
    const {record} = validateCandidateRecord(readJson(file));
    if (options['job-profile'] && fileSha(options['job-profile']) !== record.job.job_profile_sha256) fail('job profile SHA-256 changed; candidate record is stale');
    console.log(JSON.stringify({record, recordSha256: jsonSha(record), path: file}, null, 2));
    return;
  }
  if (command === 'verify') {
    if (!options.dir) fail('verify requires --dir');
    const rows = verifyLedger(options.dir);
    console.log(JSON.stringify({ok: true, count: rows.length, records: rows.map(row => ({path: row.file, candidateUid: row.record.candidate.uid, jobId: row.record.job.boss_job_id, state: row.record.state, recordSha256: row.recordSha256}))}, null, 2));
    return;
  }
  if (command === 'index') {
    if (!options.dir) fail('index requires --dir');
    const rows = verifyLedger(options.dir);
    const index = {
      schema_version: 1,
      policy_version: SCORING_POLICY_VERSION,
      generated_at: new Date().toISOString(),
      records: rows.map(({file, recordSha256, record}) => ({
        candidate_uid: record.candidate.uid,
        candidate_name: record.candidate.name,
        boss_job_id: record.job.boss_job_id,
        state: record.state,
        ability_base_score: record.score.ability_base_score,
        evidence_coverage_percent: record.score.evidence_coverage_percent,
        proof_bonus: record.score.proof_bonus,
        final_signal_score: record.score.final_signal_score,
        next_action: record.next_action,
        updated_at: record.updated_at,
        record_sha256: recordSha256,
        path: file,
      })).sort((a, b) => a.boss_job_id.localeCompare(b.boss_job_id) || a.candidate_uid - b.candidate_uid),
    };
    if (options.output) writeJsonAtomic(path.resolve(options.output), index);
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  fail('Usage: candidate_ledger.mjs <hash|upsert|show|verify|index> [--flag value]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
