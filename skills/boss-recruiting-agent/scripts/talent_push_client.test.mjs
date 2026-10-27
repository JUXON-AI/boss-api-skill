import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {drainTalentPush} from './talent_push_client.mjs';
import {talentPushConfigId} from './talent_push_identity.mjs';
test('an unknown result stops draining all run sources and never retries the event',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talent-push-client-fixture-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('talent-push-client-fixture-'));fs.rmSync(dir,{recursive:true,force:true});});
  const states=[1,2].map(uid=>{const f=path.join(dir,'state-'+uid+'.json');fs.writeFileSync(f,JSON.stringify({handoffs:[{uid,recordId:'recFixture'+uid,bossHandoffSent:true,completedAt:'2026-02-01T00:00:00Z'}]}));return {stateFile:f};});
  const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify({host:'127.0.0.1',port:17867,token:'a'.repeat(64),jobId:'7',enabledAt:'2026-01-01T00:00:00Z',bootstrapRecordIds:[],runSources:states}));
  const configId=talentPushConfigId(JSON.parse(fs.readFileSync(configFile,'utf8')),configFile);
  const posts=[];t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).endsWith('/health'))return new Response(JSON.stringify({ok:true,service:'boss-talent-push',version:1,configId}),{status:200});posts.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:false,error:'service_unavailable'}),{status:503});});
  const result=await drainTalentPush(configFile);assert.equal(result.ok,false);assert.equal(result.pending,1);assert.equal(posts.length,1);assert.equal(posts[0].uid,'1');
});

test('wrong routing identity refuses the existing service before posting',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talent-push-binding-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('talent-push-binding-'));fs.rmSync(dir,{recursive:true,force:true});});
  const stateFile=path.join(dir,'state.json');fs.writeFileSync(stateFile,JSON.stringify({handoffs:[{uid:1,recordId:'recFixture1',bossHandoffSent:true,completedAt:'2026-02-01T00:00:00Z'}]}));
  const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify({host:'127.0.0.1',port:17867,token:'a'.repeat(64),jobId:'7',enabledAt:'2026-01-01T00:00:00Z',runSources:[{stateFile}]}));
  let calls=0;t.mock.method(globalThis,'fetch',async(url)=>{calls++;assert.ok(String(url).endsWith('/health'));return new Response(JSON.stringify({ok:true,service:'boss-talent-push',version:1,configId:'0'.repeat(64)}),{status:200});});
  await assert.rejects(drainTalentPush(configFile),{code:'WEBHOOK_BINDING_MISMATCH'});assert.equal(calls,1);
});

test('routing binding changes with destination or config path but permits live policy changes',()=>{
  const c={host:'127.0.0.1',port:17867,chatId:'oc_fixture',appId:'cli_fixture',mode:'live',paused:false};const file=path.resolve('fixture-config.json'),id=talentPushConfigId(c,file);
  assert.notEqual(talentPushConfigId({...c,chatId:'oc_other'},file),id);assert.notEqual(talentPushConfigId(c,file+'.other'),id);
  assert.equal(talentPushConfigId({...c,mode:'preview',paused:true},file),id);
});
