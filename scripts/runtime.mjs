import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const appMain = process.env.BOSS_APP_MAIN || '/Applications/BOSS直聘.app/Contents/MacOS/BOSS直聘';
export const sendLock = process.env.BOSS_SEND_LOCK || path.join(os.tmpdir(), 'boss-recruiting-send.lock');
const endpoint = new URL(process.env.BOSS_INSPECTOR_URL || 'http://127.0.0.1:9229');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('Inspector must be a loopback HTTP origin');
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function save(file, value, exclusive = true) {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: exclusive ? 'wx' : 'w'});
}
export function pid() {
  const matches = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'}).split('\n')
    .map(row => row.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(m => m[2] === appMain || m[2].startsWith(appMain + ' '));
  if (matches.length !== 1) throw new Error('Expected one running BOSS main process; no process was started');
  return Number(matches[0][1]);
}
export async function targets() {
  try {
    const response = await fetch(new URL('json/list', endpoint), {signal: AbortSignal.timeout(1500)});
    if (!response.ok) throw new Error('Inspector HTTP ' + response.status);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Unexpected Inspector discovery body');
    return result;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return [];
    throw error;
  }
}
export function selectContact(list, uid, name, jobId) {
  const matches = list.filter(c => c.uid === uid && c.name === name && (jobId === undefined || String(c.jobId) === jobId));
  if (matches.length !== 1) throw new Error('Expected exactly one UID/name/job match in this page; pagination coverage is unverified');
  return matches[0];
}
export function attachmentURL(message, uid) {
  if (message.from?.uid !== uid || !message.body?.hyperLink?.url) throw new Error('Expected received attachment from selected candidate');
  const link = new URL(message.body.hyperLink.url);
  if (link.protocol !== 'bosszp:' || link.searchParams.get('type') !== 'selectResumePreviewUrl') throw new Error('Not an accepted resume preview link');
  const src = new URL(link.searchParams.get('url'));
  if (src.origin !== 'https://m.zhipin.com' || src.pathname !== '/wflow/zpgeek/download/preview4boss') throw new Error('Unexpected attachment origin/path');
  return src.href;
}
export function checkApproval(a) {
  if (a.approved !== true || a.approval?.recipientCount !== 1 || typeof a.approval?.userMessage !== 'string' || !a.approval.userMessage.trim()) throw new Error('Explicit single-recipient authorization required');
  if (!Number.isSafeInteger(a.recipient?.uid) || a.recipient.uid <= 0 || typeof a.recipient.name !== 'string' || !a.recipient.name) throw new Error('Invalid recipient');
  if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('Nonempty text required');
  if (a.textSha256 !== hash(a.text) || a.approval.approvedTextSha256 !== hash(a.text)) throw new Error('Approved text hash mismatch');
  if (!/^[a-f0-9]{64}$/.test(a.expectedHistorySha256 ?? '')) throw new Error('Fresh reviewed history fingerprint required');
}
export function newSentMatches(before, after, text, ownUid, uid) {
  const old = new Set(before.map(m => String(m.mid)));
  return after.filter(m => m.mid != null && !old.has(String(m.mid)) && m.body?.text === text && m.from?.uid === ownUid && m.to?.uid === uid);
}

export async function withBoss(callback) {
  const bossPid = pid();
  const lockPath = path.join(os.tmpdir(), 'boss-desktop-inspector.lock');
  const lockFd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeSync(lockFd, JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
  let ws, started = false, identityVerified = false, evaluate;
  const pending = new Map();
  try {
    let list = await targets();
    if (!list.length) {
      process.kill(bossPid, 'SIGUSR1'); started = true;
      for (let i = 0; i < 30 && !list.length; i++) { await sleep(150); list = await targets(); }
    }
    if (list.length !== 1) throw new Error('Expected one Inspector target; stop rather than restarting BOSS');
    const url = new URL(list[0].webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== endpoint.port) throw new Error('Unexpected Inspector WebSocket endpoint');
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timeout')), 5000);
      ws.onopen = () => {clearTimeout(timer); resolve();};
      ws.onerror = () => {clearTimeout(timer); reject(new Error('Inspector connection failed'));};
    });
    let seq = 0;
    ws.onmessage = event => {
      const m = JSON.parse(event.data), waiter = pending.get(m.id);
      if (!waiter) return;
      pending.delete(m.id); clearTimeout(waiter.timer);
      m.error ? waiter.reject(new Error(m.error.message)) : waiter.resolve(m.result);
    };
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error('Inspector timeout; no automatic mutation retry'));}, 20000);
      pending.set(id, {resolve, reject, timer}); ws.send(JSON.stringify({id, method, params}));
    });
    evaluate = async expression => {
      const r = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const identity = await evaluate('({pid:process.pid,execPath:process.execPath,electron:process.versions.electron})');
    if (identity.pid !== bossPid || fs.realpathSync(identity.execPath) !== fs.realpathSync(appMain) || !identity.electron) throw new Error('Inspector does not belong to the selected BOSS main process');
    identityVerified = true;
    const main = (body, data = {}) => evaluate(`(async()=>{
      if(process.pid!==${bossPid})throw new Error('BOSS process changed');
      const e=process.mainModule.require('electron'),all=e.webContents.getAllWebContents();
      const roots=all.filter(w=>w.getType()==='window'&&w.getURL().includes('#/main/webview'));
      const views=all.filter(w=>w.getType()==='webview'&&w.getURL().startsWith('https://www.zhipin.com/web/client/'));
      const data=${JSON.stringify(data)};
      ${body}
    })()`);
    const renderer = (kind, expression) => main(`const candidates=${kind === 'root' ? 'roots' : 'views'};
      if(candidates.length!==1)throw new Error('Expected one ${kind} target');
      return candidates[0].executeJavaScript(${JSON.stringify(expression)});`);
    const bridge = (actType, act, data) => renderer('root', 'window.$socket.send(' + JSON.stringify({type: 'message', actType, act, ...(data === undefined ? {} : {data})}) + ')');
    return await callback({identity, main, renderer, bridge});
  } finally {
    try {
      if (started && identityVerified) {
        await evaluate(`(()=>{setTimeout(()=>process.mainModule.require('inspector').close(),100);return true})()`);
        for (let i=0;i<20;i++) {await sleep(100); if (!(await targets()).length) break;}
        if ((await targets()).length) throw new Error('Inspector cleanup not confirmed; BOSS was left running');
      } else if (started && !identityVerified) {
        console.error('Inspector ownership was not verified; no close command was sent. Inspect the local listener manually.');
      }
    } finally {
      if (ws) ws.close();
      for (const waiter of pending.values()) {clearTimeout(waiter.timer); waiter.reject(new Error('Inspector closed'));}
      fs.closeSync(lockFd); fs.unlinkSync(lockPath);
    }
  }
}
