import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {projectResume,projectHistory,selectBatch,cacheUsable,analyzeRecord,reportHTML,collectBatch,desktopSource} from './batch.mjs';

const candidate={uid:17,name:'离线甲',jobId:'fixture-job'};
function resume(c=candidate) {
  return {geekBaseInfo:{userId:c.uid,name:c.name,gender:'private-fixture',phone:'private-fixture'},encryptJid:'private-fixture',
    geekEduExpList:[{school:'夹具学校',major:'计算机',degreeName:'本科'}],
    geekWorkExpList:[{company:'夹具公司',positionName:'Java',secret:'private-fixture'}],
    geekProjExpList:[{name:'Agent 服务',roleName:'后端开发'}]};
}
function history(c=candidate,text='独立开发 Java Agent 项目') {
  return {code:0,zpData:{hasMore:false,messages:[{mid:1,time:10,from:{uid:c.uid},to:{uid:90},securityId:'private-fixture',status:1,body:{text}}]}};
}
test('resume projection requires exact identity and excludes credentials and irrelevant personal fields',()=>{
  const projected=projectResume(resume(),candidate);
  assert.equal(projected.fullTextVerified,false);
  assert.equal(projected.projects[0].name,'Agent 服务');
  assert.ok(!JSON.stringify(projected).includes('private-fixture'));
  assert.throws(()=>projectResume(resume({...candidate,uid:18}),candidate),/identity mismatch/);
  assert.throws(()=>projectResume({...resume(),geekProjExpList:null},candidate),/schema changed/);
});
test('batch selection confines one visible snapshot to exact UID/name/job and deduplicates',()=>{
  const friends=[candidate,{...candidate,name:'同UID异名'},{uid:18,name:'其他岗位',jobId:'other'}];
  const row={id:'_17-0',uid:17,name:candidate.name};
  assert.equal(selectBatch(friends,[row,row,{id:'_18-0',uid:18,name:'其他岗位'}],'fixture-job',20).length,1);
  assert.equal(selectBatch([candidate,candidate],[row],'fixture-job',20).length,0);
  assert.throws(()=>selectBatch(friends,[row],'fixture-job',51));
  assert.throws(()=>selectBatch(friends,[row],'fixture-job',NaN));
});
test('history projection binds participants and detects substantive changes without persisting security envelopes',()=>{
  const first=projectHistory(history(),candidate), changed=history();
  changed.zpData.messages[0].status=2;changed.zpData.messages[0].securityId='rotated';
  assert.equal(projectHistory(changed,candidate).contentSha256,first.contentSha256);
  changed.zpData.messages[0].body.text='新的候选人答复';
  assert.notEqual(projectHistory(changed,candidate).contentSha256,first.contentSha256);
  changed.zpData.messages[0].from.uid=999;
  assert.throws(()=>projectHistory(changed,candidate),/sender|identity/);
  assert.ok(!JSON.stringify(first).includes('private-fixture'));
});
test('cache is bound to identity/job, history content and a bounded non-future timestamp',()=>{
  const h=projectHistory(history(),candidate), now=100000;
  const record={schemaVersion:1,candidate,history:h,resume:{status:'summary',obtainedAt:new Date(now-1000).toISOString(),summary:projectResume(resume(),candidate)}};
  assert.equal(cacheUsable(record,candidate,h,now,2000),true);
  assert.equal(cacheUsable(record,{...candidate,jobId:'other'},h,now,2000),false);
  assert.equal(cacheUsable(record,candidate,h,now,100),false);
  assert.equal(cacheUsable(record,candidate,h,now-2000,2000),false);
  assert.equal(cacheUsable(record,candidate,{...h,contentSha256:'changed'},now,2000),false);
  assert.equal(cacheUsable({...record,resume:{...record.resume,summary:{...record.resume.summary,projects:[null]}}},candidate,h,now,2000),false);
});
test('analysis separates existing conversations and stop requests and renders hostile text inert',()=>{
  const record={candidate,history:projectHistory(history(),candidate),resume:{status:'summary',summary:projectResume(resume(),candidate)}};
  const a=analyzeRecord(record);assert.equal(a.eligibleForContactReview,true);assert.equal(a.screeningPassed,false);assert.equal(a.abilityScore,null);
  assert.equal(analyzeRecord({...record,history:{...record.history,outboundCount:1}}).eligibleForContactReview,false);
  const stopped=analyzeRecord({...record,history:projectHistory(history(candidate,'不要再联系 <script>alert(1)</script>'),candidate)});
  assert.equal(stopped.eligibleForContactReview,false);
  const html=reportHTML([stopped]);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
});

test('batch collects with one source, checkpoints records, reuses fresh resumes and refreshes changed greetings',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-batch-fixture-'));
  const other={uid:18,name:'离线乙',jobId:'fixture-job'}, people=[candidate,other];
  const calls={lists:0,histories:0,resumes:0,restores:0};let changed=false;
  const source={
    async list(){calls.lists++;return {friends:people,rows:people.map(c=>({id:'_'+c.uid,uid:c.uid,name:c.name}))};},
    async history(c){calls.histories++;return history(c,changed&&c.uid===17?'新增项目答复':'独立开发 Java Agent 项目');},
    async resume(c){calls.resumes++;return resume(c);},
    async restore(){calls.restores++;},
  };
  const job={boss_job_id:'fixture-job',job_name:'夹具岗位'};
  try {
    const first=path.join(root,'first'),second=path.join(root,'second');
    const a=await collectBatch(source,{job,out:first,now:()=>100000});
    assert.equal(a.stats.selected,2);assert.equal(calls.resumes,2);assert.equal(calls.restores,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first,'manifest.json'),'utf8')).authorizedContacting,false);
    assert.ok(!fs.readFileSync(path.join(first,'records','17.json'),'utf8').includes('private-fixture'));
    const b=await collectBatch(source,{job,out:second,cache:first,now:()=>101000});
    assert.equal(b.stats.cacheHits,2);assert.equal(calls.resumes,2);
    const cachedFile=path.join(second,'records','17.json'),bad=JSON.parse(fs.readFileSync(cachedFile,'utf8'));
    bad.resume.summary.projects=[null];fs.writeFileSync(cachedFile,JSON.stringify(bad));
    const repaired=path.join(root,'repaired');
    const repairedResult=await collectBatch(source,{job,out:repaired,cache:second,now:()=>101500});
    assert.equal(repairedResult.stats.cacheHits,1);assert.equal(calls.resumes,3);
    changed=true;
    const d=await collectBatch(source,{job,out:path.join(root,'third'),cache:repaired,now:()=>102000});
    assert.equal(d.stats.cacheHits,1);assert.equal(calls.resumes,4);assert.equal(calls.restores,4);
    await assert.rejects(()=>collectBatch(source,{job,out:first}),/new batch output/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('batch history failure restores UI and leaves completed checkpoints without inventing a final report',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-batch-failure-'));let restored=false;
  const out=path.join(root,'run');
  try {
    await assert.rejects(()=>collectBatch({async list(){return {friends:[candidate],rows:[{id:'_17',uid:17,name:candidate.name}]};},async history(){throw Error('fixture denial');},async restore(){restored=true;}},{job:{boss_job_id:'fixture-job',job_name:'fixture'},out}),/fixture denial/);
    assert.equal(restored,true);assert.equal(fs.existsSync(path.join(out,'manifest.json')),true);assert.equal(fs.existsSync(path.join(out,'analysis.json')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('desktop reader waits for old frames and clicks the actual name control before opening the matching resume',async()=>{
  let frames=2,closed=false,rootClicked=false,loaded=18,opened=0,closePolls=0;
  const name={getAttribute:()=>candidate.name,click(){loaded=candidate.uid;}};
  const row={__vue__:{$props:{geek:{uid:candidate.uid}}},querySelector:()=>name,click(){rootClicked=true;}};
  const closeButton={click(){closed=true;}};
  const dialog={getBoundingClientRect:()=>({width:700}),querySelectorAll:()=>[closeButton]};
  const online={click(){assert.equal(frames,0,'must finish closing the old identity first');assert.equal(loaded,candidate.uid);opened++;}};
  const document={
    getElementById:()=>row,
    querySelector:()=>({__vue__:{$props:{geek:{uid:loaded}}}}),
    querySelectorAll(selector){return selector==='.resume-container'?[dialog]:selector==='a.resume-btn-online'?[online]:[];},
  };
  const ctx={
    async renderer(kind,expression){assert.equal(kind,'view');return vm.runInNewContext(expression,{document});},
    async main(body,data){if(data?.probe)return {ready:true,value:resume()};assert.equal(closed,true);closePolls++;frames=Math.max(0,frames-1);return frames;},
  };
  const value=await desktopSource(ctx).resume(candidate,{id:'_17'});
  assert.equal(value.geekBaseInfo.userId,candidate.uid);assert.equal(opened,1);assert.equal(rootClicked,false);assert.equal(closePolls,2);
});

test('renderer throttling is restored even when normal resume close fails',async()=>{
  const web=[3,5].map(id=>({id,value:true,getBackgroundThrottling(){return this.value;},setBackgroundThrottling(value){this.value=value;},isDestroyed(){return false;}}));
  const document={querySelectorAll(selector){return selector==='.geek-item'?[]:[{getBoundingClientRect:()=>({width:600}),querySelectorAll:()=>[]}];}};
  const ctx={
    async bridge(type,act){return act==='_sdk_getLoginStatus'?{code:0,data:true}:{code:0,zpData:{friendList:[]}};},
    async renderer(kind,expression){return vm.runInNewContext(expression,{document});},
    async main(body,data={}){return new Function('data','roots','views','all',body)(data,[web[0]],[web[1]],web);},
  };
  const source=desktopSource(ctx);await source.list();assert.deepEqual(web.map(x=>x.value),[false,false]);
  await assert.rejects(()=>source.restore(),/close control changed/);
  assert.deepEqual(web.map(x=>x.value),[true,true]);
});

test('invalid batch bounds fail before reading the client or creating outputs',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-batch-bounds-'));let called=false;
  try {
    const out=path.join(root,'run');
    await assert.rejects(()=>collectBatch({async list(){called=true;}},{job:{boss_job_id:'fixture',job_name:'fixture'},out,limit:51}),/limit/);
    assert.equal(called,false);assert.equal(fs.existsSync(out),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('a vanished original conversation fails restoration explicitly and still restores throttling',async()=>{
  const web=[3,5].map(id=>({id,value:true,mainFrame:{framesInSubtree:[]},getBackgroundThrottling(){return this.value;},setBackgroundThrottling(v){this.value=v;},isDestroyed(){return false;}}));
  const row={id:'_17',__vue__:{$props:{geek:{uid:17}}},querySelector:()=>({getAttribute:()=>candidate.name}),classList:{contains:()=>true}};
  const document={querySelectorAll:s=>s==='.geek-item'?[row]:[],getElementById:()=>null};
  const ctx={async bridge(t,a){return a==='_sdk_getLoginStatus'?{code:0,data:true}:{code:0,zpData:{friendList:[]}};},async renderer(k,e){return vm.runInNewContext(e,{document});},async main(body,data={}){return new Function('data','roots','views','all',body)(data,[web[0]],[web[1]],web);}};
  const source=desktopSource(ctx);await source.list();
  await assert.rejects(()=>source.restore(),/restoration incomplete/);
  assert.deepEqual(web.map(x=>x.value),[true,true]);
});
test('desktop snapshot exposes scroll/message metadata and scroll input is finite and clamped',async()=>{
  let scrollEvents=0;
  const list={scrollTop:0,scrollHeight:2400,clientHeight:600,dispatchEvent(event){assert.equal(event.type,'scroll');scrollEvents++;}};
  const row={id:'_17',classList:{contains:name=>name==='selected'},__vue__:{$props:{geek:{uid:17,jobName:'fixture-job',relationType:1,newMsgCount:2,lastIsSelf:false,lastTS:123}}},querySelector:()=>({getAttribute:()=>candidate.name})};
  const document={querySelector:s=>s==='.user-list'?list:null,querySelectorAll:s=>s==='.geek-item'?[row]:[]};
  const ctx={async renderer(kind,expression){assert.equal(kind,'view');return vm.runInNewContext(expression,{document,Event});}};
  const source=desktopSource(ctx);
  const snapshot=await source.visible();
  assert.equal(snapshot.scrollHeight,2400);assert.equal(JSON.stringify(snapshot.rows[0]),JSON.stringify({id:'_17',uid:17,name:candidate.name,jobName:'fixture-job',relationType:1,newMsgCount:2,lastIsSelf:false,lastTS:123,selected:true}));
  assert.equal((await source.scrollTo(99999)).scrollTop,1800);
  assert.equal((await source.scrollTo(-10)).scrollTop,0);
  await assert.rejects(()=>source.scrollTo(NaN),/finite/);
  assert.equal(scrollEvents,2);
});

test('desktop close fails before clicking when the resume-dialog guard is exceeded',async()=>{
  let clicked=false;
  const dialog={getBoundingClientRect:()=>({width:700}),querySelectorAll:()=>[{click(){clicked=true;}}]};
  const document={querySelectorAll:s=>s==='.resume-container'?[dialog,dialog,dialog,dialog,dialog]:[]};
  let mainCalls=0;
  const ctx={async renderer(kind,expression){return vm.runInNewContext(expression,{document,Event});},async main(){mainCalls++;return 1;}};
  await assert.rejects(()=>desktopSource(ctx).close(),/Too many resume dialogs/);
  assert.equal(clicked,false);assert.equal(mainCalls,0);
});
test('desktop close retries the dialog click and cannot open a new identity before the old frame closes',async()=>{
  let closeClicks=0,frames=1,loaded=18,openedAtClick=null,nameClicked=false;
  const closeButton={click(){closeClicks++;if(closeClicks===2)frames=0;}};
  const dialog={getBoundingClientRect:()=>({width:700}),querySelectorAll:s=>s==='.close-btn'?[closeButton]:[]};
  const name={getAttribute:()=>candidate.name,click(){if(frames!==0)throw Error('opened before close confirmed');nameClicked=true;loaded=candidate.uid;}};
  const row={__vue__:{$props:{geek:{uid:candidate.uid}}},querySelector:s=>s==='.geek-name'?name:null,click(){throw Error('row root must not be clicked');}};
  const online={click(){assert.equal(frames,0);openedAtClick=closeClicks;}};
  const document={
    getElementById:()=>row,
    querySelector:()=>({__vue__:{$props:{geek:{uid:loaded}}}}),
    querySelectorAll:s=>s==='.resume-container'&&frames?[dialog]:s==='a.resume-btn-online'?[online]:[],
  };
  const ctx={
    async renderer(kind,expression){assert.equal(kind,'view');return vm.runInNewContext(expression,{document,Event});},
    async main(body,data={}){if(data?.probe)return {ready:true,value:resume()};return frames;},
  };
  const value=await desktopSource(ctx).resume(candidate,row);
  assert.equal(value.geekBaseInfo.userId,candidate.uid);assert.equal(closeClicks,2);assert.equal(openedAtClick,2);assert.equal(nameClicked,true);
});
