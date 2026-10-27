import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {defaultAppMain, windowsProcesses, selectWindowsMain, activateInspector, verifyWindowsListener, privateDirectory} from './platform.mjs';
import {attachDiagnosticContext} from './diagnostics.mjs';

export let appMain = ['win32', 'darwin'].includes(process.platform) ? defaultAppMain(process.platform, process.env, []) : (process.env.BOSS_APP_MAIN || '');
export const sendLock = process.env.BOSS_SEND_LOCK || path.join(os.tmpdir(), 'boss-recruiting-send.lock');
const endpoint = new URL(process.env.BOSS_INSPECTOR_URL || 'http://127.0.0.1:9229');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Inspector must be a loopback HTTP origin');
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function historyFingerprint(messages) {
  // Only the message envelope's per-read securityId rotates in observed history.
  // Keep the full body, identities, IDs, timestamps and all other metadata bound.
  return hash(JSON.stringify(messages.map(({securityId, ...message}) => message)));
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function save(file, value, exclusive = true) {
  privateDirectory(path.dirname(path.resolve(file)));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: exclusive ? 'wx' : 'w'});
}
export function pid() {
  if (process.platform === 'win32') {
    const main = selectWindowsMain(windowsProcesses(), process.env.BOSS_APP_MAIN);
    appMain = main.ExecutablePath;
    return main.ProcessId;
  }
  if (process.platform !== 'darwin') throw new Error('Runtime platform is unverified; use Windows or macOS');
  const matches = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'}).split('\n')
    .map(row => row.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(m => m[2] === appMain || m[2].startsWith(appMain + ' '));
  if (matches.length !== 1) throw new Error('Expected one running BOSS main process; no process was started');
  return Number(matches[0][1]);
}
export async function targets({deadline = null} = {}) {
  const startedAt=Date.now();
  for (let attempt = 0; attempt < 2; attempt++) try {
    const remaining = deadline === null ? 1500 : Math.min(1500, deadline - Date.now());
    if (remaining <= 0) throw stageError('Inspector discovery deadline reached', {stage: 'discovery', action: 'list-targets', code: 'DISCOVERY_DEADLINE'});
    const response = await fetch(new URL('json/list', endpoint), {signal: AbortSignal.timeout(Math.ceil(remaining)), redirect: 'error', headers: {connection: 'close'}});
    if (!response.ok) throw new Error('Inspector HTTP ' + response.status);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Unexpected Inspector discovery body');
    return result;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return [];
    // A closing Inspector can reset discovery. Retry only this read, never a business call.
    if (attempt === 0 && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code) && (deadline === null || Date.now() + 50 < deadline)) { await sleep(50); continue; }
    throw annotateError(error,{stage:'discovery',action:'list-targets',attempt:attempt+1},startedAt);
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
  if (a.contractVersion !== undefined && a.contractVersion !== 2) throw new Error('Unsupported send approval version');
  if (a.contractVersion === 2 && (typeof a.jobId !== 'string' || !a.jobId.trim())) throw new Error('Version 2 approval must bind the exact job ID');
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

function boundedDurationFromEnv(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 && value <= maximum ? Math.floor(value) : fallback;
}

const wsConnectTimeoutMs = boundedDurationFromEnv('BOSS_WS_CONNECT_TIMEOUT_MS', 5000, 60_000);
const cdpRequestTimeoutMs = boundedDurationFromEnv('BOSS_CDP_REQUEST_TIMEOUT_MS', 20_000, 120_000);

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function stageError(message, context = {}, cause, startedAt) {
  const error = cause === undefined ? new Error(message) : new Error(message, {cause});
  if (context.code) error.code = context.code;
  const duration=startedAt === undefined ? null : elapsed(startedAt);
  return attachDiagnosticContext(error, duration === null ? context : {...context, elapsed:duration, elapsedMs:duration});
}

function annotateError(error, context = {}, startedAt) {
  const target = error && (typeof error === 'object' || typeof error === 'function') ? error : new Error('Operation failed', {cause: error});
  return attachDiagnosticContext(target, startedAt === undefined ? context : {...context, elapsed: elapsed(startedAt), elapsedMs: elapsed(startedAt)});
}

// Foreground operations may wait for our bounded read-only observer to yield.
// This retries lock acquisition only: no business request or sender is replayed.
export async function acquireInspectorLock(lockPath, {io = fs, alive = processId => {
  try { process.kill(processId, 0); return true; } catch { return false; }
}, wait = sleep, now = Date.now, waitMs = 30_000} = {}) {
  const until = now() + waitMs;
  for (;;) {
    try { return io.openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || typeof io.readFileSync !== 'function') throw error;
      let owner;
      try { owner = JSON.parse(io.readFileSync(lockPath, 'utf8')); } catch {
        // open('wx') and the owner write are separate operations. Give only this
        // initial publication window a short read-only grace; never delete it.
        if (now() < until - waitMs + 200) { await wait(50); continue; }
        throw error;
      }
      if (owner.action !== 'bounded_readonly_observer' || !Number.isSafeInteger(owner.pid) ||
          owner.pid <= 0 || !alive(owner.pid) || now() >= until) throw error;
      await wait(50);
    }
  }
}

export async function withBoss(callback, {purpose = 'operation'} = {}) {
  if (!['operation', 'bounded_readonly_observer'].includes(purpose)) throw new Error('Unsupported Inspector session purpose');
  const requestTimeoutMs = purpose === 'bounded_readonly_observer' ? Math.min(cdpRequestTimeoutMs, 2000) : cdpRequestTimeoutMs;
  const socketTimeoutMs = purpose === 'bounded_readonly_observer' ? Math.min(wsConnectTimeoutMs, 2000) : wsConnectTimeoutMs;
  const connectionStartedAt = Date.now();
  let bossPid;
  try {
    bossPid = pid();
  } catch (error) {
    throw annotateError(error, {stage: 'connection', action: 'locate-boss-process', code: 'BOSS_PROCESS_LOOKUP_FAILED'}, connectionStartedAt);
  }

  const lockPath = path.join(os.tmpdir(), 'boss-desktop-inspector.lock');
  const lockStartedAt = Date.now();
  let lockFd;
  try {
    lockFd = purpose === 'bounded_readonly_observer'
      ? fs.openSync(lockPath, 'wx', 0o600)
      : await acquireInspectorLock(lockPath);
  } catch (error) {
    throw annotateError(error, {stage: 'lock', action: 'acquire-inspector-lock'}, lockStartedAt);
  }

  let ws;
  let socketOpen = false;
  let started = false;
  let identityVerified = false;
  let evaluate;
  let failure = null;
  const pending = new Map();

  function rejectPending(message, context, cause) {
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(stageError(message, {
        ...context,
        action: waiter.action,
        requestId: waiter.requestId,
        stage: context.stage ?? waiter.stage,
      }, cause, waiter.startedAt));
    }
  }

  function rejectAllPendingForTransport(message, code, cause) {
    if (!pending.size) return;
    rejectPending(message, {stage: 'cdp', action: 'receive-response', code}, cause);
  }

  try {
    const lockWriteStartedAt = Date.now();
    try {
      fs.writeSync(lockFd, JSON.stringify({pid: process.pid, at: new Date().toISOString(), action: purpose}));
    } catch (error) {
      throw annotateError(error, {stage: 'lock', action: 'write-inspector-lock'}, lockWriteStartedAt);
    }

    const setupDeadline = purpose === 'bounded_readonly_observer' ? Date.now() + 10_000 : null;
    let list = await targets(setupDeadline === null ? {} : {deadline: setupDeadline});
    if (!list.length) {
      const activationStartedAt = Date.now();
      try {
        if (process.platform === 'win32' && endpoint.port !== '9229')
          throw stageError('Windows auto-activation requires the default 9229 endpoint; custom endpoints must already be listening', {stage: 'activation', action: 'validate-endpoint', code: 'INSPECTOR_ACTIVATION_ENDPOINT_INVALID'});
        if (pid() !== bossPid) throw stageError('BOSS main process changed before Inspector activation', {stage: 'activation', action: 'recheck-process', code: 'BOSS_PROCESS_CHANGED'});
        started = true;
        activateInspector(bossPid);
        for (let index = 0; index < 30 && !list.length; index++) {
          if (setupDeadline !== null && Date.now() >= setupDeadline) throw new Error('Read-only observer discovery deadline reached');
          await sleep(150);
          list = await targets(setupDeadline === null ? {} : {deadline: setupDeadline});
        }
      } catch (error) {
        throw annotateError(error, {stage: 'activation', action: 'activate-inspector', code: 'INSPECTOR_ACTIVATION_FAILED'}, activationStartedAt);
      }
    }
    if (list.length !== 1) throw stageError('Expected one Inspector target; stop rather than restarting BOSS', {stage: 'discovery', action: 'select-target', code: 'INSPECTOR_TARGET_COUNT_INVALID'});

    if (process.platform === 'win32') {
      const listenerStartedAt = Date.now();
      try {
        verifyWindowsListener(Number(endpoint.port || 80), bossPid);
      } catch (error) {
        throw annotateError(error, {stage: 'connection', action: 'verify-listener', code: 'INSPECTOR_LISTENER_INVALID'}, listenerStartedAt);
      }
    }

    const url = new URL(list[0].webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || (url.port || '80') !== (endpoint.port || '80') || url.username || url.password || url.search || url.hash)
      throw stageError('Unexpected Inspector WebSocket endpoint', {stage: 'ws', action: 'validate-endpoint', code: 'WS_ENDPOINT_INVALID'});

    const connectStartedAt = Date.now();
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => settle(stageError('Inspector WebSocket connection timed out', {stage: 'ws', action: 'connect', code: 'WS_CONNECT_TIMEOUT'}, {kind: 'timeout', timeoutMs: socketTimeoutMs}, connectStartedAt)), socketTimeoutMs);
      ws.onopen = () => {
        socketOpen = true;
        settle();
      };
      ws.onerror = event => {
        if (!socketOpen) {
          settle(stageError('Inspector WebSocket connection failed', {stage: 'ws', action: 'connect', code: 'WS_CONNECT_ERROR'}, event?.error, connectStartedAt));
          return;
        }
        rejectAllPendingForTransport('Inspector WebSocket failed before the CDP response', 'WS_ERROR', event?.error);
      };
      ws.onclose = event => {
        socketOpen = false;
        if (!settled) {
          settle(stageError('Inspector WebSocket closed before it opened', {stage: 'ws', action: 'connect', code: 'WS_CONNECT_CLOSED'}, {closeCode: safeCloseCode(event)}, connectStartedAt));
          return;
        }
        rejectAllPendingForTransport('Inspector WebSocket closed before the CDP response', 'WS_CLOSED', {closeCode: safeCloseCode(event)});
      };
    });

    let seq = 0;
    ws.onmessage = event => {
      let message;
      try {
        if (typeof event?.data !== 'string') throw new Error('non-text frame');
        message = JSON.parse(event.data);
      } catch {
        rejectAllPendingForTransport('Inspector WebSocket sent an invalid frame', 'CDP_INVALID_FRAME');
        return;
      }
      if (message && typeof message === 'object' && Object.hasOwn(message, 'method') && !Object.hasOwn(message, 'id')) return;
      if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id)) {
        rejectAllPendingForTransport('Inspector WebSocket sent an invalid CDP message', 'CDP_PROTOCOL_ERROR');
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const nativeError=new Error(typeof message.error.message==='string'?message.error.message:'Inspector CDP request failed');
        nativeError.name='CDPError';
        nativeError.code=message.error.code;
        if(typeof message.error.stack==='string') nativeError.stack=message.error.stack;
        const nativeCause=nativeError;
        waiter.reject(stageError('Inspector CDP request failed', {
          stage: waiter.stage,
          action: waiter.action,
          requestId: waiter.requestId,
          code: 'CDP_REMOTE_ERROR',
        }, nativeCause, waiter.startedAt));
        return;
      }
      if (!message.result || typeof message.result !== 'object') {
        waiter.reject(stageError('Inspector CDP response was invalid', {
          stage: waiter.stage,
          action: waiter.action,
          requestId: waiter.requestId,
          code: 'CDP_PROTOCOL_ERROR',
        }, undefined, waiter.startedAt));
        return;
      }
      waiter.resolve({id: waiter.requestId, result: message.result});
    };

    const call = (method, params, diagnostic = {}) => new Promise((resolve, reject) => {
      const requestId = ++seq;
      const startedAt = Date.now();
      const stage = diagnostic.stage ?? 'cdp';
      const action = diagnostic.action ?? method;
      const timeoutMs = Number.isFinite(diagnostic.timeoutMs) ? Math.max(1, Math.min(requestTimeoutMs, diagnostic.timeoutMs)) : requestTimeoutMs;
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return;
        reject(stageError('Inspector CDP request timed out; no automatic mutation retry', {
          stage, action, requestId, code: 'CDP_REQUEST_TIMEOUT',
        }, {kind: 'timeout', timeoutMs}, startedAt));
      }, timeoutMs);
      pending.set(requestId, {resolve, reject, timer, requestId, stage, action, startedAt});
      try {
        ws.send(JSON.stringify({id: requestId, method, params}));
      } catch (error) {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        reject(stageError('Inspector CDP send failed', {
          stage, action, requestId, code: 'CDP_SEND_ERROR',
        }, error, startedAt));
      }
    });

    evaluate = async (expression, diagnostic = {}) => {
      const response = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, diagnostic);
      const result = response.result;
      if (result.exceptionDetails) {
        const remoteName = typeof result.exceptionDetails.exception?.className === 'string'
          ? result.exceptionDetails.exception.className
          : 'Error';
        const description = typeof result.exceptionDetails.exception?.description === 'string'
          ? result.exceptionDetails.exception.description
          : (typeof result.exceptionDetails.text === 'string' ? result.exceptionDetails.text : 'Inspector evaluation failed');
        const nativeCause=new Error(description);
        nativeCause.name=remoteName;
        nativeCause.stack=description;
        throw stageError('Inspector evaluation failed', {
          stage: diagnostic.stage ?? 'cdp',
          action: diagnostic.action ?? 'Runtime.evaluate',
          requestId: response.id,
          code: 'CDP_EVALUATION_ERROR',
        }, nativeCause);
      }
      if (!result.result || typeof result.result !== 'object') {
        throw stageError('Inspector evaluation returned an invalid result', {
          stage: diagnostic.stage ?? 'cdp',
          action: diagnostic.action ?? 'Runtime.evaluate',
          requestId: response.id,
          code: 'CDP_PROTOCOL_ERROR',
        });
      }
      return result.result.value;
    };

    const identity = await evaluate('({pid:process.pid,execPath:process.execPath,electron:process.versions.electron,node:process.versions.node,platform:process.platform,arch:process.arch})',{stage:'ownership',action:'read-process-identity'});
    const ownershipStartedAt = Date.now();
    try {
      if (identity.pid !== bossPid || fs.realpathSync(identity.execPath) !== fs.realpathSync(appMain) || !identity.electron)
        throw stageError('Inspector does not belong to the selected BOSS main process', {stage: 'ownership', action: 'verify-process-identity', code: 'BOSS_OWNERSHIP_MISMATCH'});
    } catch (error) {
      throw annotateError(error, {stage: 'ownership', action: 'verify-process-identity', code: 'BOSS_OWNERSHIP_MISMATCH'}, ownershipStartedAt);
    }
    identityVerified = true;

    const main = (body, data = {}, diagnostic = {}) => evaluate(`(async()=>{
      if(process.pid!==${bossPid})throw new Error('BOSS process changed');
      const e=process.mainModule.require('electron'),all=e.webContents.getAllWebContents();
      const roots=all.filter(w=>w.getType()==='window'&&w.getURL().includes('#/main/webview'));
      const views=all.filter(w=>w.getType()==='webview'&&w.getURL().startsWith('https://www.zhipin.com/web/client/'));
      const data=${JSON.stringify(data)};
      ${body}
    })()`, {
      stage: diagnostic.stage ?? 'main',
      action: diagnostic.action ?? 'renderer-hosting',
    });

    const renderer = (kind, expression, diagnostic = {}) => main(`const candidates=${kind === 'root' ? 'roots' : 'views'};
      if(candidates.length!==1)throw new Error('Expected one ${kind} target');
      return candidates[0].executeJavaScript(${JSON.stringify(expression)});`, {}, {
      stage: diagnostic.stage ?? 'sdk',
      action: diagnostic.action ?? 'renderer-evaluate',
    });

    const bridge = (actType, act, data) => renderer('root', 'window.$socket.send(' + JSON.stringify({type: 'message', actType, act, ...(data === undefined ? {} : {data})}) + ')', {
      stage: 'bridge',
      action: 'safe-bridge-read',
    });

    try {
      return await callback({identity, main, renderer, bridge});
    } catch (error) {
      throw annotateError(error, {stage: 'callback', action: 'orchestration'});
    }
  } catch (error) {
    failure = annotateError(error, {stage: 'orchestration', action: 'with-boss'});
    throw failure;
  } finally {
    const cleanupFailures = [];
    const recordCleanup = async (action, callback) => {
      const startedAt = Date.now();
      try {
        return await callback();
      } catch (error) {
        const causeCode = error?.code ?? error?.diagnosticContext?.code ?? 'CLEANUP_FAILED';
        cleanupFailures.push(stageError('Inspector cleanup step failed', {stage: 'cleanup', action, code: causeCode}, error, startedAt));
        return undefined;
      }
    };

    if (started && identityVerified && ws && socketOpen) {
      await recordCleanup('close-inspector', async () => {
        const deadline = purpose === 'bounded_readonly_observer' ? Date.now() + 2000 : null;
        await evaluate(`(()=>{setTimeout(()=>process.mainModule.require('inspector').close(),100);return true})()`, {stage: 'cleanup', action: 'close-inspector', ...(deadline === null ? {} : {timeoutMs: deadline - Date.now()})});
        for (let index = 0; index < 20; index++) {
          if (deadline !== null && Date.now() >= deadline) break;
          await sleep(deadline === null ? 100 : Math.min(100, Math.max(0, deadline - Date.now())));
          if (deadline !== null && Date.now() >= deadline) break;
          if (!(await targets(deadline === null ? {} : {deadline})).length) return;
        }
        throw stageError('Inspector cleanup not confirmed; BOSS was left running', {stage: 'cleanup', action: 'confirm-inspector-closed', code: 'CLEANUP_NOT_CONFIRMED'});
      });
    } else if (started && identityVerified) {
      cleanupFailures.push(stageError('Inspector cleanup unavailable because its WebSocket was lost', {
        stage:'cleanup',action:'close-inspector',code:'CLEANUP_UNAVAILABLE',
      }));
    } else if (started && !identityVerified) {
      cleanupFailures.push(stageError('Inspector ownership was not verified; no close command was sent', {
        stage:'cleanup',action:'close-inspector',code:'INSPECTOR_OWNERSHIP_UNVERIFIED',
      }));
    }

    if (ws) {
      await recordCleanup('close-websocket', () => {
        socketOpen = false;
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      });
    }
    if (pending.size) {
      await recordCleanup('reject-pending-requests', () => {
        rejectPending('Inspector closed before the CDP response', {stage: 'cleanup', action: 'reject-pending-requests', code: 'WS_CLOSED'});
      });
    }
    await recordCleanup('close-lock-descriptor', () => fs.closeSync(lockFd));
    await recordCleanup('remove-lock-file', () => fs.unlinkSync(lockPath));

    if (failure && cleanupFailures.length) {
      attachDiagnosticContext(failure, {cleanup: cleanupFailures});
    } else if (!failure && cleanupFailures.length) {
      const cleanupError = cleanupFailures[0];
      if (cleanupFailures.length > 1) attachDiagnosticContext(cleanupError, {cleanup: cleanupFailures.slice(1)});
      throw cleanupError;
    }
  }
}

function safeCloseCode(event) {
  return Number.isSafeInteger(event?.code) ? event.code : null;
}
