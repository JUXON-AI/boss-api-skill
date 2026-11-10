#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import {validateJobPolicy} from './job_policy.mjs';

const [type, file] = process.argv.slice(2);
if (!type || !file) throw new Error('Usage: validate_contracts.mjs <job|manifest|approval|evaluation|record> <json-file>');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const value = type === 'job' && raw.job ? raw.job : raw;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function isObject(item) { return item && typeof item === 'object' && !Array.isArray(item); }
function isScore(item) { return item === null || (typeof item === 'number' && item >= 0 && item <= 100); }
function hasStrings(item) { return Array.isArray(item) && item.every(entry => typeof entry === 'string'); }

if (type === 'job') {
  assert(['internship', 'full_time', 'campus', 'general', 'part_time', 'contract', 'other'].includes(value.employment_type), 'job.employment_type is invalid');
  for (const key of ['job_name', 'boss_job_id', 'location', 'salary']) assert(typeof value[key] === 'string' && value[key].length > 0, `job.${key} is required`);
  const role = value.screening_policy ? validateJobPolicy(value.screening_policy, value) : null;
  if (role) assert(typeof value.company_key === 'string' && typeof value.department_key === 'string', 'explicit company and department keys are required');
  assert((role && value.days_per_week === null) || (Number.isInteger(value.days_per_week) && value.days_per_week >= 1 && value.days_per_week <= 7), 'job.days_per_week must be 1..7, or null under an explicit role policy');
  assert((role && value.minimum_months === null) || (Number.isFinite(value.minimum_months) && value.minimum_months >= 0), 'job.minimum_months is invalid');
  assert(hasStrings(value.responsibilities) && value.responsibilities.length > 0, 'job.responsibilities must be a non-empty string array');
  assert(hasStrings(value.hard_requirements), 'job.hard_requirements must be a string array');
  assert(isObject(value.scoring_weights), 'job.scoring_weights is required');
  const weights = value.scoring_weights;
  for (const key of ['core_role_skills', 'project_depth', 'engineering_habits', 'learning_and_collaboration']) assert(Number.isFinite(weights[key]) && weights[key] >= 0, `job.scoring_weights.${key} is invalid`);
  if (role) for (const key of Object.keys(weights)) assert(weights[key] === role.dimensions[key]?.weight, 'scoring_weights differ from the role policy');
  assert(isObject(value.message_policy), 'job.message_policy is required');
  const policy = value.message_policy;
  assert(Number.isInteger(policy.max_substantive_rounds) && policy.max_substantive_rounds >= 1 && policy.max_substantive_rounds <= 2, 'max_substantive_rounds must be 1 or 2');
  assert(policy.require_human_approval_before_send === true, 'human send approval must be required');
  assert(policy.require_fresh_history_before_send === true, 'fresh history must be required');
  assert(policy.may_promise_email === false, 'email delivery promises must be disabled');
  assert(policy.may_make_final_decision === false, 'AI final decisions must be disabled');
} else if (type === 'manifest') {
  for (const key of ['run_id', 'job_profile']) assert(typeof value[key] === 'string' && value[key].length > 0, `manifest.${key} is required`);
  assert(typeof value.authorized_contacting === 'boolean', 'authorized_contacting must be boolean');
  assert(value.candidate_source === 'explicit_user_list', 'candidate_source must be explicit_user_list');
  assert(Array.isArray(value.candidates) && value.candidates.length > 0, 'candidates must be a non-empty array');
  const seen = new Set();
  for (const candidate of value.candidates) {
    assert(Number.isSafeInteger(candidate.uid) && candidate.uid > 0, 'candidate uid is invalid');
    assert(typeof candidate.name === 'string' && candidate.name.length > 0, 'candidate name is invalid');
    assert(typeof candidate.boss_job_id === 'string' && candidate.boss_job_id.length > 0, 'candidate boss_job_id is invalid');
    assert(Number.isInteger(candidate.max_rounds) && candidate.max_rounds >= 1 && candidate.max_rounds <= 2, 'candidate max_rounds must be 1 or 2');
    assert(!seen.has(candidate.uid), `duplicate candidate uid ${candidate.uid}`);
    seen.add(candidate.uid);
  }
} else if (type === 'approval') {
  if (value.contractVersion !== undefined) {
    assert(value.contractVersion === 2, 'unsupported approval contractVersion');
    assert(typeof value.jobId === 'string' && value.jobId.trim(), 'version 2 approval must bind jobId');
  }
  assert(value.approved === true, 'approval.approved must be true');
  assert(/^[a-f0-9]{64}$/.test(value.expectedHistorySha256 ?? ''), 'expectedHistorySha256 must bind the reviewed conversation');
  assert(Number.isSafeInteger(value.recipient?.uid) && value.recipient.uid > 0, 'recipient uid is invalid');
  assert(typeof value.recipient?.name === 'string' && value.recipient.name.length > 0, 'recipient name is invalid');
  assert(value.approval?.recipientCount === 1, 'exactly one recipient must be approved');
  const digest = crypto.createHash('sha256').update(value.text ?? '').digest('hex');
  assert(value.textSha256 === digest, 'textSha256 does not match text');
  assert(value.approval?.approvedTextSha256 === digest, 'approvedTextSha256 does not match text');
} else if (type === 'evaluation') {
  const states = new Set(['ready_for_contact', 'needs_more_info', 'awaiting_candidate_reply', 'ai_screened_pass', 'talent_pool_candidate', 'current_role_mismatch', 'stop_contact']);
  assert(Number.isSafeInteger(value.candidate?.uid) && value.candidate.uid > 0, 'candidate.uid is invalid');
  assert(typeof value.candidate?.name === 'string' && value.candidate.name.length > 0, 'candidate.name is invalid');
  assert(typeof value.candidate?.boss_job_id === 'string' && value.candidate.boss_job_id.length > 0, 'candidate.boss_job_id is invalid');
  assert(states.has(value.state), 'state is invalid');
  assert(isScore(value.ability_score), 'ability_score must be null or 0..100');
  assert(typeof value.scoring_policy_version === 'string' && value.scoring_policy_version.length > 0, 'scoring_policy_version is required');
  assert(isScore(value.ability_base_score), 'ability_base_score must be null or 0..100');
  assert(isScore(value.final_signal_score), 'final_signal_score must be null or 0..100');
  for (const key of ['competition_bonus', 'github_bonus', 'proof_bonus']) assert(typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 24, `${key} is invalid`);
  assert(isObject(value.proof_signals) && Array.isArray(value.proof_signals.competitions) && Array.isArray(value.proof_signals.github_projects), 'proof_signals.competitions/github_projects must be arrays');
  assert(typeof value.evidence_coverage_percent === 'number' && value.evidence_coverage_percent >= 0 && value.evidence_coverage_percent <= 100, 'evidence_coverage_percent is invalid');
  assert(isScore(value.job_fit_score), 'job_fit_score must be null or 0..100');
  assert(['unknown', 'pass', 'partial', 'conflict'].includes(value.hard_condition_status), 'hard_condition_status is invalid');
  assert(Array.isArray(value.score_evidence), 'score_evidence must be an array');
  for (const item of value.score_evidence) {
    assert(typeof item.dimension === 'string' && isScore(item.score), 'score_evidence dimension/score is invalid');
    assert(typeof item.evidence === 'string' && typeof item.source === 'string', 'score_evidence evidence/source is invalid');
  }
  for (const key of ['confirmed_facts', 'unverified_claims', 'unknowns', 'stop_conditions']) assert(hasStrings(value[key]), `${key} must be a string array`);
  assert(['none', 'request_pending', 'received', 'parsed', 'unavailable'].includes(value.attachment_status), 'attachment_status is invalid');
  assert(['continue_contact', 'ready_for_hr', 'hold', 'talent_pool', 'stop'].includes(value.recommendation), 'recommendation is invalid');
  assert(Number.isInteger(value.next_round) && value.next_round >= 0 && value.next_round <= 2, 'next_round is invalid');
  assert(value.proposed_message === null || typeof value.proposed_message === 'string', 'proposed_message must be string or null');
  assert(value.requires_human_review === true, 'requires_human_review must be true');
} else if (type === 'record') {
  const {validateCandidateRecord} = await import('./candidate_ledger.mjs');
  validateCandidateRecord(value);
} else {
  throw new Error(`Unsupported contract type: ${type}`);
}

console.log(JSON.stringify({ok: true, type, file}, null, 2));
