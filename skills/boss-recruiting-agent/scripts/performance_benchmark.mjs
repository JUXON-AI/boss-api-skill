#!/usr/bin/env node
import {performance} from 'node:perf_hooks';
import {hash} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {runReviewPipeline as checkedPipeline} from './review_pipeline.mjs';
// This benchmark deliberately measures only synthetic coordination latency.
// Production never supplies these in-memory proof substitutes.
const runReviewPipeline = options => checkedPipeline(options, {
  verifyAcceptance: () => true, verifyClaim: value => ({verified: value === true}),
  verifyExecution: () => ({verified: true}), completeClaim: () => ({completed: true}),
});

const REVIEW_DELAYS = [36, 12, 28, 4, 20, 8, 30, 16];
const CONCURRENCY = 4;
const EXECUTE_DELAY_MS = 4;
const RUNS = 5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function syntheticTask(delay, index) {
  const uid = 1000 + index;
  return {
    taskId: `synthetic-${uid}`,
    version: 'v1',
    sourceFingerprint: `synthetic-source-${uid}`,
    packet: {
      candidate: {uid, name: `Synthetic ${uid}`, boss_job_id: 'synthetic-job'},
      history: {sha256: `synthetic-history-${uid}`},
    },
    currentRecord: {},
    jobProfile: {},
    delay,
  };
}

function tasks() {
  return REVIEW_DELAYS.map((delay, index) => syntheticTask(delay, index));
}

function syntheticCallbacks(markFirstResult) {
  const execute = async () => {
    await sleep(EXECUTE_DELAY_MS);
    markFirstResult();
    return {ok: true, status: 'verified'};
  };
  return {
    validate: async ({packet, proposal}) => ({
      valid: true,
      errors: [],
      warnings: [],
      bindingSha256: `binding-${packet.candidate.uid}`,
      proposalSha256: canonicalJsonSha256(proposal),
      textSha256: typeof proposal?.text === 'string' ? hash(proposal.text) : null,
    }),
    accept: async ({validation}) => ({approved: true, bindingSha256: validation.bindingSha256}),
    claim: async () => true,
    execute,
  };
}

async function runNewPipeline() {
  const start = performance.now();
  let firstResultMs = null;
  const observedReviewDelays = [];
  const mark = () => { if (firstResultMs === null) firstResultMs = performance.now() - start; };
  const base = syntheticCallbacks(mark);
  const result = await runReviewPipeline({
    tasks: tasks(),
    concurrency: CONCURRENCY,
    review: async context => {
      const plannedMs = context.task.delay;
      const reviewStartedAt = performance.now();
      await sleep(plannedMs);
      observedReviewDelays.push({plannedMs, actualMs: performance.now() - reviewStartedAt});
      return {text: 'synthetic offline proposal'};
    },
    validate: base.validate,
    accept: base.accept,
    claim: base.claim,
    execute: base.execute,
  });
  if (result.executedCount !== REVIEW_DELAYS.length) throw new Error('synthetic pipeline did not execute every task');
  if (result.reviewConcurrencyMax !== CONCURRENCY) throw new Error('synthetic pipeline did not reach the requested concurrency');
  return {wallMs: performance.now() - start, firstResultMs, observedReviewDelays};
}

async function boundedReviews(tasksToReview, observedReviewDelays) {
  let cursor = 0;
  let active = 0;
  let maximum = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasksToReview.length) return;
      const task = tasksToReview[index];
      active += 1;
      maximum = Math.max(maximum, active);
      const reviewStartedAt = performance.now();
      await sleep(task.delay);
      observedReviewDelays.push({plannedMs: task.delay, actualMs: performance.now() - reviewStartedAt});
      active -= 1;
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  if (maximum !== CONCURRENCY) throw new Error('batch-barrier benchmark did not reach the requested concurrency');
}

async function runBatchBarrierPipeline() {
  const start = performance.now();
  let firstResultMs = null;
  const observedReviewDelays = [];
  const mark = () => { if (firstResultMs === null) firstResultMs = performance.now() - start; };
  const base = syntheticCallbacks(mark);
  const work = tasks();
  await boundedReviews(work, observedReviewDelays);
  for (const task of work) {
    const proposal = {text: 'synthetic offline proposal'};
    const validation = await base.validate({packet: task.packet, proposal});
    const acceptance = await base.accept({validation, proposal});
    if (approvalBinding(acceptance, validation) !== true) throw new Error('synthetic approval failed');
    if (await base.claim({task}) !== true) throw new Error('synthetic claim failed');
    await base.execute({task, validation, acceptance});
  }
  return {wallMs: performance.now() - start, firstResultMs, observedReviewDelays};
}

function approvalBinding(acceptance, validation) {
  return acceptance.approved === true && acceptance.bindingSha256 === validation.bindingSha256;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function rounded(value) { return Math.round(value * 100) / 100; }

function verifyReviewDelays(runs, label) {
  const expected = [...REVIEW_DELAYS].sort((left, right) => left - right);
  for (const run of runs) {
    const actual = run.observedReviewDelays.map(item => item.plannedMs).sort((left, right) => left - right);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} did not use the shared synthetic delay input`);
    for (const item of run.observedReviewDelays) {
      if (item.actualMs + 2 < item.plannedMs) {
        throw new Error(`${label} review delay was shorter than planned: ${item.actualMs.toFixed(2)}ms < ${item.plannedMs}ms`);
      }
    }
  }
}

async function main() {
  const newWarmup = await runNewPipeline();
  const oldWarmup = await runBatchBarrierPipeline();
  verifyReviewDelays([newWarmup], 'new pipeline warmup');
  verifyReviewDelays([oldWarmup], 'batch-barrier warmup');
  const newRuns = [];
  const oldRuns = [];
  for (let index = 0; index < RUNS; index += 1) {
    newRuns.push(await runNewPipeline());
    oldRuns.push(await runBatchBarrierPipeline());
  }
  verifyReviewDelays(newRuns, 'new pipeline');
  verifyReviewDelays(oldRuns, 'batch-barrier pipeline');
  const newWall = newRuns.map(run => run.wallMs);
  const oldWall = oldRuns.map(run => run.wallMs);
  const newFirst = newRuns.map(run => run.firstResultMs);
  const oldFirst = oldRuns.map(run => run.firstResultMs);
  console.log(JSON.stringify({
    model: 'synthetic-delay-only',
    note: 'Wall-clock comparison for pipeline coordination only; this is not a real BOSS send-speed measurement.',
    runs: RUNS,
    taskCount: REVIEW_DELAYS.length,
    concurrency: CONCURRENCY,
    executeDelayMs: EXECUTE_DELAY_MS,
    syntheticDelaysVerified: true,
    newPipeline: {
      wallMsMedian: rounded(median(newWall)),
      firstResultMsMedian: rounded(median(newFirst)),
    },
    batchBarrierPipeline: {
      wallMsMedian: rounded(median(oldWall)),
      firstResultMsMedian: rounded(median(oldFirst)),
    },
  }, null, 2));
}

await main();
