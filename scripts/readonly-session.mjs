import {withBoss, historyFingerprint} from './runtime.mjs';
import {projectHistory} from './batch.mjs';
import {archivePath} from './platform.mjs';
import {readCompleteHistory} from './history-pagination.mjs';

// Reuses an owned Inspector only inside a bounded callback, never across processes
// or writes. There is deliberately no renderer, eval, arbitrary bridge or send API.
export async function withReadonlySession(callback, {
  connect = withBoss, now = Date.now, maxMs = 5000, maxCalls = 32,
  canRead = () => true, onMetric = () => {}, sourcePin = null,
} = {}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 500 ||
      !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 60_000) throw new Error('Invalid read-only session bounds');
  const started = now();
  return connect(async ctx => {
    const leaseStarted = now();
    if (sourcePin !== null) {
      if (!/^assets\/[a-zA-Z0-9._-]+\.js$/.test(sourcePin.member ?? '') || !/^[a-f0-9]{64}$/.test(sourcePin.sha256 ?? '')) throw new Error('Invalid actual-client source pin');
      const source = await ctx.main(`const fs=process.mainModule.require('fs'),p=process.mainModule.require('path'),c=process.mainModule.require('crypto');
        if(roots.length!==1)throw new Error('Expected one loaded client root');
        const entry=new URL(roots[0].getURL()),entryPath=decodeURIComponent(entry.pathname).replace(/^\\/([a-zA-Z]:)/,'$1');
        const normalize=s=>p.resolve(s).replaceAll('\\\\','/').toLowerCase();
        const expected=p.join(data.archive,'index.html'),entryBound=entry.protocol==='file:'&&normalize(entryPath)===normalize(expected);
        if(!entryBound)return {entryBound:false};
        return {sha256:c.createHash('sha256').update(fs.readFileSync(p.join(data.archive,...data.member.split('/')))).digest('hex'),
          entryBound,memberReferenced:fs.readFileSync(expected,'utf8').includes(data.member)};`,
        {archive: archivePath(ctx.identity.execPath), member: sourcePin.member}, {stage: 'ownership', action: 'verify-packaged-source'});
      if (source.sha256 !== sourcePin.sha256 || source.entryBound !== true || source.memberReferenced !== true) throw new Error('Actual packaged/loaded client source differs from reviewed SDK source');
    }
    let calls = 0, busy = false, poisoned = false, loggedIn = false, active = true;
    const contacts = new Map();
    async function request(action, data) {
      if (!active || busy || poisoned) throw new Error('Read-only session is closed, busy or failed; no automatic replay');
      if (now() - leaseStarted >= maxMs || calls >= maxCalls || !canRead()) {
        const error = new Error('Read-only observer yielded to workflow or session limit');
        error.code = 'OBSERVER_YIELD'; throw error;
      }
      busy = true; calls++; const at = now();
      try {
        const result = await ctx.bridge(action === '_sdk_getLoginStatus' ? 'message' : 'api', action, data);
        if (result?.code !== 0) throw new Error('Read-only SDK response was not successful');
        return result;
      } catch (error) { poisoned = true; throw error; }
      finally { busy = false; onMetric({action, elapsedMs: now() - at}); }
    }
    async function login() {
      if (loggedIn) return;
      const result = await request('_sdk_getLoginStatus');
      if (result.data !== true) { poisoned = true; throw new Error('Existing client is not logged in'); }
      loggedIn = true;
    }
    const session = {
      async contacts(page) {
        if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('Invalid contact page');
        await login();
        const result = await request('zprelationGetFriendList', {page, pageSize: 100});
        const rows = result.zpData?.friendList;
        if (!Array.isArray(rows)) { poisoned = true; throw new Error('Contact schema changed'); }
        for (const c of rows) {
          if (!Number.isSafeInteger(c?.uid) || c.uid < 1 || typeof c.name !== 'string' || !c.name || c.jobId == null) {
            poisoned = true; throw new Error('Contact identity schema changed');
          }
          const key = `${String(c.jobId)}:${c.uid}`;
          const old = contacts.get(key);
          if (old && (old.name !== c.name || String(old.jobId) !== String(c.jobId))) {
            poisoned = true; throw new Error('Contact identity changed inside read session');
          }
          contacts.set(key, c);
        }
        return rows;
      },
      async history(candidate) {
        await login();
        const c = contacts.get(`${String(candidate.jobId)}:${candidate.uid}`);
        if (!c || c.name !== candidate.name || String(c.jobId) !== String(candidate.jobId)) throw new Error('History requires freshly matched contact in this session');
        if (typeof c.securityId !== 'string' || !c.securityId) throw new Error('History target metadata missing');
        const response = await readCompleteHistory(params => request('zpChatHistoryMsg', params), {uid: c.uid, securityId: c.securityId});
        const view = projectHistory(response, candidate);
        const messages = response.zpData.messages;
        if (!view.complete || new Set(messages.map(m => String(m.mid))).size !== messages.length || messages.some(m => m.mid == null)) {
          poisoned = true; throw new Error('History incomplete or duplicated; no watermark advance');
        }
        return {complete: true, messages, sha256: historyFingerprint(messages)};
      },
    };
    try { return await callback(Object.freeze(session)); }
    finally { active = false; onMetric({action: 'session', elapsedMs: now() - started, calls}); }
  }, {purpose: 'bounded_readonly_observer'});
}
