#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {appMain, sendLock, hash, save, pid, targets, selectContact, attachmentURL, checkApproval, newSentMatches, sleep, withBoss} from './runtime.mjs';
import {archivePath, privateDirectory, sameOutputPath} from './platform.mjs';

const [op, ...args] = process.argv.slice(2), flags = {};
for (let i=0;i<args.length;i+=2) {
  if (!args[i].startsWith('--') || args[i+1] === undefined || args[i+1].startsWith('--')) throw new Error('Flags require explicit values');
  if (flags[args[i].slice(2)] !== undefined) throw new Error('Duplicate flag');
  flags[args[i].slice(2)] = args[i+1];
}
const required = key => {if (!flags[key]) throw new Error('--'+key+' is required'); return flags[key];};
const number = (key, fallback, max=Number.MAX_SAFE_INTEGER) => {
  const n=Number(flags[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n<=0 || n>max) throw new Error('--'+key+' must be a bounded positive integer');
  return n;
};
function assertSuccess(response, label) {
  if (response?.code !== 0) throw new Error(label+' failed: '+response?.code+'; use current login/permissions, do not replay credentials');
  return response;
}
async function friends(ctx) {
  return assertSuccess(await ctx.bridge('api','zprelationGetFriendList',{page:number('page',1,100),pageSize:100}),'Contact list');
}
async function contact(ctx, uid, name) {
  const r=await friends(ctx);
  return selectContact(r.zpData?.friendList ?? [],uid,name,flags['job-id']);
}
async function history(ctx, c) {
  const r=assertSuccess(await ctx.bridge('api','zpChatHistoryMsg',{uid:c.uid,securityId:c.securityId,lastMsgId:0,count:30}),'History');
  if (!Array.isArray(r.zpData?.messages)) throw new Error('History schema changed');
  return r;
}
function output(result, brief) {
  if (flags.output) save(flags.output,result);
  console.log(JSON.stringify({...brief,output:flags.output ?? null},null,2));
}
async function main() {
  if (op==='doctor') {
    console.log(JSON.stringify({ok:true,pid:pid(),app:appMain,archive:archivePath(appMain),platform:process.platform,node:process.versions.node,
      inspectorListening:(await targets()).length>0,activation:process.platform==='win32'?'Node Windows debug handler':'SIGUSR1',runtimeUntouched:true},null,2)); return;
  }
  if (op==='help' || !op) {
    console.log('boss.mjs doctor | status | extract --member <exact/member> --file <new-file> --output <new.json> | list --output <new.json> | history --uid <id> --name <name> --output <new.json> | resume-summary --uid <id> --name <name> --output <new.json> | attachment --uid <id> --name <name> --mid <id> --file <new.pdf> --output <new.json> | send --approval <json> --attempt <new.json> --output <new.json>'); return;
  }
  if (!['status','extract','list','history','resume-summary','attachment','send'].includes(op)) throw new Error('Unknown operation; use help');
  if (op!=='status') required('output');
  if (flags.output && fs.existsSync(flags.output)) throw new Error('Output exists; choose a new file');
  let approval, sendFd;
  try {
    if (op==='send') {
      approval=JSON.parse(fs.readFileSync(required('approval'),'utf8')); checkApproval(approval);
      required('attempt');
      if (fs.existsSync(flags.attempt)) throw new Error('Attempt already exists; check history, do not retry');
      if (sameOutputPath(flags.attempt,flags.output)) throw new Error('Attempt and output paths must differ');
      const outputDirectory=path.dirname(path.resolve(flags.output)), attemptDirectory=path.dirname(path.resolve(flags.attempt));
      privateDirectory(outputDirectory);
      if (!sameOutputPath(outputDirectory,attemptDirectory)) privateDirectory(attemptDirectory);
      sendFd=fs.openSync(sendLock,'wx',0o600); fs.writeSync(sendFd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
    }
    await withBoss(async ctx => {
      if (op==='extract') {
        const member=required('member'), file=path.resolve(required('file'));
        if (path.posix.isAbsolute(member) || member.includes('\\') || member.split('/').some(x=>!x || x==='..' || x==='.') || sameOutputPath(file,flags.output) || fs.existsSync(file)) throw new Error('Exact archive member and separate new output file required');
        const archive=archivePath(appMain);
        const fd=fs.openSync(archive,'r'); let entry;
        try {
          const prefix=Buffer.alloc(16); fs.readSync(fd,prefix,0,16,0);
          const length=prefix.readUInt32LE(12);
          if (prefix.readUInt32LE(0)!==4 || length>64*1024*1024) throw new Error('Unexpected ASAR header');
          const raw=Buffer.alloc(length); fs.readSync(fd,raw,0,length,16);
          let current=JSON.parse(raw.toString());
          for(const part of member.split('/')) current=current?.files?.[part];
          entry=current;
        } finally {fs.closeSync(fd);}
        if(!entry || entry.files || entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size>64*1024*1024 || !/^[a-f0-9]{64}$/.test(entry.integrity?.hash ?? '')) throw new Error('Choose a bounded packed member with declared SHA256');
        privateDirectory(path.dirname(file));
        const result=await ctx.main(`
          const fs=process.mainModule.require('fs'),crypto=process.mainModule.require('crypto');
          const bytes=fs.readFileSync(process.mainModule.require('path').join(data.archive,...data.member.split('/')));
          const digest=crypto.createHash('sha256').update(bytes).digest('hex');
          if(bytes.length!==data.size||digest!==data.sha256)throw new Error('Runtime plaintext does not match declared member integrity');
          fs.writeFileSync(data.file,bytes,{flag:'wx',mode:0o600});
          return {bytes:bytes.length,sha256:digest,declaredPlaintextHashMatched:true};`,
          {archive,member,file,size:entry.size,sha256:entry.integrity.hash});
        output({at:new Date().toISOString(),archive,member,file,encryption:entry.encryption ?? null,...result},
          {ok:true,member,file,...result}); return;
      }
      const login=await ctx.bridge('message','_sdk_getLoginStatus');
      const loggedIn=login?.code===0 && login?.data===true;
      if (op==='status') {output({at:new Date().toISOString(),...ctx.identity,loggedIn},{ok:true,...ctx.identity,loggedIn}); return;}
      if (!loggedIn) throw new Error('Client is not logged in; restore login in the existing BOSS client');
      if (op==='list') {
        const r=await friends(ctx), list=r.zpData?.friendList;
        if (!Array.isArray(list)) throw new Error('Contact schema changed');
        output({at:new Date().toISOString(),source:'zprelationGetFriendList',page:number('page',1,100),paginationVerified:false,response:r},
          {ok:true,count:list.length,paginationVerified:false}); return;
      }
      const uid=approval?.recipient.uid ?? number('uid',NaN), name=approval?.recipient.name ?? required('name');
      const c=await contact(ctx,uid,name);
      if (op==='history') {
        const r=await history(ctx,c), messages=r.zpData.messages;
        output({at:new Date().toISOString(),contact:c,history:r,historySha256:hash(JSON.stringify(messages)),
          coverage:{hasMore:r.zpData.hasMore ?? null,requestedCount:30,complete:r.zpData.hasMore===false}},
          {ok:true,uid,name,count:messages.length,hasMore:r.zpData.hasMore ?? null,historySha256:hash(JSON.stringify(messages))}); return;
      }
      if (op==='resume-summary') {
        const value=await ctx.main(`
          if(views.length!==1)throw new Error('Expected one recruiter webview');
          const frames=views[0].mainFrame.framesInSubtree.filter(f=>f.url.startsWith('https://www.zhipin.com/web/frame/c-resume/'));
          if(frames.length!==1)throw new Error('Expected one already-open resume frame; do not open another candidate implicitly');
          return frames[0].executeJavaScript(${JSON.stringify(`(async()=>{
            const urls=[...new Set(performance.getEntriesByType('resource').map(x=>x.name).filter(x=>{
              try{const u=new URL(x);return u.protocol==='https:'&&u.hostname==='static.zhipin.com'&&u.pathname.startsWith('/assets/zhipin/wasm/resume/wasm_canvas-')&&u.pathname.endsWith('.js');}catch{return false;}
            }))];
            const chosen=${JSON.stringify(flags['module-url'] ?? null)};
            const matches=chosen?urls.filter(u=>u===chosen):urls;
            if(matches.length!==1)throw new Error('Cannot uniquely identify already-loaded WASM JS module; inspect current frame resource evidence');
            const mod=await import(matches[0]);
            if(typeof mod.get_export_geek_detail_info!=='function')throw new Error('Getter export changed');
            return {value:mod.get_export_geek_detail_info(),modulePath:new URL(matches[0]).pathname};
          })()`)});`);
        const v=typeof value.value==='string'?JSON.parse(value.value):value.value;
        if (v?.geekBaseInfo?.userId!==uid || v.geekBaseInfo.name!==name) throw new Error('Open resume UID/name does not match requested candidate; no output saved');
        output({at:new Date().toISOString(),source:'initialized client WASM getter',candidate:{uid,name},...value,value:v,
          coverage:{fullTextVerified:false,note:'Structured export only; project descriptions and complete experience may be absent.'}},
          {ok:true,uid,name,educationEntries:v.geekEduExpList?.length ?? 0,projectEntries:v.geekProjExpList?.length ?? 0,fullTextVerified:false}); return;
      }
      if (op==='attachment') {
        const file=path.resolve(required('file'));
        if (sameOutputPath(file,flags.output) || fs.existsSync(file)) throw new Error('PDF output must be a separate new file');
        privateDirectory(path.dirname(file));
        const r=await history(ctx,c), mid=required('mid');
        const matches=r.zpData.messages.filter(m=>String(m.mid)===mid);
        if (matches.length!==1) throw new Error('Expected one current received attachment message; no auto-accept/exchange');
        const url=attachmentURL(matches[0],uid);
        const result=await ctx.main(`
          if(views.length!==1)throw new Error('Expected one recruiter webview');
          const fs=process.mainModule.require('fs'),crypto=process.mainModule.require('crypto');
          return await new Promise((resolve,reject)=>{
            const req=e.net.request({url:data.url,session:views[0].session,useSessionCookies:true,redirect:'manual'});
            const timer=setTimeout(()=>{req.abort();reject(new Error('PDF download timeout'));},15000);
            let finished=false;
            const fail=err=>{if(finished)return;finished=true;clearTimeout(timer);req.abort();reject(err);};
            req.on('error',fail);
            req.on('redirect',(status,method,url)=>{
              const u=new URL(url);
              if(u.protocol==='https:'&&(u.hostname==='zhipin.com'||u.hostname.endsWith('.zhipin.com')))req.followRedirect();
              else fail(new Error('Unexpected attachment redirect'));
            });
            req.on('response',res=>{
              const chunks=[];let size=0;
              res.on('error',fail);
              res.on('data',chunk=>{size+=chunk.length;if(size>20*1024*1024){fail(new Error('PDF exceeds 20 MiB'));return;}chunks.push(chunk);});
              res.on('end',()=>{
                if(finished)return;
                try{
                  const bytes=Buffer.concat(chunks);
                  if(res.statusCode!==200||bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('Expected PDF HTTP200; got '+res.statusCode);
                  fs.writeFileSync(data.file,bytes,{flag:'wx',mode:0o600});
                  finished=true;clearTimeout(timer);
                  resolve({httpStatus:res.statusCode,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
                }catch(err){fail(err);}
              });
            });req.end();
          });`,{url,file});
        output({at:new Date().toISOString(),candidate:{uid,name},messageMid:mid,file,...result},
          {ok:true,uid,name,file,...result}); return;
      }
      const first=await history(ctx,c), before=first.zpData.messages;
      if (first.zpData.hasMore !== false) throw new Error('History completeness is unverified; no send until duplicate checking can cover the conversation');
      if (hash(JSON.stringify(before))!==approval.expectedHistorySha256) throw new Error('Conversation changed since review; draft again before sending');
      if (before.some(m=>m.body?.text===approval.text && m.to?.uid===uid)) throw new Error('Approved text already exists in history');
      const own=[...new Set(before.filter(m=>m.from?.uid===uid).map(m=>m.to?.uid))];
      if (own.length!==1 || !Number.isSafeInteger(own[0]) || own[0]<=0) throw new Error('Cannot verify sender account');
      if (!Number.isSafeInteger(c.friendSource) || typeof c.encryptUid!=='string' || !c.encryptUid) throw new Error('Send target metadata missing; inspect current SDK call site');
      const sdk=await ctx.renderer('view','window.iBossRoot.chat.sendMessage.toString()');
      const latest=await history(ctx,c);
      if (latest.zpData.hasMore !== false) throw new Error('History completeness changed immediately before send');
      if (hash(JSON.stringify(latest.zpData.messages))!==approval.expectedHistorySha256) throw new Error('Conversation changed immediately before send');
      save(flags.attempt,{at:new Date().toISOString(),status:'reserved_before_invocation',recipient:{uid,name},textSha256:approval.textSha256,attempts:1});
      let invoked=false;
      try {
        await ctx.renderer('view',`(async()=>{
          if(window.iBossRoot.chat.sendMessage.toString()!==${JSON.stringify(sdk)})throw new Error('Send SDK changed');
          await window.iBossRoot.chat.sendMessage(${JSON.stringify(approval.text)},'text',${JSON.stringify({uid:c.uid,friendSource:c.friendSource,encryptUid:c.encryptUid})});
          return {invoked:true};
        })()`);
        invoked=true;
        for(let i=0;i<8;i++) {
          await sleep(750);
          const h=await history(ctx,c), matches=newSentMatches(before,h.zpData.messages,approval.text,own[0],uid);
          if(matches.length>1) throw new Error('Multiple matching new records; manual review required');
          if(matches.length===1) {
            output({at:new Date().toISOString(),recipient:{uid,name},attempts:1,textSha256:approval.textSha256,
              sdkInvoked:true,historyConfirmed:true,messageMid:matches[0].mid,matchingNewRecords:1,deliveryConfirmed:false,readConfirmed:false},
              {ok:true,uid,name,historyConfirmed:true,messageMid:matches[0].mid,deliveryConfirmed:false,readConfirmed:false}); return;
          }
        }
        throw new Error('Send outcome unknown; inspect history, do not resend');
      } catch(error) {
        if(!fs.existsSync(flags.output)) save(flags.output,{at:new Date().toISOString(),recipient:{uid,name},sdkReturned:invoked,outcomeUnknown:true,doNotRetryAutomatically:true,error:error.message});
        throw error;
      }
    });
  } finally {
    if(sendFd!==undefined){try{fs.closeSync(sendFd);}finally{fs.unlinkSync(sendLock);}}
  }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message,automaticMutationRetry:false}));process.exitCode=1;});
