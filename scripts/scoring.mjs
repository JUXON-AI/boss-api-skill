// Scores are supplied from reviewed capability evidence, never inferred from keywords.
export const SCORING_POLICY_VERSION = '2026-10-24.1';

export const ABILITY_DIMENSION_WEIGHTS = Object.freeze({
  core_role_skills: 35,
  project_depth: 30,
  engineering_habits: 20,
  learning_and_collaboration: 15,
});

const COMPETITION_BONUS = Object.freeze({
  national: [18, 15, 12],
  provincial: [12, 9, 6],
  school: [4, 3, 2],
});

const AWARD_STATUS_MULTIPLIER = Object.freeze({
  self_reported: 0.75,
  document_provided: 1,
  publicly_observed: 1,
  verified: 1,
});

function round2(value) {
  return Math.round(value * 100) / 100;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
}

function scoreCompetition(award) {
  if (award.jobRelevant !== true) return {bonus: 0, evidence: {...award, bonus: 0, reason: 'not_job_relevant'}};
  requireText(award.competition, 'Competition name');
  requireText(award.prize, 'Competition prize');
  requireText(award.source, 'Competition source');
  if (!COMPETITION_BONUS[award.level] || ![1, 2, 3].includes(award.placement)) {
    throw new Error('Competition level/placement is unknown; keep bonus pending');
  }
  if (!AWARD_STATUS_MULTIPLIER[award.claimStatus]) throw new Error('Competition claimStatus is invalid');
  const fullBonus = COMPETITION_BONUS[award.level][award.placement - 1];
  const multiplier = AWARD_STATUS_MULTIPLIER[award.claimStatus];
  const bonus = round2(fullBonus * multiplier);
  return {bonus, evidence: {...award, fullBonus, multiplier, bonus}};
}

function scoreGitHubProject(project) {
  if (project.jobRelevant !== true) return {bonus: 0, evidence: {...project, bonus: 0, reason: 'not_job_relevant'}};
  requireText(project.repo, 'GitHub repo');
  requireText(project.source, 'GitHub source');
  if (!['publicly_observed', 'verified'].includes(project.claimStatus)) {
    return {bonus: 0, evidence: {...project, bonus: 0, reason: 'public_github_observation_required'}};
  }
  if (!Number.isSafeInteger(project.candidateAuthoredCommits) || project.candidateAuthoredCommits < 0) {
    throw new Error('GitHub candidateAuthoredCommits must be a nonnegative integer');
  }
  if (project.isFork === true && (project.substantiveContribution !== true || project.candidateAuthoredCommits === 0)) {
    return {bonus: 0, evidence: {...project, bonus: 0, reason: 'fork_has_no_candidate_authored_substantive_contribution'}};
  }
  if (project.substantiveContribution !== true || project.candidateAuthoredCommits === 0) {
    return {bonus: 0, evidence: {...project, bonus: 0, reason: 'no_substantive_candidate_authored_contribution'}};
  }

  let bonus = 8;
  if (project.candidateAuthoredCommits >= 5 || (project.mergedPullRequests ?? 0) >= 1) bonus += 4;
  if (project.candidateAuthoredCommits >= 20 || (project.relation === 'owner' && project.candidateAuthoredCommits >= 10)) bonus += 4;
  if (project.hasTestsOrDemo === true) bonus += 2;
  if (project.isFork === true) bonus = Math.max(0, bonus - 1);
  bonus = Math.min(18, bonus);
  return {bonus, evidence: {...project, bonus}};
}

export function scoreInternship(dimensions, options = {}) {
  const normalized = Array.isArray(options) ? {competitions: options} : (options ?? {});
  let weighted = 0;
  let coverage = 0;
  for (const [key, weight] of Object.entries(ABILITY_DIMENSION_WEIGHTS)) {
    const score = dimensions?.[key];
    if (score === null) continue;
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`Capability score must be null or 0..100: ${key}`);
    weighted += weight * score;
    coverage += weight;
  }

  const competitions = normalized.competitions ?? normalized.awards ?? [];
  const githubProjects = normalized.githubProjects ?? normalized.github ?? [];
  if (!Array.isArray(competitions) || !Array.isArray(githubProjects)) throw new Error('competitions and githubProjects must be arrays');

  const competitionEvidence = competitions.map(scoreCompetition);
  const githubEvidence = githubProjects.map(scoreGitHubProject);
  const strongestCompetition = Math.max(0, ...competitionEvidence.map(item => item.bonus));
  const strongestGitHub = Math.max(0, ...githubEvidence.map(item => item.bonus));
  const proofBonus = round2(Math.min(24, strongestCompetition + strongestGitHub));
  const abilityBaseScore = coverage ? round2(weighted / coverage) : null;
  const finalSignalScore = abilityBaseScore === null ? null : round2(Math.min(100, abilityBaseScore + proofBonus));

  return {
    policyVersion: SCORING_POLICY_VERSION,
    abilityBaseScore,
    evidenceCoveragePercent: coverage,
    competitionBonus: strongestCompetition,
    githubBonus: strongestGitHub,
    proofBonus,
    finalSignalScore,
    // Compatibility alias: business gates use abilityBaseScore plus coverage.
    abilityScore: finalSignalScore,
    // Compatibility aliases for existing exports.
    awardBonus: strongestCompetition,
    awardEvidence: competitionEvidence.map(item => item.evidence),
    competitionEvidence: competitionEvidence.map(item => item.evidence),
    githubEvidence: githubEvidence.map(item => item.evidence),
    requiresHumanReview: true,
  };
}