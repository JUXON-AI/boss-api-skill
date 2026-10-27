#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {privateDirectory} from './platform.mjs';
import {hash, sendLock, sleep} from './runtime.mjs';
import {withReadonlySession} from './readonly-session.mjs';

export async function benchmarkReads({reads = 3, trials = 2, canRead = () => true, session = withReadonlySession, sourcePin = null} = {}) {
  if (!Number.isInteger(reads) || reads < 2 || reads > 10 || !Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error('Benchmark bounds exceeded');
  const results = [];
  for (let trial = 0; trial < trials; trial++) {
    for (const mode of trial % 2 ? ['reused', 'isolated'] : ['isolated', 'reused']) {
      if (!canRead()) throw new Error('Foreground workflow active; no benchmark reads');
      const start = performance.now(), metrics = []; let connections = 0, count = 0;
      const read = async s => {const rows = await s.contacts(1); count += rows.length; await sleep(200);};
      const options = {maxMs: 60_000, maxCalls: 30, canRead, onMetric: m => metrics.push(m), sourcePin};
      if (mode === 'isolated') {
        for (let i = 0; i < reads; i++) {connections++; await session(read, options);}
      } else {
        connections++; await session(async s => {for (let i = 0; i < reads; i++) await read(s);}, options);
      }
      results.push({mode, trial, elapsedMs: performance.now() - start, connections, reads, observedRows: count,
        sdkReadCalls: metrics.filter(x => x.action !== 'session').length});
    }
  }
  const mean = mode => {const a = results.filter(x => x.mode === mode); return a.reduce((sum, r) => sum + r.elapsedMs, 0) / a.length;};
  return {kind: 'live_readonly_contact_page_benchmark', results,
    isolatedMeanMs: mean('isolated'), reusedMeanMs: mean('reused'),
    speedup: mean('isolated') / mean('reused'),
    caveat: 'Measures contact-page reads and connection setup only, not candidate review or end-to-end replies.',
    messagesSent: 0, sdkSendCalls: 0, ledgerMutated: false, baseWrites: 0};
}
async function main() {
  const [configFile, outputDirectory] = process.argv.slice(2);
  if (!configFile || !outputDirectory) throw new Error('Usage: recruiting-read-benchmark.mjs <observer-config> <new-private-directory>');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.authorization?.readCurrentJob !== true || hash(fs.readFileSync(config.clientSource.path)) !== config.clientSource.sha256) throw new Error('Read authorization/source not verified');
  if (fs.existsSync(outputDirectory)) throw new Error('Benchmark output must be a new directory');
  const locks = [...config.workflowLocks, sendLock, path.join(os.tmpdir(), 'boss-desktop-inspector.lock')];
  const canRead = () => locks.every(f => !fs.existsSync(f));
  if (!canRead()) throw new Error('Another workflow owns runtime; benchmark postponed');
  privateDirectory(outputDirectory);
  // The connection itself owns the Inspector lock; only workflow/send locks are
  // checked while it is open. No history or candidate message is read in this test.
  const result = await benchmarkReads({sourcePin: config.clientSource, canRead: () => [...config.workflowLocks, sendLock].every(f => !fs.existsSync(f))});
  const sourceSha256 = Object.fromEntries(['runtime.mjs', 'readonly-session.mjs', 'recruiting-read-benchmark.mjs'].map(name => [name, hash(fs.readFileSync(new URL(name, import.meta.url)))]));
  fs.writeFileSync(path.join(outputDirectory, 'read-benchmark.json'), JSON.stringify({at: new Date().toISOString(), sourceSha256, ...result}, null, 2), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => {console.error(JSON.stringify({ok: false, error: e.name, code: e.code ?? null, automaticSendRetry: false})); process.exitCode = 1;});
