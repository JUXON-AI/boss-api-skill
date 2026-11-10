import {ABILITY_DIMENSION_WEIGHTS, SCORING_POLICY_VERSION, scoreInternship} from '../../../scripts/scoring.mjs';

export const ROLE_DIMENSIONS = Object.keys(ABILITY_DIMENSION_WEIGHTS);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const round = v => Math.round(v * 100) / 100;

/** Validate a configured role at its input boundary; old records keep their original policy. */
export function validateJobPolicy(policy, identity = {}) {
  if (!object(policy) || policy.schema_version !== 1 || !text(policy.id) || !text(policy.revision)) throw new Error('Invalid job screening policy');
  for (const key of ['company_key', 'department_key', 'boss_job_id']) {
    if (!text(policy[key]) || (identity[key] !== undefined && identity[key] !== policy[key])) throw new Error(`Job policy scope mismatch: ${key}`);
  }
  if (typeof policy.approved !== 'boolean' || ![1, 2].includes(policy.max_substantive_rounds)) throw new Error('Job policy approval/round limit is required');
  if (policy.proof_bonus !== 'none') throw new Error('Generic roles currently require proof_bonus=none; do not inherit software awards');
  if (!object(policy.dimensions) || Object.keys(policy.dimensions).length !== ROLE_DIMENSIONS.length) throw new Error('Four canonical role dimension keys are required');
  let total = 0;
  for (const key of ROLE_DIMENSIONS) {
    const dim = policy.dimensions[key];
    if (!object(dim) || !text(dim.label) || !text(dim.rubric) || !Number.isFinite(dim.weight) || dim.weight < 0) throw new Error(`Invalid role rubric: ${key}`);
    total += dim.weight;
  }
  if (Math.abs(total - 100) > 0.000001) throw new Error('Role dimension weights must sum to 100');
  for (const key of ['ability_base', 'coverage', 'signal', 'job_fit']) {
    if (!Number.isFinite(policy.thresholds?.[key]) || policy.thresholds[key] < 0 || policy.thresholds[key] > 100) throw new Error(`Invalid role threshold: ${key}`);
  }
  if (!Array.isArray(policy.conditions) || !policy.conditions.length) throw new Error('Role conditions must be explicitly configured');
  const seen = new Set();
  for (const c of policy.conditions) {
    if (!object(c) || !/^[a-z][a-zA-Z0-9_]*$/.test(c.key) || seen.has(c.key) || !text(c.label) || typeof c.required !== 'boolean') throw new Error('Invalid or duplicate role condition');
    seen.add(c.key);
  }
  if (!policy.conditions.some(c => c.required)) throw new Error('At least one admission condition is required');
  return policy;
}

export function legacyJobPolicy() {
  return {legacy: true, approved: true, max_substantive_rounds: 2,
    thresholds: {ability_base: 60, coverage: 70, signal: 65, job_fit: 60},
    conditions: ['salary', 'onsite', 'days', 'duration', 'school', 'arrival', 'go', 'aiCoding', 'claudeAccount']
      .map(key => ({key, required: key !== 'claudeAccount'}))};
}

export function jobPolicyVersion(policy) {
  return policy.legacy ? SCORING_POLICY_VERSION : `role:${policy.id}:${policy.revision}`;
}

/** Receives a validated policy. Unknown evidence stays null; generic roles have no implicit bonus. */
export function scoreForJob(dimensions, policy, options = {}) {
  if (policy.legacy) return scoreInternship(dimensions, options);
  if ((options.competitions?.length ?? 0) || (options.githubProjects?.length ?? 0)) throw new Error('Role policy does not enable competition/GitHub bonuses');
  let weighted = 0, coverage = 0;
  for (const key of ROLE_DIMENSIONS) {
    const value = dimensions?.[key];
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid role score: ${key}`);
    const weight = policy.dimensions[key].weight;
    weighted += value * weight; coverage += weight;
  }
  const base = coverage ? round(weighted / coverage) : null;
  return {policyVersion: jobPolicyVersion(policy), abilityBaseScore: base, evidenceCoveragePercent: round(coverage),
    competitionBonus: 0, githubBonus: 0, proofBonus: 0, finalSignalScore: base, abilityScore: base,
    awardBonus: 0, awardEvidence: [], competitionEvidence: [], githubEvidence: [], requiresHumanReview: true};
}

/** Scope-filter confirmed public facts; a narrow fact does not become a company-wide policy. */
export function resolveKnowledgeFacts(facts, {company_key, department_key, boss_job_id}) {
  if (!Array.isArray(facts) || ![company_key, department_key, boss_job_id].every(text)) throw new Error('Explicit company/department/job identity is required');
  const applicable = [];
  for (const fact of facts) {
    if (!object(fact) || !text(fact.key) || !text(fact.content) || !text(fact.source)
      || !['company', 'department', 'job'].includes(fact.scope) || typeof fact.external_allowed !== 'boolean') throw new Error('Invalid knowledge fact');
    if (fact.company_key !== company_key || fact.status !== 'confirmed' || !fact.external_allowed) continue;
    if (fact.scope !== 'company' && fact.department_key !== department_key) continue;
    if (fact.scope === 'job' && fact.boss_job_id !== boss_job_id) continue;
    applicable.push(fact);
  }
  // Preserve differing statements for main review instead of silently overriding a conflict.
  const conflicts = [...new Set(applicable.map(f => f.key))].filter(key => new Set(applicable.filter(f => f.key === key).map(f => f.content)).size > 1);
  return {facts: applicable, conflicts};
}
