import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateDirectory} from '../../../scripts/platform.mjs';
import {talentPushConfigId} from './talent_push_identity.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function ensureTalentPushServer(configFile){
  const c=read(configFile);assert.equal(c.host,'127.0.0.1');assert.ok(Number.isInteger(c.port)&&c.port>1024&&c.port<65536);assert.match(c.token,/^[a-f0-9]{64}$/);
  const baseUrl=`http://${c.host}:${c.port}`;
  const expectedConfigId=talentPushConfigId(c,configFile);
  async function health(){try{const response=await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(1000)});const x=await response.json();if(response.ok&&x.ok&&x.service==='boss-talent-push'&&x.version===1){if(x.configId!==expectedConfigId)throw Object.assign(new Error('Webhook routing identity mismatch; inspect the existing service.'),{code:'WEBHOOK_BINDING_MISMATCH'});return true;}return false;}catch(error){if(error.code==='WEBHOOK_BINDING_MISMATCH')throw error;return false;}}
  if(await health())return {config:c,baseUrl,started:false};
  if(fs.existsSync(c.runtimeFile)){const runtime=read(c.runtimeFile);assert.equal(runtime.service,'boss-talent-push');assert.equal(path.resolve(runtime.configFile),path.resolve(configFile));let alive=false;try{process.kill(runtime.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')throw error;}assert.equal(alive,false,'existing server process is alive but unreachable; inspect before restarting');}
  privateDirectory(c.receiptsDir);privateDirectory(c.logDir);
  const stamp=Date.now()+'-'+process.pid,out=fs.openSync(path.join(c.logDir,'server-'+stamp+'.stdout.txt'),'wx',0o600),err=fs.openSync(path.join(c.logDir,'server-'+stamp+'.stderr.txt'),'wx',0o600);
  let launchError;
  try{const child=spawn(process.execPath,[fileURLToPath(new URL('./talent_push_server.mjs',import.meta.url)),'--config',path.resolve(configFile)],{cwd:c.workspaceRoot,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.once('error',error=>{launchError=error;});child.unref();}finally{fs.closeSync(out);fs.closeSync(err);}
  for(let i=0;i<30;i++){if(launchError)throw new Error('Webhook server launch failed.');if(await health())return {config:c,baseUrl,started:true};await pause(250);}
  throw new Error('Webhook server did not become ready; inspect private logs.');
}
export async function postTalentPush(configFile,event,{reconcile=false}={}){
  const {config,baseUrl,started}=await ensureTalentPushServer(configFile);
  const response=await fetch(baseUrl+(reconcile?'/talent-reconcile':'/talent-screened'),{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(180000)});
  const data=await response.json();return {httpStatus:response.status,serverStarted:started,data};
}
export async function drainTalentPush(configFile){
  const c=read(configFile),seen=new Set(),results=[];
  const summary=()=>({ok:results.every(x=>x.httpStatus<400),newVerified:results.filter(x=>x.data.status==='sent_verified'&&!x.data.duplicate).length,duplicates:results.filter(x=>x.data.duplicate).length,dryRuns:results.filter(x=>x.data.dryRun).length,pending:results.filter(x=>x.httpStatus>=400).length,results});
  for(const source of c.runSources){const state=read(source.stateFile);for(const h of state.handoffs??[]){
    if(!h.bossHandoffSent||!h.completedAt||!h.recordId)continue;
    if(Date.parse(h.completedAt)<Date.parse(c.enabledAt)&&!(c.bootstrapRecordIds??[]).includes(h.recordId))continue;
    const key=String(h.uid)+':'+h.recordId;if(seen.has(key))continue;seen.add(key);
    const result=await postTalentPush(configFile,{type:'talent.base_verified',jobId:String(c.jobId),uid:String(h.uid),recordId:h.recordId});results.push({uid:h.uid,recordId:h.recordId,...result});
    // A pending or unknown result is a separate reconciliation task, never a send retry.
    if(result.httpStatus>=500)return summary();
  }}
  return summary();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
  (async()=>{assert.ok(arg('config'),'--config required');const file=path.resolve(arg('config'));if(process.argv.includes('--ensure')){const r=await ensureTalentPushServer(file);console.log(JSON.stringify({ok:true,serverStarted:r.started,url:r.baseUrl+'/talent-screened'}));return;}
    if(process.argv.includes('--drain')){const result=await drainTalentPush(file);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=2;return;}
    assert.ok(arg('uid')&&arg('record-id'),'--uid and --record-id required');const c=read(file);const result=await postTalentPush(file,{type:'talent.base_verified',jobId:String(c.jobId),uid:String(arg('uid')),recordId:arg('record-id')},{reconcile:process.argv.includes('--reconcile')});console.log(JSON.stringify(result));if(result.httpStatus>=400)process.exitCode=2;
  })().catch(()=>{console.error('Talent push request failed; inspect private webhook receipts; do not resend blindly.');process.exitCode=1;});
}
