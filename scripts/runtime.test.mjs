import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash, selectContact, attachmentURL, checkApproval, newSentMatches, save} from './runtime.mjs';

test('candidate selection rejects same name with another UID, duplicate identities and wrong job',()=>{
  const a={uid:12,name:'测试甲',jobId:'job-a'}, b={uid:13,name:'测试甲',jobId:'job-b'};
  assert.equal(selectContact([a,b],12,'测试甲','job-a'),a);
  assert.throws(()=>selectContact([a,b],12,'测试乙'));
  assert.throws(()=>selectContact([a,a],12,'测试甲'));
  assert.throws(()=>selectContact([a,b],12,'测试甲','job-b'));
});

function attachment(uid=12, url='https://m.zhipin.com/wflow/zpgeek/download/preview4boss?id=fixture') {
  return {from:{uid},body:{hyperLink:{url:'bosszp://resume?type=selectResumePreviewUrl&url='+encodeURIComponent(url)}}};
}
test('attachment accepts expected received link and rejects another sender, wrong origin and action',()=>{
  assert.equal(new URL(attachmentURL(attachment(),12)).hostname,'m.zhipin.com');
  assert.throws(()=>attachmentURL(attachment(13),12));
  assert.throws(()=>attachmentURL(attachment(12,'https://evil.example/a.pdf'),12));
  assert.throws(()=>attachmentURL({from:{uid:12},body:{hyperLink:{url:'bosszp://resume?type=exchangePhone'}}},12));
});

function approval(){const text='离线测试，不发送';return {recipient:{uid:12,name:'测试甲'},text,textSha256:hash(text),expectedHistorySha256:hash('[]'),approved:true,approval:{recipientCount:1,userMessage:'离线测试夹具',approvedTextSha256:hash(text)}};}
test('approval rejects edited text, false approval, multiple recipients and missing reviewed history',()=>{
  checkApproval(approval());
  for(const change of [a=>a.text+='改动',a=>a.approved=false,a=>a.approval.recipientCount=2,a=>delete a.expectedHistorySha256,a=>a.approval.userMessage='']) {
    const a=approval();change(a);assert.throws(()=>checkApproval(a));
  }
});

test('history verification accepts only new outbound record for the approved recipient',()=>{
  const old={mid:10,from:{uid:7},to:{uid:12},body:{text:'原文'}};
  const current={...old,mid:11};
  assert.deepEqual(newSentMatches([old],[old,current],'原文',7,12),[current]);
  assert.equal(newSentMatches([old],[old],'原文',7,12).length,0);
  assert.equal(newSentMatches([old],[{...current,to:{uid:99}}],'原文',7,12).length,0);
  assert.equal(newSentMatches([old],[{...current,from:{uid:12},to:{uid:7}}],'原文',7,12).length,0);
  assert.equal(newSentMatches([old],[current,{...current,mid:12}],'原文',7,12).length,2);
});

test('sensitive output is private and cannot overwrite an existing file',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-skill-save-'));
  try{const file=path.join(dir,'private.json');save(file,{fixture:true});assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>save(file,{}));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function fixtureAsar(dir, encrypted=false, badHash=false) {
  const bytes=Buffer.from('{"name":"offline-fixture"}');
  const header={files:{'package.json':{size:bytes.length,offset:'0',integrity:{hash:badHash?'0'.repeat(64):hash(bytes)},...(encrypted?{encryption:'fixture-encryption',encryptedSize:bytes.length}:{})}}};
  const json=Buffer.from(JSON.stringify(header)), size=8+json.length;
  const prefix=Buffer.alloc(16);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(size,4);prefix.writeUInt32LE(size-4,8);prefix.writeUInt32LE(json.length,12);
  const file=path.join(dir,'fixture.asar');fs.writeFileSync(file,Buffer.concat([prefix,json,bytes]));return {file,bytes};
}
const asarScript=fileURLToPath(new URL('./asar.mjs',import.meta.url));
for(const mode of ['ordinary','encrypted','bad-hash']) {
  test('ASAR extraction: '+mode,()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-skill-asar-'));
    try{
      const {file,bytes}=fixtureAsar(dir,mode==='encrypted',mode==='bad-hash'),dest=path.join(dir,'out.json');
      const r=spawnSync(process.execPath,[asarScript,file,'extract','package.json',dest],{encoding:'utf8'});
      if(mode==='ordinary'){assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readFileSync(dest),bytes);}
      else{assert.notEqual(r.status,0);assert.equal(fs.existsSync(dest),false);}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
}
