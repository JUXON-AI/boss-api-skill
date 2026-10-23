// Scores are supplied from reviewed capability evidence, never inferred from keywords.
export function scoreInternship(dimensions, awards = []) {
  const weights={core_role_skills:35,project_depth:30,engineering_habits:20,learning_and_collaboration:15};
  let weighted=0,coverage=0;
  for(const [key,weight] of Object.entries(weights)) {
    const score=dimensions[key];
    if(score===null)continue;
    if(!Number.isFinite(score)||score<0||score>100)throw Error('Capability score must be null or 0..100: '+key);
    weighted+=weight*score;coverage+=weight;
  }
  const bonuses={national:[10,8,6],provincial:[6,4,2],school:[2,1,1]};
  let awardBonus=0;
  const awardEvidence=[];
  for(const award of awards) {
    if(award.jobRelevant!==true)continue;
    if(!award.competition?.trim()||!award.prize?.trim()||!award.source?.trim())throw Error('Award name, prize and source are required');
    if(!['self_reported','document_provided'].includes(award.claimStatus))throw Error('Award claim status is required');
    if(!bonuses[award.level]||![1,2,3].includes(award.placement))throw Error('Award level/placement is unknown; keep bonus pending');
    const bonus=bonuses[award.level][award.placement-1];
    awardBonus=Math.max(awardBonus,bonus);
    awardEvidence.push({...award,bonus});
  }
  const base=coverage?Math.round(weighted/coverage*100)/100:null;
  return {abilityBaseScore:base,awardBonus,abilityScore:base===null?null:Math.min(100,Math.round((base+awardBonus)*100)/100),evidenceCoveragePercent:coverage,awardEvidence,requiresHumanReview:true};
}
