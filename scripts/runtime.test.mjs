import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash, historyFingerprint, selectContact, attachmentURL, checkApproval, newSentMatches, save} from './runtime.mjs';
import {powershell} from './platform.mjs';

test('history fingerprint ignores only rotating envelope securityId and still binds message content',()=>{
  const message={mid:10,time:123,from:{uid:12},to:{uid:7},securityId:'old',body:{text:'原文',resume:{securityId:'body-value'}}};
  const digest=historyFingerprint([message]);
  assert.equal(historyFingerprint([{...message,securityId:'new'}]),digest);
  for(const changed of [
    {...message,mid:11}, {...message,time:124}, {...message,from:{uid:99}}, {...message,to:{uid:99}},
    {...message,body:{...message.body,text:'改写'}}, {...message,body:{...message.body,resume:{securityId:'changed'}}},
  ]) assert.notEqual(historyFingerprint([changed]),digest);
  assert.notEqual(historyFingerprint([message,message]),digest);
  assert.equal(message.securityId,'old');
});

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
  try{
    const file=path.join(dir,'private','fixture.json');save(file,{fixture:true});
    if(process.platform==='win32') {
      const acl=JSON.parse(powershell(`$a=[IO.File]::GetAccessControl($data.path); @{
        protectedParent=[IO.Directory]::GetAccessControl([IO.Path]::GetDirectoryName($data.path)).AreAccessRulesProtected;
        allowed=@($a.Access | Where-Object AccessControlType -eq Allow | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value});
        own=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress`,{path:file}));
      assert.equal(acl.protectedParent,true);
      assert.ok(acl.allowed.includes(acl.own));
      assert.ok(acl.allowed.every(sid=>[acl.own,'S-1-5-18'].includes(sid)));
    } else assert.equal(fs.statSync(file).mode&0o777,0o600);
    assert.throws(()=>save(file,{}));
  }
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function fixtureAsar(dir, encrypted=false, badHash=false, unpacked=false) {
  const bytes=Buffer.from('{"name":"offline-fixture"}');
  const header={files:{'package.json':{size:bytes.length,offset:'0',unpacked,integrity:{hash:badHash?'0'.repeat(64):hash(bytes)},...(encrypted?{encryption:'fixture-encryption',encryptedSize:bytes.length}:{})}}};
  const json=Buffer.from(JSON.stringify(header)), size=8+json.length;
  const prefix=Buffer.alloc(16);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(size,4);prefix.writeUInt32LE(size-4,8);prefix.writeUInt32LE(json.length,12);
  const file=path.join(dir,'fixture.asar');fs.writeFileSync(file,Buffer.concat([prefix,json,bytes]));return {file,bytes};
}

for(const junction of [false,true]) test('ASAR unpacked companion '+(junction?'rejects junction escape':'extracts an ordinary directory'),()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-companion-'));
  try {
    const {file,bytes}=fixtureAsar(dir,false,false,true), companion=file+'.unpacked';
    const external=path.join(dir,'external-fixture');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'package.json'),bytes);
    if(junction)fs.symlinkSync(external,companion,process.platform==='win32'?'junction':'dir');
    else {fs.mkdirSync(companion);fs.writeFileSync(path.join(companion,'package.json'),bytes);}
    const dest=path.join(dir,'private','out.json');
    const result=spawnSync(process.execPath,[asarScript,file,'extract','package.json',dest],{encoding:'utf8'});
    if(junction){assert.notEqual(result.status,0);assert.match(result.stderr,/ordinary directory/);assert.equal(fs.existsSync(dest),false);}
    else {assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(dest),bytes);}
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
const asarScript=fileURLToPath(new URL('./asar.mjs',import.meta.url));
for(const mode of ['ordinary','encrypted','bad-hash']) {
  test('ASAR extraction: '+mode,()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-skill-asar-'));
    try{
      const {file,bytes}=fixtureAsar(dir,mode==='encrypted',mode==='bad-hash'),dest=path.join(dir,'private','out.json');
      const r=spawnSync(process.execPath,[asarScript,file,'extract','package.json',dest],{encoding:'utf8'});
      if(mode==='ordinary'){assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readFileSync(dest),bytes);}
      else{assert.notEqual(r.status,0);assert.equal(fs.existsSync(dest),false);}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
}
