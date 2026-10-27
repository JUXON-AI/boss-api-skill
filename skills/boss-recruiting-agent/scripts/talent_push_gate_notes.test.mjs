import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTalentGateNotes} from './talent_push_gate_notes.mjs';
const notes = () => ({questionMid: 8, gates: ['salary','onsite','days','duration','school','arrival'].map((condition,i)=>({condition,mid:i+1,quote:'exact-'+i}))});
test('normalizes only internal names and preserves candidate evidence and original object',()=>{
  const input=notes(),before=structuredClone(input),result=normalizeTalentGateNotes(input);
  assert.deepEqual(input,before);assert.equal(result.questionMid,8);
  assert.deepEqual(result.gates.map(g=>g.condition),['salary','location','onsite_days','duration','school','arrival']);
  assert.deepEqual(result.gates.map(({mid,quote})=>({mid,quote})),before.gates.map(({mid,quote})=>({mid,quote})));
  assert.deepEqual(normalizeTalentGateNotes(result),result);
});
test('rejects duplicate aliases, missing gates and unknown conditions',()=>{
  for(const mutate of [n=>n.gates.push({...n.gates[1],condition:'location'}),n=>n.gates.pop(),n=>n.gates[0].condition='compensation']){
    const n=notes();mutate(n);assert.throws(()=>normalizeTalentGateNotes(n));
  }
});
