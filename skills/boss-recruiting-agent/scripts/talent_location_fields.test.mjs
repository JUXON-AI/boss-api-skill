import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildTalentCreateValues} from './talent_profile_fields.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-location-'));
  t.after(() => {assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('talent-location-'));fs.rmSync(dir,{recursive:true,force:true});});
  const write=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  const candidate={uid:101,name:'示例候选',jobId:'7'};
  const snapshot={candidate,history:{original_order_redacted:[{mid:1,time:1790000000000,from:{uid:101},body:{resume:{user:{uid:101,name:candidate.name},jobId:7,city:'期望城市',experiences:[{type:2,organization:'示例大学'}]}}},{mid:2,from:{uid:101},body:{text:'我住在示例区'}}]}};
  const source=write('snapshot.json',snapshot),sourceSha256=hash(fs.readFileSync(source));
  const dataset=write('public-dataset.txt','示例大学\t示例市');
  const registryFile=write('registry.json',{source:dataset,sourceSha256:hash(fs.readFileSync(dataset)),schools:{'示例大学':{school:'示例大学',location:'示例市',ambiguity:false,sourceURL:'https://www.moe.gov.cn/example'}}});
  const policy={enabled:true,jobId:'7',useSchoolDefault:true,registry:{source:registryFile,sourceSha256:hash(fs.readFileSync(registryFile))}};
  const locationPolicyFile=write('policy.json',policy);
  return {candidate,source,sourceSha256,locationPolicyFile,values:{姓名:candidate.name,岗位:'示例岗位',能力评分:77},snapshot,policy,write,dataset,registryFile};
}
test('future create hook fills school default while preserving scores and ignoring expected city',t=>{
 const f=fixture(t),p=buildTalentCreateValues(f);assert.equal(p.values['现居地'],'示例市（学校所在地默认）');assert.equal(p.values['能力评分'],77);assert.equal(p.location.status,'school_default');
});
test('verified own residence takes priority over school default',t=>{
 const f=fixture(t);const currentResidence={...f.candidate,kind:'current_residence',source:f.source,sourceSha256:f.sourceSha256,messageMid:2,quote:'我住在示例区',location:'示例区'};
 assert.equal(buildTalentCreateValues({...f,currentResidence}).values['现居地'],'示例区（资料现居地）');
 assert.throws(()=>buildTalentCreateValues({...f,currentResidence:{...currentResidence,messageMid:1}}),/quote missing/);
 assert.throws(()=>buildTalentCreateValues({...f,currentResidence:{...currentResidence,jobId:'other'}}));
});
test('actual source and geography bytes are checked before payload generation',t=>{
 const f=fixture(t);fs.appendFileSync(f.registryFile,' ');assert.throws(()=>buildTalentCreateValues(f),/location source bytes changed/);
 const g=fixture(t);fs.appendFileSync(g.dataset,' ');assert.throws(()=>buildTalentCreateValues(g),/geography dataset changed/);
});
test('unknown school or disabled fallback omits location, never copies expected city',t=>{
 const f=fixture(t);f.policy.useSchoolDefault=false;f.write('policy.json',f.policy);
 assert.equal(buildTalentCreateValues(f).values['现居地'],undefined);
 assert.ok(buildTalentCreateValues(f).omittedFields.includes('现居地'));
});
test('existing location conflict blocks a create payload',t=>{
 const f=fixture(t);assert.throws(()=>buildTalentCreateValues({...f,values:{...f.values,'现居地':'已确认的别处'}}),/location conflicts/);
});
