import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateDirectory} from '../../../scripts/platform.mjs';
import {validateCandidateRecord, canonicalJsonSha256} from './candidate_ledger.mjs';
import {buildTalentPush, talentPushEventKey} from './talent_push.mjs';
import {createTalentPushHttpServer} from './talent_push_http.mjs';
import {talentPushConfigId} from './talent_push_identity.mjs';
import {normalizeTalentGateNotes} from './talent_push_gate_notes.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const scalar=value=>Array.isArray(value)?value[0]:value;
const safeUid=value=>{const s=String(value);assert.match(s,/^[1-9]\d*$/);assert.ok(Number.isSafeInteger(Number(s)));return s;};

/** The decision and its proof must use exactly the same read bytes. */
export function readTalentPushEvidence(file,files){
  const bytes=fs.readFileSync(file);files[file]=hash(bytes);return JSON.parse(bytes.toString('utf8'));
}

/** Recheck policy and immutable evidence immediately before the exclusive attempt. */
export function assertTalentPushBoundary(before,current,isPaused,files){
  assert.equal(current.mode,'live','service mode changed before send');
  assert.equal(canonicalJsonSha256(current),canonicalJsonSha256(before),'notification policy changed during preflight');
  assert.equal(isPaused,false,'notification pause changed before send');
  for(const [file,sha]of Object.entries(files))assert.equal(hash(fs.readFileSync(file)),sha,'accepted source changed during preflight');
}
function contained(file,roots){const absolute=path.resolve(file);assert.ok(roots.some(root=>{const r=path.relative(path.resolve(root),absolute);return !r.startsWith('..')&&!path.isAbsolute(r);}), 'evidence outside configured recruitment roots');return absolute;}

function normalizedPost(content){
  const decoded=typeof content==='string'?JSON.parse(content):content;
  const post=decoded.zh_cn??decoded;
  assert.ok(post&&Array.isArray(post.content),'post content unavailable');
  return JSON.stringify({title:post.title??'',content:post.content.map(row=>row.map(node=>{
    assert.ok(['text','a'].includes(node.tag),'unexpected post node');
    return node.tag==='a'?{tag:'a',text:node.text,href:node.href}:{tag:'text',text:node.text};
  }))});
}

function postAsCliText(content){
  const decoded=typeof content==='string'?JSON.parse(content):content,post=decoded.zh_cn??decoded;
  const lines=post.content.map(row=>row.map(node=>node.tag==='a'?`[${node.text}](${node.href})`:node.text).join(''));
  return [post.title??'',...lines].join('\n');
}

/** Verify both native post JSON and the CLI's normalized Markdown projection. */
export function matchesTalentPushMessage(message,plan,config,messageId){
  if((messageId&&message.message_id!==messageId)||message.chat_id!==config.chatId||message.msg_type!=='post'||message.deleted===true||message.sender?.sender_type!=='app'||![config.botOpenId,config.appId].includes(message.sender.id))return false;
  try{return normalizedPost(message.content)===normalizedPost(plan.content);}catch{
    return typeof message.content==='string'&&message.content===postAsCliText(plan.content);
  }
}

export function createTalentPushService(configFile){
  const first=read(configFile);
  assert.equal(first.host,'127.0.0.1');assert.ok(Number.isInteger(first.port)&&first.port>1024&&first.port<65536);
  assert.match(first.token,/^[a-f0-9]{64}$/);assert.ok(path.isAbsolute(first.receiptsDir));
  privateDirectory(first.receiptsDir);
  const configId=talentPushConfigId(first,configFile);
  const config=()=>{const current=read(configFile);for(const key of ['host','port','token','receiptsDir'])assert.equal(current[key],first[key],'restart required for server binding change');assert.equal(talentPushConfigId(current,configFile),configId,'restart required for routing change');return current;};
  function paused(c,uid,states){
    const workspace=c.workspaceConfigFile?read(c.workspaceConfigFile):null;
    return c.paused===true||workspace?.talent_push?.enabled===false||states.some(({state})=>(state.pendingFollowups??[]).some(x=>String(x.uid)===uid&&(String(x.status).startsWith('blocked_')||x.requiresSeparateExplicitDecision===true))||(state.skipped??[]).some(x=>String(x.uid)===uid&&String(x.reason??x.status??'').includes('duplicate')));
  }
  async function cli(c,folder,label,args){
    const outcome=await new Promise(resolve=>execFile(c.cli,args,{cwd:c.workspaceRoot,encoding:'utf8',timeout:45000,windowsHide:true,maxBuffer:16*1024*1024},(error,stdout,stderr)=>resolve({error,stdout:stdout??'',stderr:stderr??''})));
    fs.writeFileSync(path.join(folder,label+'.stdout.txt'),outcome.stdout,{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(folder,label+'.stderr.txt'),outcome.stderr,{flag:'wx',mode:0o600});
    save(path.join(folder,label+'-process.json'),{exitCode:outcome.error?.code??0,signal:outcome.error?.signal??null});
    assert.equal(outcome.error,null,'LARK_CLI_FAILED: '+label);
    const result=JSON.parse(outcome.stdout);if(args[0]==='auth')assert.equal(result.verified,true,'LARK_IDENTITY_FAILED');else assert.equal(result.ok,true,'LARK_API_FAILED: '+label);save(path.join(folder,label+'.json'),result);return result;
  }
  function eventLocation(c,event){assert.equal(String(event.jobId),String(c.jobId));const uid=safeUid(event.uid);assert.match(event.recordId,/^rec[A-Za-z0-9]+$/);const key=talentPushEventKey({chatId:c.chatId,jobId:c.jobId,uid,recordId:event.recordId});return {uid,key,dir:path.join(c.receiptsDir,key)};}
  async function prepare(c,event,folder){
    const evidenceFiles={},readEvidence=file=>readTalentPushEvidence(file,evidenceFiles);
    const {uid}=eventLocation(c,event),states=c.runSources.map(source=>({source,state:readEvidence(source.stateFile)}));
    const isPaused=paused(c,uid,states);assert.equal(isPaused,false,'talent notifications are paused');
    for(const {state}of states){
      assert.ok(!(state.pendingFollowups??[]).some(x=>String(x.uid)===uid&&(String(x.status).startsWith('blocked_')||x.requiresSeparateExplicitDecision===true)),'candidate has a separate-decision pause');
      assert.ok(!(state.skipped??[]).some(x=>String(x.uid)===uid&&String(x.reason??x.status??'').includes('duplicate')),'duplicate account paused');
    }
    const locations=states.filter(({source})=>{const manifest=readEvidence(source.scopeFile);return (manifest.targetUids??manifest.candidates?.map(x=>x.uid)??[]).some(x=>String(x)===uid);});assert.equal(locations.length,1,'candidate must belong to one authorized execution scope');
    const {source,state}=locations[0],handoffs=(state.handoffs??[]).filter(x=>String(x.uid)===uid&&x.recordId===event.recordId&&x.bossHandoffSent===true&&x.completedAt);assert.equal(handoffs.length,1,'verified completed handoff required');const h=handoffs[0];
    assert.ok(Date.parse(h.completedAt)>=Date.parse(c.enabledAt)||(c.bootstrapRecordIds??[]).includes(event.recordId),'historical bulk notifications are disabled');
    const recordFile=path.join(source.ledgerDir,uid+'.json'),record=readEvidence(recordFile),{score}=validateCandidateRecord(record);
    assert.equal(String(record.candidate.uid),uid);assert.equal(String(record.job.boss_job_id),String(c.jobId));assert.equal(record.state,'hr_review');assert.equal(record.job_fit.hard_condition_status,'pass');assert.equal(record.history.complete,true);
    readEvidence(c.jobProfile);assert.equal(evidenceFiles[c.jobProfile],record.job.job_profile_sha256,'job profile changed');
    const acceptanceFile=contained(h.acceptance,c.evidenceRoots),accepted=readEvidence(acceptanceFile);assert.equal(accepted.recordId,event.recordId);assert.equal(String(accepted.uid),uid);assert.equal(accepted.name,record.candidate.name);assert.equal(accepted.HRReviewStatus,'待复核');assert.equal(accepted.independentMatches,1);assert.equal(canonicalJsonSha256(record),accepted.recordSha256,'formal record changed after accepted HR handoff');
    const notesFile=path.join(path.dirname(acceptanceFile),'main-approved-notes.json'),notes=normalizeTalentGateNotes(readEvidence(notesFile)),screeningFile=path.join(path.dirname(acceptanceFile),'screening-fresh-snapshot.json'),snapshot=readEvidence(screeningFile);
    assert.equal(String(snapshot.candidate.uid),uid);assert.equal(snapshot.candidate.name,record.candidate.name);assert.equal(String(snapshot.candidate.jobId),String(c.jobId));assert.equal(snapshot.history.complete,true);
    const messages=snapshot.history.original_order_redacted;assert.ok(Array.isArray(messages));
    assert.deepEqual(notes.gates.map(g=>g.condition).sort(),['arrival','duration','location','onsite_days','salary','school']);
    for(const gate of notes.gates){const matches=messages.filter(m=>String(m.mid)===String(gate.mid));assert.equal(matches.length,1);const m=matches[0];assert.equal(String(m.from.uid),uid);assert.equal(String(m.to.uid),String(c.ownBossUid));
      if(gate.condition==='arrival'&&m.body?.resume){assert.equal(String(m.body.resume.user.uid),uid);assert.equal(String(m.body.resume.jobId),String(c.jobId));assert.equal(m.body.resume.applyStatus,gate.quote);}else assert.ok(typeof m.body?.text==='string'&&m.body.text.includes(gate.quote),'gate quote not found in candidate evidence');}
    const q=messages.find(m=>String(m.mid)===String(notes.questionMid));assert.ok(q);assert.equal(String(q.from.uid),String(c.ownBossUid));for(const fragment of notes.requiredQuestionFragments)assert.ok(q.body.text.includes(fragment));
    const auth=await cli(c,folder,'identity',['auth','status','--json','--verify']);assert.equal(auth.appId,c.appId);assert.equal(auth.identities.bot.openId,c.botOpenId);assert.equal(auth.identities.bot.verified,true);
    const group=await cli(c,folder,'group',['im','chats','get','--as','user','--chat-id',c.chatId,'--format','json']);assert.equal(group.identity,'user');assert.equal(group.data.name,c.groupName);assert.equal(group.data.external,false);
    const members=await cli(c,folder,'members',['im','+chat-members-list','--as','user','--chat-id',c.chatId,'--member-types','bot','--page-all','--format','json']);assert.ok(members.data.bots.some(b=>b.app_id===c.appId&&b.member_id===c.botOpenId));
    const baseCommon=['--as','user','--base-token',c.baseToken,'--table-id',c.tableId,'--format','json'];
    const schema=await cli(c,folder,'fields',['base','+field-list',...baseCommon]);
    const ids=path.join(folder,'record-ids.json');save(ids,{record_id_list:[event.recordId]});const base=await cli(c,folder,'base',['base','+record-get',...baseCommon,'--json','@'+path.relative(c.workspaceRoot,ids)]);assert.equal(base.identity,'user');assert.deepEqual(base.data.record_id_list,[event.recordId]);assert.equal(base.data.field_id_list.length,schema.data.fields.length);
    const values=Object.fromEntries(base.data.fields.map((name,i)=>[name,base.data.data[0][i]]));assert.equal(values['姓名'],record.candidate.name);assert.equal(values['岗位'],c.jobName);assert.equal(values['能力评分'],score.abilityBaseScore);assert.equal(values['岗位适应评分'],record.job_fit.score);
    const uidMatches=[...String(values['初筛依据']).matchAll(/BOSS[ _]UID=(\d+)/g)].map(m=>m[1]);assert.ok(uidMatches.length&&uidMatches.every(x=>x===uid));const jobMatches=[...String(values['初筛依据']).matchAll(/(?:BOSS_JOB_ID|岗位ID)=(\d+)/g)].map(m=>m[1]);assert.ok(jobMatches.length&&jobMatches.every(x=>x===String(c.jobId)));
    const input={candidate:{uid,name:record.candidate.name,jobId:c.jobId},screening:{state:record.state,abilityBaseScore:score.abilityBaseScore,evidenceCoveragePercent:score.evidenceCoveragePercent,finalSignalScore:score.finalSignalScore,conditionsConfirmed:notes.gates.length,aiCodingConfirmed:record.job_fit.hard_condition_status==='pass'},base:{recordId:event.recordId,uid,jobId:c.jobId,name:values['姓名'],jobName:values['岗位'],conclusion:scalar(values['AI初筛结论']),hrStatus:scalar(values['HR复核状态']),url:c.baseUrl,salary:values['薪资'],arrival:values['最快到岗时间'],school:values['院校']??'',technicalSummary:notes.technicalSummary},group:{chatId:c.chatId,name:group.data.name,external:group.data.external},expected:{jobId:c.jobId,chatId:c.chatId,groupName:c.groupName,baseUrl:c.baseUrl},paused:isPaused};
    const plan=buildTalentPush(input);save(path.join(folder,'input.json'),input);save(path.join(folder,'plan.json'),plan);save(path.join(folder,'evidence.json'),{at:new Date().toISOString(),candidateUid:uid,recordCanonicalSha256:canonicalJsonSha256(record),files:evidenceFiles,baseFieldsRead:schema.data.fields.length,rawGatesVerified:6,botMembershipVerified:true});return plan;
  }
  function command(c,plan){return ['im','+messages-send','--as','bot','--chat-id',c.chatId,'--msg-type','post','--content',JSON.stringify(plan.content),'--idempotency-key',plan.eventKey,'--format','json'];}
  async function verify(c,dir,plan,messageId,attemptAt,label){
    const result=messageId?await cli(c,dir,label,['im','+messages-mget','--as','user','--message-ids',messageId,'--no-reactions','--format','json']):await cli(c,dir,label,['im','+chat-messages-list','--as','user','--chat-id',c.chatId,'--start',new Date(Date.parse(attemptAt)-60000).toISOString(),'--page-size','50','--no-reactions','--format','json']);
    assert.equal(result.identity,'user');const matches=(result.data.messages??[]).filter(m=>matchesTalentPushMessage(m,plan,c,messageId));assert.equal(matches.length,1,'independent group readback is not unique');
    const receipt={at:new Date().toISOString(),status:'sent_verified',eventKey:plan.eventKey,messageId:matches[0].message_id,chatId:c.chatId,botOpenId:c.botOpenId,payloadSha256:plan.payloadSha256,groupReadbackMatches:1,source:dir};save(path.join(dir,'verified.json'),receipt);return receipt;
  }
  async function handleEvent(event){
    const c=config(),loc=eventLocation(c,event);privateDirectory(loc.dir);
    if(fs.existsSync(path.join(loc.dir,'verified.json')))return {httpStatus:200,data:{ok:true,duplicate:true,...read(path.join(loc.dir,'verified.json'))}};
    if(fs.existsSync(path.join(loc.dir,'attempt.json')))return {httpStatus:409,data:{ok:false,status:'prior_attempt_no_auto_retry',eventKey:loc.key}};
    const folder=path.join(loc.dir,'prepare-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex'));privateDirectory(folder);
    const plan=await prepare(c,event,folder);assert.equal(plan.eventKey,loc.key);
    const preview=await cli(c,folder,'preview',[...command(c,plan),'--dry-run']);assert.equal(preview.dry_run,true);assert.equal(preview.identity,'bot');
    if(c.mode==='preview')return {httpStatus:200,data:{ok:true,dryRun:true,eventKey:loc.key,payloadSha256:plan.payloadSha256,planFile:path.join(folder,'plan.json'),proofFile:path.join(folder,'evidence.json')}};
    assert.equal(c.mode,'live','service is not enabled');
    const boundary=config(),boundaryStates=boundary.runSources.map(source=>({source,state:read(source.stateFile)})),proof=read(path.join(folder,'evidence.json'));
    assertTalentPushBoundary(c,boundary,paused(boundary,loc.uid,boundaryStates),proof.files);
    save(path.join(loc.dir,'attempt.json'),{at:new Date().toISOString(),pid:process.pid,eventKey:loc.key,event,planFile:path.join(folder,'plan.json'),payloadSha256:plan.payloadSha256,sendIdentity:'bot',chatId:c.chatId,invocationLimit:1});
    const result=await cli(c,folder,'send',command(c,plan));assert.equal(result.identity,'bot');save(path.join(loc.dir,'result.json'),result);
    const messageId=result.data?.message_id??result.data?.message?.message_id;assert.match(messageId??'',/^om_/);
    const receipt=await verify(c,loc.dir,plan,messageId,read(path.join(loc.dir,'attempt.json')).at,'readback');return {httpStatus:200,data:{ok:true,duplicate:false,...receipt}};
  }
  async function handleReconcile(event){
    const c=config(),loc=eventLocation(c,event);assert.ok(fs.existsSync(path.join(loc.dir,'attempt.json')),'no attempt exists');
    if(fs.existsSync(path.join(loc.dir,'verified.json')))return {httpStatus:200,data:{ok:true,duplicate:true,...read(path.join(loc.dir,'verified.json'))}};
    const attempt=read(path.join(loc.dir,'attempt.json')),plan=read(contained(attempt.planFile,[c.receiptsDir]));const result=fs.existsSync(path.join(loc.dir,'result.json'))?read(path.join(loc.dir,'result.json')):null;
    const receipt=await verify(c,loc.dir,plan,result?.data?.message_id??result?.data?.message?.message_id,attempt.at,'reconcile-'+Date.now());return {httpStatus:200,data:{ok:true,readOnlyReconciliation:true,...receipt}};
  }
  const trace=handler=>async event=>{try{return await handler(event);}catch(error){save(path.join(first.receiptsDir,'failure-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.json'),{at:new Date().toISOString(),event,error:{name:error.name,message:error.message,stack:error.stack},noAutomaticSendRetry:true});throw error;}};
  return {handleEvent:trace(handleEvent),handleReconcile:trace(handleReconcile),config:first,configId};
}

export async function startTalentPushServer(configFile){
  const service=createTalentPushService(configFile),c=service.config;
  const lock=path.join(c.receiptsDir,'server.lock');
  if(fs.existsSync(lock)){const old=read(lock);assert.equal(old.service,'boss-talent-push');try{process.kill(old.pid,0);throw Error('existing talent push server is alive');}catch(e){if(e.code!=='ESRCH')throw e;}fs.unlinkSync(lock);}
  save(lock,{pid:process.pid,service:'boss-talent-push',configFile:path.resolve(configFile),at:new Date().toISOString()});
  const server=createTalentPushHttpServer({token:c.token,handleEvent:service.handleEvent,handleReconcile:service.handleReconcile,configId:service.configId});
  const cleanup=()=>{try{if(read(lock).pid===process.pid)fs.unlinkSync(lock);}catch{}};
  server.once('close',cleanup);server.once('error',cleanup);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,c.host,resolve);});
  const state={pid:process.pid,service:'boss-talent-push',host:c.host,port:c.port,configFile:path.resolve(configFile),configId:service.configId,at:new Date().toISOString()};const temporary=c.runtimeFile+'.'+process.pid;fs.writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,c.runtimeFile);
  process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());console.log(JSON.stringify({ok:true,service:state.service,pid:process.pid,host:c.host,port:c.port}));return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--config');assert.ok(index>=0&&process.argv[index+1],'--config required');startTalentPushServer(path.resolve(process.argv[index+1])).catch(()=>{console.error('Talent push server failed; inspect private evidence.');process.exitCode=1;});
}
