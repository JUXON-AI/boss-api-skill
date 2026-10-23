#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash, historyFingerprint, sleep, withBoss} from './runtime.mjs';
import {privateDirectory} from './platform.mjs';

const strings = (value, keys) => Object.fromEntries(keys.filter(k => typeof value?.[k] === 'string').map(k => [k, value[k]]));
const resumeFields={education:['school','major','degreeName','startDateDesc','endDateDesc'],work:['company','positionName','startYearMonStr','endYearMonStr'],projects:['name','roleName','startDateDesc','endDateDesc']};
export function projectResume(value, candidate) {
  if (value?.geekBaseInfo?.userId !== candidate.uid || value.geekBaseInfo.name !== candidate.name) throw Error('Resume identity mismatch');
  const list = (key, fields) => {
    if (!Array.isArray(value[key])||value[key].some(x=>!x||typeof x!=='object'||Array.isArray(x))) throw Error('Resume list schema changed: ' + key);
    return value[key].map(item => strings(item, fields));
  };
  return {
    education: list('geekEduExpList', resumeFields.education),
    work: list('geekWorkExpList', resumeFields.work),
    projects: list('geekProjExpList', resumeFields.projects),
    fullTextVerified: false,
  };
}

export function selectBatch(friends, rows, jobId, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('Batch limit must be 1..50');
  const selected = [], seen = new Set();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.uid) || row.uid < 1 || seen.has(row.uid)) continue;
    const matches = friends.filter(c => c.uid === row.uid && c.name === row.name && String(c.jobId) === String(jobId));
    if (matches.length !== 1 || !row.id) continue;
    seen.add(row.uid); selected.push({contact: matches[0], row});
    if (selected.length === limit) break;
  }
  return selected;
}

export function projectHistory(response, candidate) {
  if (response?.code !== 0 || !Array.isArray(response.zpData?.messages)) throw Error('History read failed or schema changed');
  const messages = response.zpData.messages;
  const own = [...new Set(messages.filter(m => m.from?.uid === candidate.uid).map(m => m.to?.uid))];
  if (own.length !== 1 || !Number.isSafeInteger(own[0]) || own[0] <= 0) throw Error('Cannot verify conversation sender');
  if (messages.some(m => !((m.from?.uid === candidate.uid && m.to?.uid === own[0]) || (m.from?.uid === own[0] && m.to?.uid === candidate.uid)))) throw Error('Unexpected identity in history');
  const inbound = messages.filter(m => m.from?.uid === candidate.uid && typeof m.body?.text === 'string')
    .map(m => ({mid: m.mid, time: m.time, text: m.body.text})).sort((a,b) => a.time - b.time);
  return {
    complete: response.zpData.hasMore === false,
    historySha256: historyFingerprint(messages),
    inbound,
    outboundCount: messages.filter(m => m.from?.uid === own[0]).length,
    // Changes to read-state/security envelopes do not invalidate cached resume content.
    contentSha256: hash(JSON.stringify(messages.map(m => ({mid: m.mid, time: m.time, from: m.from?.uid, to: m.to?.uid, text: m.body?.text ?? null})))),
  };
}

export function cacheUsable(record, candidate, history, now, maxAgeMs) {
  return record?.schemaVersion === 1 && record.candidate?.uid === candidate.uid && record.candidate.name === candidate.name
    && record.candidate.jobId === String(candidate.jobId) && record.history?.contentSha256 === history.contentSha256
    && record.resume?.status === 'summary' && record.resume.summary?.fullTextVerified === false
    && Object.entries(resumeFields).every(([k,fields]) => {
      const entries=record.resume.summary[k];
      return Array.isArray(entries)&&entries.every(entry=>{
        if(!entry||typeof entry!=='object'||Array.isArray(entry))return false;
        return Object.entries(entry).every(([key,value])=>fields.includes(key)&&typeof value==='string');
      });
    })
    && Number.isFinite(Date.parse(record.resume.obtainedAt)) && now >= Date.parse(record.resume.obtainedAt)
    && now - Date.parse(record.resume.obtainedAt) <= maxAgeMs;
}

export function analyzeRecord(record) {
  const {candidate, history, resume} = record, summary = resume.summary;
  const greeting = history.inbound.map(m => m.text).join('\n');
  const evidence = [greeting, ...(summary?.projects ?? []).map(x => x.name), ...(summary?.work ?? []).map(x => x.positionName)].join('\n');
  const terms = patterns => patterns.filter(([label, regex]) => regex.test(evidence)).map(([label]) => label);
  const backend = terms([['Java',/\bJava\b/i],['Python',/\bPython\b/i],['Go',/\bGo(?:lang)?\b/i],['后端',/后端|Spring|FastAPI|接口|微服务/i]]);
  const ai = terms([['智能体',/Agent|智能体|LangGraph|StateGraph/i],['RAG',/\bRAG\b/i],['AI编程',/Vibe|Codex|Cursor|Claude\s*Code|AI.{0,5}(?:编程|开发|写码)/i]]);
  const stop = /不要再?联系|停止联系|别再?联系|不要再发/.test(greeting);
  const eligible = history.complete && history.outboundCount === 0 && !stop;
  return {
    candidate, eligibleForContactReview: eligible,
    category: stop ? 'stop_request_review' : history.outboundCount ? 'already_in_conversation' : !history.complete ? 'incomplete_history' : 'needs_evidence_review',
    backendSignals: backend, aiSignals: ai,
    projectNames: (summary?.projects ?? []).map(x => x.name).filter(Boolean),
    workRoles: (summary?.work ?? []).map(x => x.positionName).filter(Boolean),
    greeting: greeting.slice(0,600), greetingTruncated: greeting.length > 600,
    resumeStatus: resume.status, error: resume.error ?? null,
    // Lexical signals are triage aids, not verified ability scores or hiring decisions.
    reviewPriority: eligible ? (summary?.projects?.length ? 2 : 0) + (ai.length ? 1 : 0) + (backend.length ? 1 : 0) : -1,
    abilityScore: null, screeningPassed: false,
    unknowns: ['个人负责功能、独立能力及工具使用尚待了解', '薪资接受情况、出勤、周期和到岗日尚待确认'],
  };
}

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reportHTML(analysis) {
  const categories={stop_request_review:'停止联系请求，待处理',already_in_conversation:'已有我方消息，等待回复',incomplete_history:'历史不完整，需复核',needs_evidence_review:'待核实具体能力与条件'};
  return '<!doctype html><meta charset="utf-8"><title>本地招聘资料复核</title><style>body{font:15px system-ui;margin:32px;line-height:1.6}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}pre{white-space:pre-wrap}small{color:#666}</style><h1>本地资料复核</h1><p>只读采集；在线简历为结构化摘要，全文未验证。项目及经历均为候选人自述。词语命中只帮助安排人工复核顺序，不代表初筛通过、拒绝或录用。</p><table><tr><th>姓名</th><th>岗位相关线索</th><th>资料与沟通状态</th><th>招呼及项目</th></tr>' + analysis.map(a => '<tr><td>'+escapeHTML(a.candidate.name)+'</td><td>'+escapeHTML([...a.backendSignals,...a.aiSignals].join('、') || '尚缺具体线索')+'</td><td>'+escapeHTML((a.resumeStatus==='summary'?'在线摘要已读取':'在线摘要未取得')+' / '+categories[a.category])+(a.error?'<br>'+escapeHTML(a.error):'')+'</td><td>'+escapeHTML(a.projectNames.join('；'))+'<details><summary>招呼（资料文本）</summary><pre>'+escapeHTML(a.greeting)+'</pre></details><small>'+escapeHTML(a.unknowns.join('；'))+'</small></td></tr>').join('')+'</table>';
}

export async function collectBatch(source, {job, out, limit = 20, cache, maxAgeMs = 24*3600*1000, now = Date.now, progress = () => {}}) {
  if (!job?.boss_job_id || !job.job_name) throw Error('Confirmed job profile required');
  selectBatch([],[],job.boss_job_id,limit);
  if(!Number.isFinite(maxAgeMs)||maxAgeMs<0||maxAgeMs>24*3600*1000)throw Error('Cache age must be within 24 hours');
  if (fs.existsSync(out)) throw Error('Choose a new batch output directory');
  if(cache&&!fs.existsSync(path.join(cache,'manifest.json')))throw Error('Cache must be a previous batch directory');
  privateDirectory(out); privateDirectory(path.join(out,'records'));
  if (cache) {privateDirectory(cache); privateDirectory(path.join(cache,'records'));}
  // These are new, private run directories. Reuse this ACL preflight for the run;
  // avoid spawning PowerShell again for every small record. Every file stays exclusive.
  const writeJSON=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const started=now(),records=[],stats={selected:0,historyReads:0,resumeOpens:0,cacheHits:0,failures:0,clientConnections:1,rawReadBytes:0};
  try {
    const snapshot=await source.list();
    const selected=selectBatch(snapshot.friends,snapshot.rows,job.boss_job_id,limit);
    if(!selected.length)throw Error('No uniquely matched visible candidates for the job');
    stats.selected=selected.length;
    writeJSON(path.join(out,'manifest.json'), {at:new Date(started).toISOString(),mode:'read_only',source:'user_authorized_job_scope',jobId:String(job.boss_job_id),requestedLimit:limit,contactPage:1,paginationVerified:false,authorizedContacting:false,uiReadStateMayChange:true,candidates:selected.map(({contact:c})=>({uid:c.uid,name:c.name,jobId:String(c.jobId)}))});
    for (const {contact:c,row} of selected) {
      const candidate={uid:c.uid,name:c.name,jobId:String(c.jobId)};
      const response=await source.history(c);
      stats.rawReadBytes+=Buffer.byteLength(JSON.stringify(response));
      const history=projectHistory(response,c); stats.historyReads++;
      let previous;
      const cached=cache && path.join(cache,'records',String(c.uid)+'.json');
      if (cached && fs.existsSync(cached)) {
        if (fs.statSync(cached).size > 1024*1024) throw Error('Oversized cache record');
        try {previous=JSON.parse(fs.readFileSync(cached,'utf8'));}
        catch(error) {if(!(error instanceof SyntaxError))throw error;}
      }
      let resume;
      if (cacheUsable(previous,candidate,history,now(),maxAgeMs)) {
        const cachedResume=previous.resume;
        resume={status:'summary',obtainedAt:cachedResume.obtainedAt,summary:{...Object.fromEntries(Object.entries(resumeFields).map(([k,fields])=>[k,cachedResume.summary[k].map(x=>strings(x,fields))])),fullTextVerified:false}};
        stats.cacheHits++;
      }
      else {
        stats.resumeOpens++;
        try {
          const value=await source.resume(c,row);stats.rawReadBytes+=Buffer.byteLength(JSON.stringify(value));
          resume={status:'summary',obtainedAt:new Date(now()).toISOString(),summary:projectResume(value,c)};
        }
        catch(error) {
          if (error.fatal) throw error;
          resume={status:'unavailable',error:error.message,summary:null}; stats.failures++;
        }
      }
      const record={schemaVersion:1,candidate,at:new Date(now()).toISOString(),history,resume};
      writeJSON(path.join(out,'records',String(c.uid)+'.json'),record);records.push(record);
      progress({completed:records.length,total:selected.length,cacheHits:stats.cacheHits,failures:stats.failures});
      if (stats.failures >= 3) throw Error('Three resume failures; stopping batch instead of repeated UI retries');
    }
  } finally {await source.restore();}
  const analysis=records.map(analyzeRecord).sort((a,b)=>b.reviewPriority-a.reviewPriority);
  stats.elapsedMs=now()-started;stats.uiRestoreConfirmed=true;
  stats.savedRecordBytes=records.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0);
  stats.compactBytes=Buffer.byteLength(JSON.stringify(analysis));
  writeJSON(path.join(out,'analysis.json'),analysis);writeJSON(path.join(out,'stats.json'),stats);
  fs.writeFileSync(path.join(out,'report.html'),reportHTML(analysis),{flag:'wx',mode:0o600});
  return {stats,analysis};
}

export function desktopSource(ctx) {
  let original, renderState;
  const ui = async expression => {
    const result=await ctx.renderer('view',`(async()=>{try{return {ok:true,value:await (${expression})};}catch(e){return {ok:false,error:e.message};}})()`);
    if(!result?.ok)throw Error(result?.error ?? 'Batch UI evaluation failed');
    return result.value;
  };
  const close = async () => {
    await ui(`(()=>{const dialogs=[...document.querySelectorAll('.resume-container')].filter(x=>x.getBoundingClientRect().width>0);if(dialogs.length>4)throw Error('Too many resume dialogs');for(const dialog of dialogs){const b=dialog.querySelectorAll('.close-btn');if(b.length!==1)throw Error('Resume close control changed');b[0].click();}return true;})()`);
    for(let attempt=0;attempt<20;attempt++) {
      const count=await ctx.main(`if(views.length!==1)throw Error('Expected one recruiter view');return views[0].mainFrame.framesInSubtree.filter(f=>f.url.startsWith('https://www.zhipin.com/web/frame/c-resume/')).length;`);
      if(count===0)return;
      await sleep(150);
    }
    throw Error('Resume frames did not close; stop before opening another identity');
  };
  const choose = async (c,row) => {
    await close();
    await ui(`(()=>{const x=document.getElementById(${JSON.stringify(row.id)});if(!x||x.__vue__?.$props?.geek?.uid!==${c.uid}||x.querySelector('.geek-name')?.getAttribute('title')!==${JSON.stringify(c.name)})throw Error('Batch UI identity changed');x.querySelector('.geek-name').click();return true;})()`);
    for(let attempt=0;attempt<15;attempt++) {
      if(await ui(`document.querySelector('.geek-item.selected')?.__vue__?.$props?.geek?.uid===${c.uid}`))break;
      await sleep(100);
    }
    await sleep(300);
    await ui(`(()=>{const x=document.querySelector('.geek-item.selected');if(x?.__vue__?.$props?.geek?.uid!==${c.uid})throw Error('User changed the active conversation');const b=document.querySelectorAll('a.resume-btn-online');if(b.length!==1)throw Error('Online resume control changed');b[0].click();return true;})()`);
  };
  return {
    async list() {
      const login=await ctx.bridge('message','_sdk_getLoginStatus');
      if(login?.code!==0||login.data!==true)throw Error('BOSS login required');
      // Keep normal Vue transition/initialization frames running while the app is occluded.
      renderState=await ctx.main(`if(roots.length!==1||views.length!==1)throw Error('Expected one root and recruiter view');return [...roots,...views].map(w=>{if(typeof w.getBackgroundThrottling!=='function'||typeof w.setBackgroundThrottling!=='function')throw Error('Renderer throttling controls unavailable');return {id:w.id,value:w.getBackgroundThrottling()};});`);
      await ctx.main(`for(const state of data.states){const w=all.find(x=>x.id===state.id);if(!w)throw Error('Renderer changed before batch');w.setBackgroundThrottling(false);}return true;`,{states:renderState});
      const contacts=await ctx.bridge('api','zprelationGetFriendList',{page:1,pageSize:100});
      if(contacts?.code!==0||!Array.isArray(contacts.zpData?.friendList))throw Error('Contact list failed');
      const snapshot=await ui(`(()=>{const rows=[...document.querySelectorAll('.geek-item')].map(x=>({id:x.id,uid:x.__vue__?.$props?.geek?.uid,name:x.querySelector('.geek-name')?.getAttribute('title'),selected:x.classList.contains('selected')}));return {rows,original:rows.find(x=>x.selected)};})()`);
      original=Number.isSafeInteger(snapshot.original?.uid)?snapshot.original:undefined;
      return {friends:contacts.zpData.friendList,rows:snapshot.rows};
    },
    history(c) {return ctx.bridge('api','zpChatHistoryMsg',{uid:c.uid,securityId:c.securityId,lastMsgId:0,count:30});},
    async resume(c,row) {
      try {await choose(c,row);} catch(error) {error.fatal=true;throw error;}
      const probe=`(async()=>{try{const urls=[...new Set(performance.getEntriesByType('resource').map(x=>x.name).filter(x=>{try{const u=new URL(x);return u.protocol==='https:'&&u.hostname==='static.zhipin.com'&&u.pathname.startsWith('/assets/zhipin/wasm/resume/wasm_canvas-')&&u.pathname.endsWith('.js');}catch{return false;}}))];if(urls.length!==1)return {ready:false};const mod=await import(urls[0]);if(typeof mod.get_export_geek_detail_info!=='function')return {ready:false,error:'Resume getter changed'};return {ready:true,value:mod.get_export_geek_detail_info()};}catch(e){return {ready:false,error:String(e?.message??e).slice(0,160)};}})()`;
      let lastError='not initialized';
      for(let attempt=0;attempt<16;attempt++) {
        await sleep(300);
        const result=await ctx.main(`if(views.length!==1)throw Error('Expected one recruiter view');const frames=views[0].mainFrame.framesInSubtree.filter(f=>f.url.startsWith('https://www.zhipin.com/web/frame/c-resume/'));if(frames.length>1)throw Error('Multiple resume frames');return frames.length?frames[0].executeJavaScript(data.probe):null;`,{probe});
        if(result?.ready) {
          const value=typeof result.value==='string'?JSON.parse(result.value):result.value;
          if(value?.geekBaseInfo?.userId===c.uid&&value.geekBaseInfo.name===c.name)return value;
          if(value?.geekBaseInfo?.userId===c.uid)throw Error('Resume UID matched but display name differs; manual identity review required');
          lastError='getter identity not ready';
        } else if(result?.error)lastError=result.error;
      }
      throw Error('Resume getter did not initialize with matching identity: '+lastError);
    },
    async restore() {
      if(!renderState)return;
      try {
        await close();
        if(original) {
          await ui(`(()=>{const x=document.getElementById(${JSON.stringify(original.id)});if(x?.__vue__?.$props?.geek?.uid!==${original.uid})throw Error('Original conversation unavailable; UI restoration incomplete');const name=x.querySelector('.geek-name');if(!name)throw Error('Original conversation control unavailable');name.click();return true;})()`);
          let restored=false;
          for(let attempt=0;attempt<15;attempt++) {
            restored=await ui(`document.querySelector('.geek-item.selected')?.__vue__?.$props?.geek?.uid===${original.uid}`);
            if(restored)break;
            await sleep(100);
          }
          if(!restored)throw Error('Original conversation selection not restored');
        }
      } finally {
        await ctx.main(`let failed=false;for(const state of data.states){try{const w=all.find(x=>x.id===state.id);if(!w||w.isDestroyed())throw Error('Renderer removed');w.setBackgroundThrottling(state.value);if(w.getBackgroundThrottling()!==state.value)throw Error('Renderer state differs');}catch{failed=true;}}if(failed)throw Error('Renderer throttle restoration incomplete');return true;`,{states:renderState});
      }
    },
  };
}

async function main() {
  const args=process.argv.slice(2), flags={};
  for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined||flags[args[i]])throw Error('Use unique --flag value pairs');flags[args[i]]=args[i+1];}
  if(!flags['--job']||!flags['--out'])throw Error('Usage: batch.mjs --job <confirmed-job.json> --out <new-private-dir> [--limit 20] [--cache <previous-batch-dir>]');
  for(const key of Object.keys(flags))if(!['--job','--out','--limit','--cache'].includes(key))throw Error('Unknown flag '+key);
  const job=JSON.parse(fs.readFileSync(flags['--job'],'utf8'));
  const result=await withBoss(ctx=>collectBatch(desktopSource(ctx),{job,out:path.resolve(flags['--out']),limit:Number(flags['--limit']??20),cache:flags['--cache']?path.resolve(flags['--cache']):undefined,progress:p=>console.log(JSON.stringify({progress:p}))}));
  console.log(JSON.stringify({ok:true,...result.stats,output:path.resolve(flags['--out']),messagesSent:0,fullTextVerified:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message,messagesSent:0}));process.exitCode=1;});
