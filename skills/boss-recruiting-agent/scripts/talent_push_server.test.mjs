import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {matchesTalentPushMessage,assertTalentPushBoundary,readTalentPushEvidence,assertTalentGateEvidence} from './talent_push_server.mjs';
const config={chatId:'oc_fixture',botOpenId:'ou_fixture_bot',appId:'cli_fixture'};
const content={zh_cn:{title:'合成初筛记录',content:[[{tag:'text',text:'姓名：示例甲'}],[{tag:'text',text:'基础：70'}],[{tag:'a',text:'人才库',href:'https://example.feishu.cn/base/fixture'}]]}};
const plan={content};
const message={message_id:'om_fixture',chat_id:config.chatId,msg_type:'post',deleted:false,sender:{id:config.appId,sender_type:'app'},content:'合成初筛记录\n姓名：示例甲\n基础：70\n[人才库](https://example.feishu.cn/base/fixture)'};
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
test('document availability requires original bytes and exact main-approved identity binding',()=>{
  const documentBytes=Buffer.from('%PDF-fixture'),textBytes=Buffer.from('每周5天，一周内到岗'),gate={condition:'onsite_days',sourceType:'document',quote:'每周5天',fileSha256:digest(documentBytes),textSha256:digest(textBytes)};
  const gates=[gate,...['arrival','duration','location','salary','school'].map(condition=>({condition}))];
  const input={messages:[],uid:1,jobId:'job',ownBossUid:2,approvedDocumentEvidence:{accepted:true,uid:1,documentIdentityVerified:true,documentTextSHA:gate.textSha256,gates},documentBytes,textBytes};
  assert.doesNotThrow(()=>assertTalentGateEvidence(gate,input));
  for(const changed of [{...input,uid:9},{...input,documentBytes:Buffer.from('changed')},{...input,textBytes:Buffer.from('changed')},{...input,approvedDocumentEvidence:{...input.approvedDocumentEvidence,documentIdentityVerified:false}}])assert.throws(()=>assertTalentGateEvidence(gate,changed));
  assert.throws(()=>assertTalentGateEvidence({...gate,quote:'每周6天'},input));
  assert.throws(()=>assertTalentGateEvidence({...gate,condition:'salary'},input));
});
test('message and profile gates retain both identity and job checks',()=>{
  const messages=[{mid:4,from:{uid:1},to:{uid:2},body:{text:'可以接受'}},{mid:5,from:{uid:1},to:{uid:2},body:{resume:{user:{uid:1},jobId:'job',applyStatus:'随时到岗'}}}],input={messages,uid:1,jobId:'job',ownBossUid:2};
  assert.doesNotThrow(()=>assertTalentGateEvidence({condition:'salary',mid:4,quote:'可以接受'},input));
  const gate={condition:'arrival',mid:5,quote:'随时到岗'};
  assert.doesNotThrow(()=>assertTalentGateEvidence(gate,input));
  assert.throws(()=>assertTalentGateEvidence(gate,{...input,jobId:'other'}));
  assert.throws(()=>assertTalentGateEvidence(gate,{...input,uid:2}));
});
test('verifies exact CLI text projection and equivalent native post JSON',()=>{
  assert.equal(matchesTalentPushMessage(message,plan,config,'om_fixture'),true);
  assert.equal(matchesTalentPushMessage({...message,content:JSON.stringify(content.zh_cn)},plan,config,'om_fixture'),true);
  const native=structuredClone(content);native.zh_cn.content[0][0].style=[];
  assert.equal(matchesTalentPushMessage({...message,content:JSON.stringify(native)},plan,config,'om_fixture'),true);
});
test('rejects a different recipient, sender, message, link, score, deletion or partial text',()=>{
  const variants=[{...message,chat_id:'oc_other'},{...message,sender:{id:'cli_other',sender_type:'app'}},{...message,sender:{id:config.appId,sender_type:'user'}},{...message,message_id:'om_other'},{...message,content:message.content.replace('基础：70','基础：90')},{...message,content:message.content.replace('/fixture)','/other)')},{...message,deleted:true},{...message,content:'姓名：示例甲'}];
  for(const changed of variants)assert.equal(matchesTalentPushMessage(changed,plan,config,'om_fixture'),false);
});
test('send boundary blocks mode, policy, pause and original evidence changes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talent-push-boundary-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('talent-push-boundary-'));fs.rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'accepted.json');fs.writeFileSync(file,'original');const files={[file]:crypto.createHash('sha256').update('original').digest('hex')},before={mode:'live',paused:false,chatId:'oc_fixture'};
  assert.doesNotThrow(()=>assertTalentPushBoundary(before,{...before},false,files));
  assert.throws(()=>assertTalentPushBoundary(before,{...before,mode:'preview'},false,files),/mode changed/);
  assert.throws(()=>assertTalentPushBoundary(before,{...before,paused:true},false,files),/policy changed/);
  assert.throws(()=>assertTalentPushBoundary(before,{...before},true,files),/pause changed/);
  fs.writeFileSync(file,'changed');assert.throws(()=>assertTalentPushBoundary(before,{...before},false,files),/source changed/);
});
test('parsed evidence and proof bind one read even if the file changes immediately after it',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'talent-push-read-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('talent-push-read-'));fs.rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'evidence.json'),old='{"state":"hr_review"}',changed='{"state":"paused"}';fs.writeFileSync(file,old);const actualRead=fs.readFileSync;let reads=0;
  const mock=t.mock.method(fs,'readFileSync',function(target,...args){const bytes=actualRead.call(fs,target,...args);if(target===file){reads++;fs.writeFileSync(file,changed);}return bytes;});
  const files={},parsed=readTalentPushEvidence(file,files);assert.equal(reads,1);assert.equal(parsed.state,'hr_review');assert.equal(files[file],crypto.createHash('sha256').update(old).digest('hex'));mock.mock.restore();
  assert.throws(()=>assertTalentPushBoundary({mode:'live'},{mode:'live'},false,files),/source changed/);
});
