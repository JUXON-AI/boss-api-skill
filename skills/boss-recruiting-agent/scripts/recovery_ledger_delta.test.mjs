import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {SCORING_POLICY_VERSION, scoreInternship} from '../../../scripts/scoring.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {verifyRecoveryDelta} from './recovery_ledger_delta.mjs';

const JOB_ID = 'synthetic-job';
const JOB_SHA = 'a'.repeat(64);
const HISTORY_SHA = 'b'.repeat(64);
const EVALUATION_SHA = 'c'.repeat(64);
const RECRUITER_UID = 900;
const DIMENSIONS = Object.freeze({
  core_role_skills: 40,
  project_depth: 40,
  engineering_habits: 40,
  learning_and_collaboration: 40,
});
const QUOTES = Object.freeze({
  core_role_skills: {mid: 101, text: '我负责过 Node.js 接口和后端数据流程。'},
  project_depth: {mid: 102, text: '我独立完成过日志检索服务的开发和上线。'},
  engineering_habits: {mid: 103, text: '提交前我会补测试，并检查异常和边界情况。'},
  learning_and_collaboration: {mid: 104, text: '我和同学一起做项目，也会按评审意见修改。'},
});

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeRecord({
  uid = 101,
  name = '合成候选人',
  dimensions = DIMENSIONS,
  round = 0,
  nextRound = 1,
  state = 'ready_for_contact',
  recommendation = 'continue_contact',
  lastOutboundMid = null,
  lastMid = 90,
  lastDirection = 'out',
  pendingInboundMids = [],
} = {}) {
  const score = scoreInternship(dimensions, {competitions: [], githubProjects: []});
  return {
    schema_version: 1,
    policy_version: SCORING_POLICY_VERSION,
    job: {boss_job_id: JOB_ID, job_profile_sha256: JOB_SHA},
    candidate: {uid, name},
    history: {
      sha256: HISTORY_SHA,
      complete: true,
      checked_at: '2026-10-26T01:00:00.000Z',
      last_mid: lastMid,
      last_direction: lastDirection,
    },
    job_fit: {score: 80, hard_condition_status: 'pass'},
    score: {
      dimensions: {...dimensions},
      ability_base_score: score.abilityBaseScore,
      evidence_coverage_percent: score.evidenceCoveragePercent,
      competitions: [],
      github_projects: [],
      competition_bonus: score.competitionBonus,
      github_bonus: score.githubBonus,
      proof_bonus: score.proofBonus,
      final_signal_score: score.finalSignalScore,
      evaluation_sha256: EVALUATION_SHA,
    },
    state,
    facts: {confirmed: ['合成身份'], unverified: [], unknown: []},
    communication: {
      round,
      last_outbound_mid: lastOutboundMid,
      last_outbound_at: lastOutboundMid === null ? null : '2026-10-26T01:00:00.000Z',
      pending_inbound_mids: pendingInboundMids,
    },
    recommendation,
    next_round: nextRound,
    next_action: '仅用于离线合成测试',
    sources: ['synthetic-fixture'],
    updated_at: '2026-10-26T01:01:00.000Z',
  };
}

function receiptFor(record) {
  return {ok: true, recordSha256: canonicalJsonSha256(record)};
}

function historyMessages(uid = 101) {
  return Object.values(QUOTES).map(({mid, text}) => ({
    mid,
    from: {uid},
    to: {uid: RECRUITER_UID},
    body: {text},
  }));
}

function reviewFor(dimensions, newTextMids = [101, 102, 103, 104], rewrite = null) {
  const dimensionEvidence = Object.entries(dimensions)
    .filter(([, score]) => score !== null)
    .map(([dimension, score]) => {
      const quote = rewrite?.(dimension, QUOTES[dimension]) ?? QUOTES[dimension];
      return {dimension, score, mid: quote.mid, quote: quote.text};
    });
  return {dimensions: {...dimensions}, dimensionEvidence, newTextMids};
}

function scoreChangeFixture() {
  const beforeRecord = makeRecord();
  const changedDimensions = {...DIMENSIONS, core_role_skills: 70};
  const afterRecord = makeRecord({
    dimensions: changedDimensions,
    state: 'needs_more_info',
    recommendation: 'hold',
    nextRound: 0,
  });
  const review = reviewFor(changedDimensions);
  return {
    jobId: JOB_ID,
    recruiterUid: RECRUITER_UID,
    allowedCandidates: [{uid: 101, name: '合成候选人', jobId: JOB_ID}],
    beforeRecord,
    afterRecord,
    review,
    historyMessages: historyMessages(),
    newTextMids: review.newTextMids,
    receipt: receiptFor(afterRecord),
    sendEvidence: null,
  };
}

function sendFixture(plannedRound = 1, dimensions = plannedRound === 1 ? DIMENSIONS : {
  core_role_skills: 70,
  project_depth: 70,
  engineering_habits: 70,
  learning_and_collaboration: 70,
}) {
  const beforeRound = plannedRound - 1;
  const beforeRecord = makeRecord({
    dimensions,
    round: beforeRound,
    nextRound: plannedRound,
    lastOutboundMid: beforeRound === 0 ? null : 90,
    lastMid: beforeRound === 0 ? 100 : 90,
    lastDirection: beforeRound === 0 ? 'in' : 'out',
    pendingInboundMids: beforeRound === 0 ? [100] : [],
  });
  const preRecord = structuredClone(beforeRecord);
  const text = `合成第${plannedRound}轮跟进正文`;
  const outboundMid = 500 + plannedRound;
  const afterRecord = makeRecord({
    dimensions,
    round: plannedRound,
    nextRound: 0,
    state: 'awaiting_candidate_reply',
    recommendation: 'continue_contact',
    lastOutboundMid: outboundMid,
    lastMid: outboundMid,
    lastDirection: 'out',
    pendingInboundMids: [],
  });
  const beforeMessages = [
    {mid: 90, from: {uid: RECRUITER_UID}, to: {uid: 101}, body: {text: '你好'}},
    {mid: 100, from: {uid: 101}, to: {uid: RECRUITER_UID}, body: {text: '补充一个真实回答'}},
  ];
  const afterMessages = [
    ...beforeMessages,
    {mid: outboundMid, from: {uid: RECRUITER_UID}, to: {uid: 101}, body: {text}},
  ];
  const approval = {
    recipient: {uid: 101, name: '合成候选人'},
    text,
    textSha256: digest(text),
    approved: true,
    approval: {
      userMessage: '离线合成审批',
      approvedTextSha256: digest(text),
      recipientCount: 1,
    },
    expectedHistorySha256: 'd'.repeat(64),
  };
  const attempt = {
    status: 'reserved_before_invocation',
    recipient: {uid: 101, name: '合成候选人'},
    textSha256: digest(text),
    attempts: 1,
  };
  const result = {
    recipient: {uid: 101, name: '合成候选人'},
    attempts: 1,
    textSha256: digest(text),
    sdkInvoked: true,
    historyConfirmed: true,
    messageMid: outboundMid,
    matchingNewRecords: 1,
  };
  return {
    jobId: JOB_ID,
    recruiterUid: RECRUITER_UID,
    allowedCandidates: [{uid: 101, name: '合成候选人', jobId: JOB_ID}],
    beforeRecord,
    afterRecord,
    review: {dimensions: {...dimensions}, dimensionEvidence: [], newTextMids: [100]},
    historyMessages: historyMessages(),
    newTextMids: [100],
    receipt: receiptFor(afterRecord),
    sendEvidence: {
      approval,
      attempt,
      result,
      beforeMessages,
      afterMessages,
      preRecord,
      preReceipt: receiptFor(preRecord),
    },
  };
}

test('accepts a reviewed score change as a no-send hold without mutating input', () => {
  const input = scoreChangeFixture();
  const beforeCall = structuredClone(input);
  assert.deepEqual(verifyRecoveryDelta(input), {
    accepted: true,
    uid: 101,
    scoreChanged: true,
    sdkCalls: 0,
  });
  assert.deepEqual(input, beforeCall);
});

test('accepts a valid round 1 send and returns one SDK call', () => {
  assert.deepEqual(verifyRecoveryDelta(sendFixture(1)), {
    accepted: true,
    uid: 101,
    scoreChanged: false,
    sdkCalls: 1,
  });
});

test('accepts a valid round 2 send at the hard 60/70/65 floor', () => {
  const dimensions = {
    core_role_skills: 65,
    project_depth: 65,
    engineering_habits: 65,
    learning_and_collaboration: 65,
  };
  assert.deepEqual(verifyRecoveryDelta(sendFixture(2, dimensions)), {
    accepted: true,
    uid: 101,
    scoreChanged: false,
    sdkCalls: 1,
  });
});

test('rejects identity changes outside the exact UID/name/job whitelist', () => {
  const input = scoreChangeFixture();
  input.afterRecord.candidate.uid = 102;
  input.receipt = receiptFor(input.afterRecord);
  assert.throws(() => verifyRecoveryDelta(input), /UID changed|whitelist/i);
});

test('rejects a different approval recipient', () => {
  const input = sendFixture(1);
  input.sendEvidence.approval.recipient.uid = 999;
  assert.throws(() => verifyRecoveryDelta(input), /approval recipient/i);
});

test('rejects a stale canonical receipt hash', () => {
  const input = scoreChangeFixture();
  input.receipt = receiptFor(input.beforeRecord);
  assert.throws(() => verifyRecoveryDelta(input), /canonical record hash/i);
});

test('rejects attempts to reset or skip beyond the communication round limit', () => {
  const input = sendFixture(2);
  input.beforeRecord.communication.round = 2;
  input.sendEvidence.preRecord.communication.round = 2;
  input.sendEvidence.preRecord.next_round = 0;
  input.sendEvidence.preReceipt = receiptFor(input.sendEvidence.preRecord);
  input.afterRecord.communication.round = 2;
  input.receipt = receiptFor(input.afterRecord);
  assert.throws(() => verifyRecoveryDelta(input), /planned round|communication\.round|next_round/i);
});

test('rejects a score increase backed by a quote that is not exact new candidate text', () => {
  const input = scoreChangeFixture();
  input.review = reviewFor(input.afterRecord.score.dimensions, [101, 102, 103, 104], (dimension, quote) => (
    dimension === 'core_role_skills' ? {mid: quote.mid, text: '伪造的高分原话'} : quote
  ));
  assert.throws(() => verifyRecoveryDelta(input), /exact body\.text/i);
});

test('rejects a claimed send when history has no new matching outbound record', () => {
  const input = sendFixture(1);
  input.sendEvidence.afterMessages = structuredClone(input.sendEvidence.beforeMessages);
  assert.throws(() => verifyRecoveryDelta(input), /exactly one new matching outbound/i);
});

test('rejects extra new outbound records', () => {
  const input = sendFixture(1);
  input.sendEvidence.afterMessages.push({
    mid: 777,
    from: {uid: RECRUITER_UID},
    to: {uid: 101},
    body: {text: '另一条未经单独核验的消息'},
  });
  assert.throws(() => verifyRecoveryDelta(input), /no other new outbound/i);
});

test('rejects a forged outbound from a third party', () => {
  const input = sendFixture(1);
  input.sendEvidence.afterMessages.at(-1).from.uid = 888;
  assert.throws(() => verifyRecoveryDelta(input), /third-party participant/i);
});

test('accepts newly received exact own-document evidence and rejects a changed text digest', () => {
  const input = scoreChangeFixture();
  const text = '本人新收到的完整技术自述';
  const doc = {uid:101,name:'合成候选人',jobId:JOB_ID,textSource:'synthetic-own-document.txt',textSha256:digest(text),fileSha256:'d'.repeat(64),accepted:true,newlyReceived:true,text};
  input.documentEvidence=[doc];
  input.review.dimensionEvidence=input.review.dimensionEvidence.map(e=>({...e,mid:null,quote:text,sourceType:'document',sourcePath:doc.textSource,sourceSha256:doc.textSha256}));
  assert.equal(verifyRecoveryDelta(input).accepted,true);
  doc.text+='tampered';
  assert.throws(()=>verifyRecoveryDelta(input),/document evidence/);
});

test('rejects a no-send record that plans another round', () => {
  const input = scoreChangeFixture();
  input.afterRecord.next_round = 1;
  input.receipt = receiptFor(input.afterRecord);
  assert.throws(() => verifyRecoveryDelta(input), /next_round must be 0/i);
});

test('rejects a round 2 send below the existing hard score gates', () => {
  const dimensions = {
    core_role_skills: 60,
    project_depth: 60,
    engineering_habits: 60,
    learning_and_collaboration: 60,
  };
  const input = sendFixture(2, dimensions);
  // The ledger remains deterministic and legal at 60/100/60, but R2 must still fail its 65 signal floor.
  assert.throws(() => verifyRecoveryDelta(input), /round 2 requires final signal score at least 65/i);
});



