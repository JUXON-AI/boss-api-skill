import {hash} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {verifyPipelineAcceptance} from './pipeline_approval.mjs';
import {verifyPipelineClaim, verifyPipelineExecution, completePipelineClaim} from './pipeline_receipts.mjs';


function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function cloneJson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('proposal must be JSON serializable');
  return JSON.parse(text);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function proposalFingerprint(proposal) {
  return {
    proposalSha256: canonicalJsonSha256(proposal),
    textSha256: typeof proposal?.text === 'string' ? hash(proposal.text) : null,
  };
}
function validationFingerprintMatches(validation, fingerprint) {
  return isObject(validation)
    && validation.proposalSha256 === fingerprint.proposalSha256
    && validation.textSha256 === fingerprint.textSha256;
}
function safeMessage(error) { return error instanceof Error ? error.message : String(error); }
function sourceKey(value) { return `${typeof value}:${String(value)}`; }

function normalizeTask(raw, index) {
  const packet = isObject(raw?.packet) ? raw.packet : (isObject(raw?.candidate) ? raw : null);
  const candidate = isObject(packet?.candidate) ? packet.candidate : null;
  if (!packet || !candidate || !Number.isSafeInteger(candidate.uid) || candidate.uid < 1
    || typeof candidate.name !== 'string' || !candidate.name.trim()
    || typeof candidate.boss_job_id !== 'string' || !candidate.boss_job_id) {
    return {error: 'task must contain one packet with a valid candidate identity', index};
  }
  const sourceFingerprint = raw?.sourceFingerprint ?? raw?.source_fingerprint ?? packet?.history?.sha256;
  if (typeof sourceFingerprint !== 'string' || !sourceFingerprint) {
    return {error: 'task.sourceFingerprint is required (packet.history.sha256 may supply it)', index};
  }
  return {
    index,
    raw,
    packet,
    candidate,
    currentRecord: raw?.currentRecord ?? raw?.record,
    jobProfile: raw?.jobProfile,
    taskId: raw?.taskId ?? raw?.id ?? `${candidate.boss_job_id}:${candidate.uid}:${index}`,
    version: raw?.version ?? packet?.recordSha256 ?? null,
    sourceFingerprint,
    bossJobId: candidate.boss_job_id,
    uid: candidate.uid,
  };
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    uid: task.uid,
    bossJobId: task.bossJobId,
    version: task.version,
    sourceFingerprint: task.sourceFingerprint,
  };
}

function executionFailure(result) {
  if (!isObject(result)) return 'execute_result_missing';
  if (result.unknown === true || result.outcomeUnknown === true) return 'execute_unknown';
  if (result.doNotRetryAutomatically === true) return 'execute_do_not_retry';
  if (result.sdkReturned === false) return 'execute_sdk_not_returned';
  if (result.ok === false) {
    if (result.status === 'unknown') return 'execute_unknown';
    return typeof result.status === 'string' ? `execute_${result.status}` : 'execute_failed';
  }
  if (result.ok !== true) return 'execute_unverified';
  if (['unknown', 'failed', 'error', 'blocked'].includes(result.status)) return `execute_${result.status}`;
  return null;
}

/**
 * Runs bounded offline reviews, then one serial main-agent pipeline.
 * Every task is {taskId, version, sourceFingerprint, packet, currentRecord, jobProfile}.
 * Callbacks are supplied by the caller; this module never performs network or service I/O.
 */
export function runReviewPipeline({
  tasks,
  review,
  validate,
  accept,
  execute,
  claim,
  concurrency = 4,
  onEvent = () => {},
} = {}, testDependencies = {}) {
  const checkAcceptance = testDependencies.verifyAcceptance ?? verifyPipelineAcceptance;
  const checkClaim = testDependencies.verifyClaim ?? verifyPipelineClaim;
  const checkExecution = testDependencies.verifyExecution ?? verifyPipelineExecution;
  const finishClaim = testDependencies.completeClaim ?? completePipelineClaim;
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  for (const [name, callback] of Object.entries({review, validate, accept, execute, claim})) {
    if (typeof callback !== 'function') throw new TypeError(`${name} callback is required`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RangeError('concurrency must be an integer from 1 to 64');
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');

  let reviewSlots = concurrency;
  const reviewWaiters = [];
  let reviewActive = 0;
  let reviewConcurrencyMax = 0;
  let mainActive = 0;
  let mainConcurrencyMax = 0;
  let mainTail = Promise.resolve();
  const results = new Array(tasks.length);
  const groups = new Map();
  const dedupe = new Set();

  async function emit(type, task, extra = {}) {
    const event = {type, ...(task ? publicTask(task) : {}), at: Date.now(), ...extra};
    try { await onEvent(event); } catch { /* Observability must not affect safety. */ }
  }

  async function acquireReviewSlot() {
    if (reviewSlots > 0) {
      reviewSlots -= 1;
      return;
    }
    await new Promise(resolve => reviewWaiters.push(resolve));
  }

  function releaseReviewSlot() {
    const next = reviewWaiters.shift();
    if (next) next();
    else reviewSlots += 1;
  }

  function enqueueMain(callback) {
    const run = mainTail.then(callback);
    mainTail = run.catch(() => undefined);
    return run;
  }

  const normalized = tasks.map(normalizeTask);
  for (const task of normalized) {
    if (task.error) {
      results[task.index] = {status: 'invalid_task', taskIndex: task.index, error: task.error};
      void emit('task_rejected', null, {taskIndex: task.index, reason: task.error});
      continue;
    }
    const duplicateKey = `${task.bossJobId}\u0000${task.uid}\u0000${sourceKey(task.sourceFingerprint)}`;
    if (dedupe.has(duplicateKey)) {
      results[task.index] = {
        status: 'duplicate', taskIndex: task.index, taskId: task.taskId,
        uid: task.uid, bossJobId: task.bossJobId, version: task.version,
        sourceFingerprint: task.sourceFingerprint,
      };
      void emit('task_duplicate', task);
      continue;
    }
    dedupe.add(duplicateKey);
    const groupKey = `${task.bossJobId}\u0000${task.uid}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(task);
  }

async function invokeValidate(task, proposal, phase, previousValidation = null) {
    const liveTask = task.raw;
    const packet = liveTask?.packet ?? task.packet;
    const currentRecord = liveTask?.currentRecord ?? task.currentRecord;
    const jobProfile = liveTask?.jobProfile ?? task.jobProfile;
    let validation = await validate({
      packet,
      proposal,
      currentRecord,
      jobProfile,
      jobProfileBytes: liveTask?.jobProfileBytes,
      jobProfileHashMode: liveTask?.jobProfileHashMode,
      task: liveTask,
      phase,
      previousValidation,
      cachedCurrentRecord: task.currentRecord,
    });
    if (isObject(validation?.currentRecord)) {
      liveTask.currentRecord = validation.currentRecord;
      task.currentRecord = validation.currentRecord;
    }
    if (isObject(validation?.jobProfile)) {
      liveTask.jobProfile = validation.jobProfile;
      task.jobProfile = validation.jobProfile;
    }
    if (isObject(validation) && !Object.isFrozen(validation)) Object.freeze(validation);
    return validation;
  }

  async function runMain(task, proposal) {
    return enqueueMain(async () => {
      mainActive += 1;
      mainConcurrencyMax = Math.max(mainConcurrencyMax, mainActive);
      let snapshot;
      let fingerprint;
      try {
        snapshot = deepFreeze(cloneJson(proposal));
        fingerprint = proposalFingerprint(snapshot);
        await emit('validate_start', task, {phase: 'pre_accept'});
        let validation;
        try {
          validation = await invokeValidate(task, snapshot, 'pre_accept');
        } catch (error) {
          return {ok: false, status: 'validate_error', haltUid: true, error: safeMessage(error)};
        }
        if (!isObject(validation) || validation.valid !== true
          || typeof validation.bindingSha256 !== 'string' || !validation.bindingSha256
          || !validationFingerprintMatches(validation, fingerprint)) {
          return {ok: false, status: 'validation_rejected', haltUid: true, validation};
        }
        const bindingSha256 = validation.bindingSha256;
        const proposalSha256 = fingerprint.proposalSha256;
        const textSha256 = fingerprint.textSha256;
        await emit('validate_complete', task, {
          phase: 'pre_accept',
          valid: true,
          bindingSha256,
          proposalSha256,
          warningCount: Array.isArray(validation.warnings) ? validation.warnings.length : 0,
        });

        await emit('accept_start', task, {bindingSha256});
        let approval;
        try {
          approval = await accept({
            task: task.raw,
            taskId: task.taskId,
            uid: task.uid,
            bossJobId: task.bossJobId,
            version: task.version,
            sourceFingerprint: task.sourceFingerprint,
            packet: task.raw?.packet ?? task.packet,
            proposal: snapshot,
            validation,
          });
          approval = deepFreeze(cloneJson(approval));
        } catch (error) {
          return {ok: false, status: 'accept_error', haltUid: true, error: safeMessage(error)};
        }
        if (!isObject(approval) || approval.approved !== true || approval.bindingSha256 !== bindingSha256 ||
            checkAcceptance(approval, {packet: task.raw?.packet ?? task.packet, proposal: snapshot, validation}) !== true) {
          return {ok: false, status: 'acceptance_rejected', haltUid: true, approval, validation};
        }
        await emit('accept_complete', task, {approved: true, bindingSha256});

        await emit('rebind_start', task);
        let reboundValidation;
        try {
          reboundValidation = await invokeValidate(task, snapshot, 'post_accept', validation);
        } catch (error) {
          return {ok: false, status: 'rebind_error', haltUid: true, error: safeMessage(error)};
        }
        const reboundFingerprint = proposalFingerprint(snapshot);
        if (!isObject(reboundValidation) || reboundValidation.valid !== true
          || reboundValidation.bindingSha256 !== bindingSha256
          || !validationFingerprintMatches(reboundValidation, fingerprint)
          || reboundFingerprint.proposalSha256 !== proposalSha256
          || reboundFingerprint.textSha256 !== textSha256) {
          return {ok: false, status: 'rebind_rejected', haltUid: true, validation: reboundValidation};
        }
        await emit('rebind_complete', task, {bindingSha256});

        let claimed;
        try {
          claimed = await claim({
            task: task.raw,
            taskId: task.taskId,
            uid: task.uid,
            bossJobId: task.bossJobId,
            version: task.version,
            sourceFingerprint: task.sourceFingerprint,
            packet: task.raw?.packet ?? task.packet,
            currentRecord: task.raw?.currentRecord ?? task.currentRecord,
            jobProfile: task.raw?.jobProfile ?? task.jobProfile,
            proposal: snapshot,
            validation: reboundValidation,
            acceptance: approval,
          });
          claimed = deepFreeze(cloneJson(claimed));
        } catch (error) {
          return {ok: false, status: 'claim_error', haltUid: true, error: safeMessage(error)};
        }
        const claimEvidence = checkClaim(claimed, {taskId: task.taskId, jobId: task.bossJobId, uid: task.uid,
          sourceFingerprint: task.sourceFingerprint, recordSha256: (task.raw?.packet ?? task.packet).recordSha256,
          bindingSha256});
        if (claimEvidence?.verified !== true) {
          return {ok: false, status: 'claim_rejected', haltUid: true};
        }
        await emit('claim_complete', task, {claimed: true});

        await emit('execute_start', task);
        let execution;
        try {
          execution = await execute({
            task: task.raw,
            taskId: task.taskId,
            uid: task.uid,
            bossJobId: task.bossJobId,
            version: task.version,
            sourceFingerprint: task.sourceFingerprint,
            packet: task.raw?.packet ?? task.packet,
            currentRecord: task.raw?.currentRecord ?? task.currentRecord,
            jobProfile: task.raw?.jobProfile ?? task.jobProfile,
            proposal: snapshot,
            validation: reboundValidation,
            acceptance: approval,
            claim: claimed,
          });
        } catch (error) {
          return {ok: false, status: 'execute_error', haltUid: true, error: safeMessage(error)};
        }
        const failure = executionFailure(execution);
        if (failure) {
          return {ok: false, status: failure, haltUid: true, execution};
        }
        const proof = checkExecution(execution, {packet: task.raw?.packet ?? task.packet, proposal: snapshot, claim: claimed});
        if (proof?.verified !== true) return {ok: false, status: 'execution_evidence_rejected', haltUid: true, proof};
        try {
          const completion = await finishClaim(claimed);
          if (completion?.completed !== true) return {ok: false, status: 'executed_but_claim_finalize_failed', haltUid: true, completion};
        }
        catch (error) { return {ok: false, status: 'executed_but_claim_finalize_failed', haltUid: true, error: safeMessage(error)}; }
        await emit('execute_complete', task);
        return {ok: true, status: 'executed', execution};
      } catch (error) {
        return {ok: false, status: 'proposal_invalid', haltUid: true, error: safeMessage(error)};
      } finally {
        mainActive -= 1;
      }
    });
  }
  async function processGroup(group) {
    let haltReason = null;
    for (const task of group) {
      if (haltReason) {
        results[task.index] = {
          status: 'halted', taskIndex: task.index, taskId: task.taskId,
          uid: task.uid, bossJobId: task.bossJobId, version: task.version,
          sourceFingerprint: task.sourceFingerprint, reason: haltReason,
        };
        await emit('task_halted', task, {reason: haltReason});
        continue;
      }

      await acquireReviewSlot();
      reviewActive += 1;
      reviewConcurrencyMax = Math.max(reviewConcurrencyMax, reviewActive);
      await emit('review_start', task, {active: reviewActive});
      let reviewed;
      try {
        reviewed = await review(deepFreeze(cloneJson({
          task: task.raw,
          taskId: task.taskId,
          uid: task.uid,
          bossJobId: task.bossJobId,
          version: task.version,
          sourceFingerprint: task.sourceFingerprint,
          packet: task.packet,
          currentRecord: task.currentRecord,
          jobProfile: task.jobProfile,
        })));
      } catch (error) {
        results[task.index] = {
          status: 'review_error', taskIndex: task.index, taskId: task.taskId,
          uid: task.uid, bossJobId: task.bossJobId, version: task.version,
          sourceFingerprint: task.sourceFingerprint, error: safeMessage(error),
        };
        haltReason = 'review_error';
        await emit('review_error', task, {error: safeMessage(error)});
        continue;
      } finally {
        reviewActive -= 1;
        releaseReviewSlot();
      }
      await emit('review_complete', task);
      const proposal = isObject(reviewed) && Object.hasOwn(reviewed, 'proposal') ? reviewed.proposal : reviewed;
      const outcome = await runMain(task, proposal);
      results[task.index] = {
        taskIndex: task.index,
        taskId: task.taskId,
        uid: task.uid,
        bossJobId: task.bossJobId,
        version: task.version,
        sourceFingerprint: task.sourceFingerprint,
        ...outcome,
      };
      if (!outcome.ok) {
        haltReason = outcome.status;
        await emit('task_halted', task, {reason: haltReason});
      } else {
        await emit('task_complete', task);
      }
    }
  }

  return Promise.all([...groups.values()].map(processGroup)).then(() => ({
    results,
    reviewConcurrencyMax,
    mainConcurrencyMax,
    executedCount: results.filter(result => result?.status === 'executed').length,
    haltedCount: results.filter(result => ['halted'].includes(result?.status)).length,
  }));
}
