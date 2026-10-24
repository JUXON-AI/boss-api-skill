import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreInternship, SCORING_POLICY_VERSION} from './scoring.mjs';

const dimensions={core_role_skills:65,project_depth:55,engineering_habits:null,learning_and_collaboration:null};
const award={competition:'离线技术赛',prize:'二等奖',level:'national',placement:2,jobRelevant:true,source:'离线自述夹具',claimStatus:'self_reported'};
const github=(overrides={})=>({repo:'candidate/project',project:'离线项目',relation:'owner',isFork:false,candidateAuthoredCommits:6,substantiveContribution:true,mergedPullRequests:0,hasTestsOrDemo:true,jobRelevant:true,source:'https://github.com/candidate/project',claimStatus:'publicly_observed',...overrides});

test('self-reported competition bonus is larger than the legacy rubric but remains discounted',()=>{
  const s=scoreInternship(dimensions,[award]);
  assert.equal(s.policyVersion,SCORING_POLICY_VERSION);
  assert.equal(s.abilityBaseScore,60.38);
  assert.equal(s.competitionBonus,11.25);
  assert.equal(s.proofBonus,11.25);
  assert.equal(s.finalSignalScore,71.63);
  assert.equal(s.abilityScore,71.63);
  assert.equal(s.evidenceCoveragePercent,65);
});

test('public evidence adds a stronger award and only the strongest award contributes',()=>{
  const awards=[award,{...award,placement:1,prize:'一等奖',claimStatus:'publicly_observed'}];
  const s=scoreInternship(dimensions,{competitions:awards});
  assert.equal(s.competitionBonus,18);
  assert.equal(s.finalSignalScore,78.38);
});

test('GitHub authorship earns stronger evidence while a bare fork earns nothing',()=>{
  const owned=scoreInternship(dimensions,{githubProjects:[github()]});
  assert.equal(owned.githubBonus,14);
  assert.equal(owned.finalSignalScore,74.38);
  const bareFork=scoreInternship(dimensions,{githubProjects:[github({isFork:true,candidateAuthoredCommits:0,substantiveContribution:false})]});
  assert.equal(bareFork.githubBonus,0);
  assert.match(bareFork.githubEvidence[0].reason,/fork/);
  const forkContribution=scoreInternship(dimensions,{githubProjects:[github({isFork:true})]});
  assert.equal(forkContribution.githubBonus,13);
});

test('GitHub URLs without public inspection and unrelated work do not add points',()=>{
  assert.equal(scoreInternship(dimensions,{githubProjects:[github({claimStatus:'self_reported'})]}).githubBonus,0);
  assert.equal(scoreInternship(dimensions,{githubProjects:[github({jobRelevant:false})]}).githubBonus,0);
});

test('proof bonus is bounded and cannot fill an unknown ability base',()=>{
  const topAward={...award,placement:1,prize:'一等奖',claimStatus:'verified'};
  const topRepo=github({candidateAuthoredCommits:20,hasTestsOrDemo:true});
  const s=scoreInternship(Object.fromEntries(Object.keys(dimensions).map(k=>[k,99])),{competitions:[topAward],githubProjects:[topRepo]});
  assert.equal(s.proofBonus,24);
  assert.equal(s.finalSignalScore,100);
  const unknown=scoreInternship(Object.fromEntries(Object.keys(dimensions).map(k=>[k,null])),{competitions:[topAward],githubProjects:[topRepo]});
  assert.equal(unknown.finalSignalScore,null);
  assert.equal(unknown.evidenceCoveragePercent,0);
});

test('invalid bounded inputs fail instead of silently inflating a score',()=>{
  assert.throws(()=>scoreInternship(dimensions,[{...award,source:''}]));
  assert.throws(()=>scoreInternship({...dimensions,project_depth:101}));
  assert.throws(()=>scoreInternship(dimensions,{githubProjects:[github({candidateAuthoredCommits:-1})]}));
});