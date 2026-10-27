import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {runReviewPipeline as checkedPipeline} from './review_pipeline.mjs';
// Controller scheduling tests isolate the orchestration from filesystem receipts.
// Concrete default proof rejection and IO receipts have separate negative tests.
const runReviewPipeline = options => checkedPipeline(options, {
  verifyAcceptance: () => true,
  verifyClaim: claim => ({verified: claim === true}),
  verifyExecution: () => ({verified: true}),
  completeClaim: () => ({completed: true}),
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeTask({uid, version = 'v1', source = `source-${uid}-${version}`, delay = 0, execute} = {}) {
  const packet = {
    candidate: {uid, name: `Candidate ${uid}`, boss_job_id: 'job-fixture'},
    recordSha256: `${uid}`.padStart(64, '0'),
    jobProfileSha256: 'a'.repeat(64),
    history: {complete: true, messages: [], sha256: `${uid}`.padStart(64, 'b')},
    safety: {},
  };
  return {
    taskId: `${uid}-${version}`,
    uid,
    version,
    sourceFingerprint: source,
    packet,
    currentRecord: {candidate: {uid, name: `Candidate ${uid}`}, job: {boss_job_id: 'job-fixture'}},
    jobProfile: {boss_job_id: 'job-fixture'},
    delay,
    execute,
  };
}

function callbacks({onReview, onValidate, onAccept, onClaim, onExecute} = {}) {
  return {
    review: async task => {
      await onReview?.(task);
      await sleep(task.task?.delay ?? task.delay ?? 0);
      return task.task?.reviewedProposal ?? {candidate: task.packet.candidate, kind: 'policy', text: 'synthetic'};
    },
    validate: async args => {
      const supplied = await onValidate?.(args);
      return {
        valid: true,
        errors: [],
        warnings: [],
        bindingSha256: `binding-${args.packet.candidate.uid}`,
        ...supplied,
        proposalSha256: canonicalJsonSha256(args.proposal),
        textSha256: typeof args.proposal?.text === 'string' ? hash(args.proposal.text) : null,
      };
    },
    accept: async args => onAccept?.(args) ?? ({approved: true, bindingSha256: args.validation.bindingSha256}),
    claim: async args => onClaim?.(args) ?? true,
    execute: async args => {
      await onExecute?.(args);
      if (typeof args.task.execute === 'function') return args.task.execute();
      return {ok: true, status: 'verified'};
    },
  };
}

test('review callbacks are bounded while the main pipeline has one worker', async () => {
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({length: 8}, (_, index) => makeTask({uid: 100 + index, delay: 20}));
  const result = await runReviewPipeline({
    tasks,
    concurrency: 3,
    ...callbacks({
      onReview: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await sleep(2);
        active -= 1;
      },
    }),
  });
  assert.equal(result.reviewConcurrencyMax, 3);
  assert.equal(maximum, 3);
  assert.equal(result.mainConcurrencyMax, 1);
  assert.equal(result.executedCount, 8);
});

test('earlier review completion enters the serial main pipeline first', async () => {
  const executed = [];
  const tasks = [
    makeTask({uid: 201, source: 'late', delay: 70}),
    makeTask({uid: 202, source: 'early', delay: 5}),
    makeTask({uid: 203, source: 'middle', delay: 30}),
  ];
  await runReviewPipeline({
    tasks,
    concurrency: 4,
    ...callbacks({onExecute: async ({taskId}) => executed.push(taskId)}),
  });
  assert.deepEqual(executed, ['202-v1', '203-v1', '201-v1']);
});

test('different versions of the same job and UID never overlap review or operations', async () => {
  const timeline = [];
  let uidReviewActive = false;
  let uidOperationActive = false;
  const tasks = [
    makeTask({uid: 301, version: 'v1', source: 'source-v1', delay: 10}),
    makeTask({uid: 301, version: 'v2', source: 'source-v2', delay: 1}),
  ];
  const hooks = callbacks({
    onReview: async task => {
      assert.equal(uidOperationActive, false, 'review must not overlap the same UID operation');
      assert.equal(uidReviewActive, false, 'same UID reviews must be serial');
      uidReviewActive = true;
      timeline.push(`review-start:${task.version}`);
      await sleep(1);
      uidReviewActive = false;
      timeline.push(`review-end:${task.version}`);
    },
    onValidate: async ({task, phase}) => {
      assert.equal(uidReviewActive, false);
      if (phase === 'pre_accept') {
        uidOperationActive = true;
        timeline.push(`main-start:${task.version}`);
      }
      return {valid: true, errors: [], warnings: [], bindingSha256: `binding-${task.uid}`};
    },
    onExecute: async ({task}) => {
      await sleep(10);
      uidOperationActive = false;
      timeline.push(`main-end:${task.version}`);
    },
  });
  const result = await runReviewPipeline({tasks, concurrency: 4, ...hooks});
  assert.equal(result.executedCount, 2);
  assert.deepEqual(timeline, [
    'review-start:v1', 'review-end:v1', 'main-start:v1', 'main-end:v1',
    'review-start:v2', 'review-end:v2', 'main-start:v2', 'main-end:v2',
  ]);
});

test('validation, binding approval and exclusive claim gates all fail closed', async () => {
  const executeCalls = [];
  const tasks = [
    makeTask({uid: 401, source: 'invalid'}),
    makeTask({uid: 402, source: 'mismatch'}),
    makeTask({uid: 403, source: 'unclaimed'}),
  ];
  const hooks = callbacks({
    onValidate: async ({packet}) => packet.candidate.uid === 401
      ? {valid: false, errors: [{code: 'blocked'}], warnings: [], bindingSha256: null}
      : {valid: true, errors: [], warnings: [], bindingSha256: `binding-${packet.candidate.uid}`},
    onAccept: async ({validation}) => validation.bindingSha256 === 'binding-402'
      ? {approved: true, bindingSha256: 'wrong'}
      : {approved: true, bindingSha256: validation.bindingSha256},
    onClaim: async ({uid}) => uid !== 403,
    onExecute: async ({uid}) => executeCalls.push(uid),
  });
  const result = await runReviewPipeline({tasks, ...hooks});
  assert.deepEqual(executeCalls, []);
  assert.deepEqual(result.results.map(row => row.status), [
    'validation_rejected', 'acceptance_rejected', 'claim_rejected',
  ]);
});

test('duplicate source fingerprints dedupe and an unknown execution halts only that UID', async () => {
  const reviewed = [];
  const executed = [];
  const tasks = [
    makeTask({uid: 501, version: 'v1', source: 'same-source', delay: 1, execute: () => ({ok: false, status: 'unknown'})}),
    makeTask({uid: 501, version: 'v2', source: 'new-version', delay: 1}),
    makeTask({uid: 502, version: 'v1', source: 'duplicate-source', delay: 1}),
    makeTask({uid: 502, version: 'duplicate', source: 'duplicate-source', delay: 1}),
    makeTask({uid: 503, version: 'v1', source: 'independent', delay: 2}),
  ];
  const hooks = callbacks({
    onReview: async ({taskId}) => reviewed.push(taskId),
    onExecute: async ({taskId}) => executed.push(taskId),
  });
  const result = await runReviewPipeline({tasks, concurrency: 2, ...hooks});
  assert.deepEqual(reviewed.sort(), ['501-v1', '502-v1', '503-v1']);
  assert.ok(executed.includes('503-v1'), 'other UID continues after an unknown result');
  assert.equal(executed.filter(id => id.startsWith('501-')).length, 1);
  assert.equal(result.results[1].status, 'halted');
  assert.equal(result.results[1].reason, 'execute_unknown');
  assert.equal(result.results[3].status, 'duplicate');
});
test('execution success requires an explicit verified success result and unknown outcomes halt', async () => {
  const tasks = [
    makeTask({uid: 601, source: 'missing', execute: () => undefined}),
    makeTask({uid: 602, source: 'empty', execute: () => ({})}),
    makeTask({uid: 603, source: 'outcome-unknown', execute: () => ({ok: true, outcomeUnknown: true})}),
    makeTask({uid: 604, source: 'sdk-false', execute: () => ({ok: true, status: 'verified', sdkReturned: false})}),
  ];
  const result = await runReviewPipeline({tasks, concurrency: 4, ...callbacks()});
  assert.equal(result.executedCount, 0);
  assert.deepEqual(result.results.map(row => row.status), [
    'execute_result_missing',
    'execute_unverified',
    'execute_unknown',
    'execute_sdk_not_returned',
  ]);
});

test('CAS is revalidated after acceptance and before claim', async () => {
  const task = makeTask({uid: 611, source: 'rebind'});
  task.currentRecord = {revision: 'cached'};
  const phases = [];
  let claimCalls = 0;
  let executeCalls = 0;
  const hooks = callbacks({
    onValidate: async ({task: liveTask, phase}) => {
      phases.push(`${phase}:${liveTask.currentRecord.revision}`);
      if (phase === 'pre_accept') {
        liveTask.currentRecord = {revision: 'pre'};
        return {valid: true, errors: [], warnings: [], bindingSha256: 'binding-611'};
      }
      return {valid: true, errors: [], warnings: [], bindingSha256: `binding-611-${liveTask.currentRecord.revision}`};
    },
    onAccept: async ({task: liveTask, validation}) => {
      liveTask.currentRecord = {revision: 'post'};
      return {approved: true, bindingSha256: validation.bindingSha256};
    },
    onClaim: async () => { claimCalls += 1; return true; },
    onExecute: async () => { executeCalls += 1; },
  });
  const result = await runReviewPipeline({tasks: [task], ...hooks});
  assert.deepEqual(phases, ['pre_accept:cached', 'post_accept:post']);
  assert.equal(result.results[0].status, 'rebind_rejected');
  assert.equal(claimCalls, 0);
  assert.equal(executeCalls, 0);
});

test('accept cannot mutate the validated proposal snapshot', async () => {
  const original = {text: 'original reviewed text'};
  const task = makeTask({uid: 612, source: 'frozen-proposal'});
  task.reviewedProposal = original;
  let claimCalls = 0;
  let executeCalls = 0;
  const hooks = callbacks({
    onAccept: async ({proposal}) => {
      proposal.text = 'mutated after hash';
      return {approved: true, bindingSha256: 'binding-612'};
    },
    onClaim: async () => { claimCalls += 1; return true; },
    onExecute: async () => { executeCalls += 1; },
  });
  const result = await runReviewPipeline({tasks: [task], ...hooks});
  assert.equal(result.results[0].status, 'accept_error');
  assert.equal(original.text, 'original reviewed text');
  assert.equal(claimCalls, 0);
  assert.equal(executeCalls, 0);
});
test('offline reviewer cannot mutate the authoritative packet, record or job input', async () => {
  const task = makeTask({uid: 700, source: 'isolated-review'});
  task.currentRecord = {revision: 'original'};
  const hooks = callbacks({onReview: async context => {context.task.currentRecord.revision = 'tampered'; return {text: 'changed'};}});
  const result = await runReviewPipeline({tasks: [task], ...hooks});
  assert.equal(result.executedCount, 0);
  assert.equal(result.results[0].status, 'review_error');
  assert.equal(task.currentRecord.revision, 'original');
});
test('production defaults reject a bare main approval before any claim or execution', async () => {
  let executed = false;
  const task = makeTask({uid: 701, source: 'no-proof'});
  const hooks = callbacks({onExecute: async () => {executed = true; return {ok: true, status: 'verified'};}});
  const result = await checkedPipeline({tasks: [task], ...hooks});
  assert.equal(result.executedCount, 0);
  assert.equal(result.results[0].status, 'acceptance_rejected');
  assert.equal(executed, false);
});
