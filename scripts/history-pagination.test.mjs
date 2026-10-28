import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompleteHistory} from './history-pagination.mjs';
const uid=123, m=id=>({mid:id,time:id,from:{uid},to:{uid:680269483},body:{text:String(id)}});
test('uses real cursor and combines pages including terminal overlap', async()=>{
  const calls=[], pages=[{messages:[m(3),m(4)],hasMore:true},{messages:[m(1),m(2),m(3)],hasMore:true},{messages:[m(1)],hasMore:false}];
  const r=await readCompleteHistory(async p=>{calls.push(p.maxMsgId);return {code:0,zpData:pages.shift()};},{uid,securityId:'test'});
  assert.deepEqual(calls,[0,3,1]); assert.deepEqual(r.zpData.messages.map(x=>x.mid),[1,2,3,4]);
});
test('repeating nonterminal page fails rather than pretending complete',async()=>{
  await assert.rejects(readCompleteHistory(async()=>({code:0,zpData:{messages:[m(3)],hasMore:true}}),{uid}),/no progress/);
});
test('rejects wrong participant and missing terminal flag',async()=>{
  await assert.rejects(readCompleteHistory(async()=>({code:0,zpData:{messages:[{...m(1),from:{uid:999}}],hasMore:false}}),{uid}),/identity/);
  await assert.rejects(readCompleteHistory(async()=>({code:0,zpData:{messages:[m(1)]}}),{uid}),/schema/);
});
test('single page retains original ordering and response fields',async()=>{
  const r=await readCompleteHistory(async()=>({code:0,message:'ok',zpData:{messages:[m(4),m(3)],hasMore:false}}),{uid});
  assert.deepEqual(r.zpData.messages.map(x=>x.mid),[4,3]);assert.equal(r.message,'ok');
});
