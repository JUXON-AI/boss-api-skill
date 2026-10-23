import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreInternship} from './scoring.mjs';
const dimensions={core_role_skills:65,project_depth:55,engineering_habits:null,learning_and_collaboration:null};
const award={competition:'离线技术赛',prize:'二等奖',level:'national',placement:2,jobRelevant:true,source:'离线自述夹具',claimStatus:'self_reported'};
test('capability score accepts self-report evidence and keeps coverage separate from award bonus',()=>{
  const s=scoreInternship(dimensions,[award]);assert.equal(s.abilityBaseScore,60.38);assert.equal(s.awardBonus,8);assert.equal(s.abilityScore,68.38);assert.equal(s.evidenceCoveragePercent,65);
});
test('awards use the strongest bounded bonus, cap total at 100, and cannot fill unknown capability evidence',()=>{
  const awards=[award,{...award,placement:1,prize:'一等奖'}];
  assert.equal(scoreInternship(dimensions,awards).awardBonus,10);
  assert.equal(scoreInternship(Object.fromEntries(Object.keys(dimensions).map(k=>[k,99])),awards).abilityScore,100);
  const unknown=scoreInternship(Object.fromEntries(Object.keys(dimensions).map(k=>[k,null])),awards);assert.equal(unknown.abilityScore,null);assert.equal(unknown.evidenceCoveragePercent,0);
  assert.equal(scoreInternship(dimensions,[{...award,jobRelevant:false}]).awardBonus,0);
  assert.throws(()=>scoreInternship(dimensions,[{...award,source:''}]));
  assert.throws(()=>scoreInternship({...dimensions,project_depth:101}));
});
