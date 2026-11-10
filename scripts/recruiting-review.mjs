#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash} from './runtime.mjs';
import {privateDirectory} from './platform.mjs';
import {prepareOfflineReview, checkOfflineReview} from '../skills/boss-recruiting-agent/scripts/offline_review.mjs';

export function prepareReviewFile(file) {
  const bytes = fs.readFileSync(file);
  const packet = JSON.parse(bytes.toString('utf8'));
  if (packet.source && (!packet.sourceByteSHA || hash(fs.readFileSync(packet.source)) !== packet.sourceByteSHA)) throw new Error('History source bytes mismatch');
  return {...prepareOfflineReview(packet), packetFileSha256: hash(bytes)};
}

function main() {
  const [mode, input, responseOrOutput, output] = process.argv.slice(2);
  if (!['prepare', 'check'].includes(mode) || !responseOrOutput || (mode === 'check' && !output)) throw new Error('Usage: recruiting-review.mjs prepare <packet> <new-request> | check <request> <model-response> <new-check>');
  const target = path.resolve(mode === 'prepare' ? responseOrOutput : output);
  if (fs.existsSync(target) || [input, mode === 'check' ? responseOrOutput : input].some(f => path.resolve(f) === target)) throw new Error('Output must be a separate new file');
  const result = mode === 'prepare' ? prepareReviewFile(input)
    : checkOfflineReview(JSON.parse(fs.readFileSync(input, 'utf8')), JSON.parse(fs.readFileSync(responseOrOutput, 'utf8')));
  privateDirectory(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(result), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({ok: mode === 'prepare' || result.valid, mainApprovalRequired: true, errors: result.errors ?? [], bytes: fs.statSync(target).size}));
  if (result.valid === false) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(JSON.stringify({ok: false, stage: 'offline_review', error: error.message})); process.exitCode = 1; }
}
