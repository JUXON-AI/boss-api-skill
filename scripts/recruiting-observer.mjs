#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {hash, sleep, sendLock} from './runtime.mjs';
import {privateDirectory} from './platform.mjs';
import {withReadonlySession} from './readonly-session.mjs';
import {serializeDiagnosticError} from './diagnostics.mjs';
import {planIncremental, commitObservations, diffInbound} from '../skills/boss-recruiting-agent/scripts/incremental_observer.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
function validateConfig(config) {
  if (config.schemaVersion !== 1 || typeof config.jobId !== 'string' || !config.jobId ||
      !path.isAbsolute(config.root) || !Array.isArray(config.scope) || !Array.isArray(config.workflowLocks) ||
      config.authorization?.readCurrentJob !== true || typeof config.authorization.reference !== 'string') throw new Error('Invalid observer configuration/authorization');
  if (!fs.existsSync(config.authorization.reference)) throw new Error('Observer authorization source missing');
  if (!/^assets\/[a-zA-Z0-9._-]+\.js$/.test(config.clientSource?.member ?? '')) throw new Error('Runtime source member pin required');
  if (hash(fs.readFileSync(config.clientSource.path)) !== config.clientSource.sha256) throw new Error('Unpacked client source changed');
  if (!Number.isInteger(config.maxHistoriesPerPass) || config.maxHistoriesPerPass < 1 || config.maxHistoriesPerPass > 32) throw new Error('Bounded observer history budget required');
  if (config.sessionMaxMs !== undefined && (!Number.isFinite(config.sessionMaxMs) || config.sessionMaxMs < 5000 || config.sessionMaxMs > 30000)) throw new Error('Observer session budget must be 5000..30000ms');
  for (const c of config.scope) {
    if (!Number.isSafeInteger(c.uid) || c.uid < 1 || typeof c.name !== 'string' || !c.name || c.jobId !== config.jobId) throw new Error('Invalid observer scope identity');
    if (c.handledMids !== undefined && (!Array.isArray(c.handledMids) || c.handledMids.some(mid => !Number.isSafeInteger(mid) || mid <= 0))) throw new Error('Observer handledMids must use positive safe integer IDs');
  }
}
export async function observeOnce(config, {withSession = withReadonlySession, now = Date.now, wait = sleep} = {}) {
  validateConfig(config);
  const busy = () => [...config.workflowLocks, sendLock].some(file => fs.existsSync(file));
  if (busy()) return {status: 'yielded', reason: 'workflow_busy', messagesSent: 0};
  privateDirectory(config.root);
  const lock = path.join(config.root, 'observer.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
  fs.writeSync(fd, JSON.stringify({pid: process.pid, at: new Date().toISOString(), action: 'readonly_incremental_observer'}));
  const started = now(), stamp = new Date(started).toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const out = path.join(config.root, 'observations', stamp), metrics = [], successes = [], failures = [];
  const checkpointPath = path.join(config.root, 'checkpoint.json');
  const checkpoint = fs.existsSync(checkpointPath) ? read(checkpointPath) : {};
  const failurePath = path.join(config.root, 'read-failures.json');
  const failedReads = fs.existsSync(failurePath) ? read(failurePath) : {};
  privateDirectory(out); privateDirectory(path.join(out, 'histories')); privateDirectory(path.join(config.root, 'events'));
  const queuedMids = new Map();
  for (const name of fs.readdirSync(path.join(config.root, 'events')).filter(x => x.endsWith('.json'))) {
    const event = read(path.join(config.root, 'events', name));
    if (event.jobId !== config.jobId || !Number.isSafeInteger(event.uid)) throw new Error('Queue event identity is invalid');
    const key = String(event.uid), mids = queuedMids.get(key) ?? new Set();
    for (const mid of [...event.candidateTextMids, ...event.platformMids]) mids.add(String(mid));
    queuedMids.set(key, mids);
  }
  let pages = [], planned = 0, queued = 0, listCoverage = 'bounded_page_limit', observerError = null;
  try {
    await withSession(async session => {
      const contacts = [], signatures = new Set();
      for (let page = 1; page <= 10; page++) {
        const rows = await session.contacts(page), signature = hash(JSON.stringify(rows.map(c => c.uid)));
        if (signatures.has(signature)) throw new Error('Repeated contact page; coverage unverified');
        signatures.add(signature); pages.push({page, count: rows.length, signature});
        contacts.push(...rows.filter(c => String(c.jobId) === config.jobId));
        write(path.join(out, `contacts-${page}.json`), rows.filter(c => String(c.jobId) === config.jobId).map(({uid, name, jobId, lastTS, relationType}) => ({uid, name, jobId: String(jobId), lastTS, relationType})));
        if (rows.length < 100) {listCoverage = 'observed_short_final_page_no_server_total'; break;}
        await wait(200);
      }
      let plan = planIncremental({contacts, scope: config.scope, checkpoint, now: started,
        fullScanIntervalMs: config.fullScanIntervalMs ?? 4 * 3600_000, jobId: config.jobId});
      if (config.authorization.newGreetings === true && plan.newCandidates.length) {
        plan = planIncremental({contacts, scope: [...config.scope, ...plan.newCandidates], checkpoint, now: started,
          fullScanIntervalMs: config.fullScanIntervalMs ?? 4 * 3600_000, jobId: config.jobId});
      }
      write(path.join(out, 'plan.json'), plan);
      // Identity failures stay excluded by the planner. Do not block unrelated
      // valid candidates or claim these missing ranges were successfully read.
      failures.push(...(plan.issues ?? []).map(issue => ({uid: issue.uid ?? null, code: issue.code})));
      const checkpointKey = c => `${encodeURIComponent(config.jobId)}::${c.uid}`;
      const latestActivity = new Map(contacts.map(c => [c.uid, c.lastTS]));
      const reads = plan.reads.filter(item => {
        if (!(config.authorization.newGreetings === true || config.scope.some(c => c.uid === item.candidate.uid))) return false;
        const failed = failedReads[checkpointKey(item.candidate)];
        if (failed?.metadataFingerprint === item.metadataFingerprint) {
          failures.push({uid: item.candidate.uid, code: 'READ_FAILURE_PENDING_REVIEW'}); return false;
        }
        return true;
      })
        .sort((a, b) => {
          const priority = item => !config.scope.some(c => c.uid === item.candidate.uid) ? 0 : item.reason === 'metadata_changed' ? 1 : 2;
          return priority(a) - priority(b) || (checkpoint.entries?.[checkpointKey(a.candidate)]?.lastFullScanAt ?? 0) - (checkpoint.entries?.[checkpointKey(b.candidate)]?.lastFullScanAt ?? 0)
            || (latestActivity.get(b.candidate.uid) ?? 0) - (latestActivity.get(a.candidate.uid) ?? 0);
        });
      planned = reads.length;
      // Oldest successful observations first: a budget must not starve later UIDs.
      for (const item of reads.slice(0, config.maxHistoriesPerPass)) {
        const c = item.candidate;
        try {
          const snapshot = await session.history(c);
          const file = path.join(out, 'histories', `${c.uid}.json`);
          const safeMessages = snapshot.messages.map(({securityId, ...message}) => message);
          write(file, {at: new Date(now()).toISOString(), candidate: {uid: c.uid, name: c.name, jobId: config.jobId}, complete: true, sha256: snapshot.sha256, messages: safeMessages});
          const known = config.scope.find(x => x.uid === c.uid);
          const stateKey = checkpointKey(c);
          let previousMids = checkpoint.entries?.[stateKey]?.mids ?? [];
          // First read uses the formal record's capture time as a baseline; pending
          // or undated messages remain visible. Exact reviewed mids are separate.
          if (!checkpoint.entries?.[stateKey] && known?.recordPath && fs.existsSync(known.recordPath)) {
            const record = read(known.recordPath);
            if (record.candidate.uid !== c.uid || record.candidate.name !== c.name || record.job.boss_job_id !== config.jobId) throw new Error('Formal observer baseline identity changed');
            const checkedAt = Date.parse(record.history.checked_at), pending = new Set(record.communication.pending_inbound_mids.map(String));
            previousMids = snapshot.messages.filter(m => Number.isFinite(m.time) && m.time <= checkedAt && !pending.has(String(m.mid))).map(m => m.mid);
          }
          const diff = diffInbound({candidate: c, messages: snapshot.messages, previousMids, handledMids: known?.handledMids ?? []});
          if (diff.issues.length) throw new Error('Inbound schema requires manual review');
          const newMids = [...diff.candidateTextMids, ...diff.platformMids].filter(mid => !queuedMids.get(String(c.uid))?.has(String(mid)));
          for (const mid of newMids) {
            const eventKey = hash(JSON.stringify([config.jobId, c.uid, String(mid)]));
            const event = path.join(config.root, 'events', eventKey + '.json');
            if (!fs.existsSync(event)) {
              write(event, {schemaVersion: 1, eventKey, jobId: config.jobId, uid: c.uid, name: c.name,
                source: file, sourceFileSha256: hash(fs.readFileSync(file)), historySha256: snapshot.sha256,
                candidateTextMids: diff.candidateTextMids.includes(mid) ? [mid] : [], platformMids: diff.platformMids.includes(mid) ? [mid] : [],
                status: 'pending_main_review', discoveredNewIdentity: !known, noSendAuthorizationGranted: true});
              queued++;
            }
          }
          successes.push({candidate: c, metadataFingerprint: item.metadataFingerprint, mids: snapshot.messages.map(m => m.mid), complete: true});
        } catch (error) {
          write(path.join(out, `read-failure-${c.uid}.json`), {at: new Date(now()).toISOString(), uid: c.uid, diagnostic: serializeDiagnosticError(error), SDKSendInvoked: false});
          failures.push({uid: c.uid, code: error.code ?? 'READ_NOT_COMPLETED'});
          if (error.code !== 'OBSERVER_YIELD') {
            failedReads[checkpointKey(c)] = {uid: c.uid, jobId: config.jobId, metadataFingerprint: item.metadataFingerprint,
              at: new Date(now()).toISOString(), source: out, code: error.code ?? 'READ_NOT_COMPLETED', requiresMainReview: true};
          }
          throw error; // No replay after transport failure inside this connection.
        }
        await wait(200);
      }
    }, {maxMs: config.sessionMaxMs ?? 5000, maxCalls: 24, canRead: () => !busy(), onMetric: m => metrics.push(m), sourcePin: config.clientSource});
  } catch (error) {
    observerError = {code: error.code ?? 'OBSERVER_STOPPED', name: error.name};
    write(path.join(out, 'failure.json'), {at: new Date(now()).toISOString(), diagnostic: serializeDiagnosticError(error), SDKSendInvoked: false});
  }
  finally {
      if (successes.length) {
        const next = commitObservations({checkpoint, successes, now: now()});
        const temp = path.join(config.root, 'checkpoint-' + stamp + '.json');
        write(temp, next);
        fs.renameSync(temp, checkpointPath);
      }
      const summary = {at: new Date(now()).toISOString(), status: observerError || failures.length ? 'partial_or_yielded' : planned > successes.length ? 'budget_deferred' : 'observed_batch_complete',
        out, elapsedMs: now() - started, pages, listCoverage, planned, complete: successes.length,
        remaining: Math.max(0, planned - successes.length), failures, queued, error: observerError,
        metrics, readOnly: true, messagesSent: 0, ledgerMutated: false, baseWrites: 0};
      write(path.join(out, 'summary.json'), summary);
      const pointer = path.join(config.root, 'latest-' + stamp + '.json');
      write(pointer, {at: summary.at, source: path.join(out, 'summary.json'), sourceSha256: hash(fs.readFileSync(path.join(out, 'summary.json'))),
        status: summary.status, eventsDirectory: path.join(config.root, 'events'), queued, remaining: summary.remaining, messagesSent: 0});
      fs.renameSync(pointer, path.join(config.root, 'latest.json'));
      if (Object.keys(failedReads).length) {
        const temp = path.join(config.root, 'read-failures-' + stamp + '.json'); write(temp, failedReads); fs.renameSync(temp, failurePath);
      }
  }
  return read(path.join(out, 'summary.json'));
  } finally {fs.closeSync(fd); fs.unlinkSync(lock);}
}

async function main() {
  const [mode, configFile] = process.argv.slice(2);
  if (!['once', 'watch'].includes(mode) || !configFile) throw new Error('Usage: recruiting-observer.mjs once|watch <private-config.json>');
  do {
    const config = read(configFile);
    if (fs.existsSync(path.join(config.root, 'stop.request'))) break;
    const result = await observeOnce(config);
    console.log(JSON.stringify({status: result.status, complete: result.complete ?? 0, queued: result.queued ?? 0, elapsedMs: result.elapsedMs ?? 0, readOnly: true}));
    if (mode !== 'watch') break;
    const interval = config.intervalMs ?? 60_000;
    if (!Number.isFinite(interval) || interval < 30_000 || interval > 4 * 3600_000) throw new Error('Observer interval must be 30 seconds..4 hours');
    await sleep(interval);
  } while (true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ok: false, stage: 'observer', error: error.name, code: error.code ?? 'OBSERVER_FAILED', automaticSendRetry: false})); process.exitCode = 1;
});
