import test from 'node:test';
import assert from 'node:assert/strict';
import {SCORING_POLICY_VERSION, scoreInternship} from '../../../scripts/scoring.mjs';
import {hash, historyFingerprint} from '../../../scripts/runtime.mjs';
import {canonicalJsonSha256} from './candidate_ledger.mjs';
import {validateProposal} from './proposal_validation.mjs';

const JOB_ID = 'job-1';
const UID = 101;
const jobProfile = {
  job_name: 'Backend intern',
  boss_job_id: JOB_ID,
  employment_type: 'internship',
  message_policy: {max_substantive_rounds: 2},
};
const messages = [
  {mid: 1, time: 1, from: {uid: UID}, to: {uid: 900}, securityId: 'rotate-1', body: {text: '我做过 Python 后端服务'}},
  {mid: 2, time: 2, from: {uid: 900}, to: {uid: UID}, securityId: 'rotate-2', body: {text: '每周可以实习几天？'}},
  {mid: 3, time: 3, from: {uid: UID}, to: {uid: 900}, securityId: 'rotate-3', body: {text: '可以每周实习四天，日薪两百没问题'}},
];
const historySha256 = historyFingerprint(messages);
const jobProfileSha256 = canonicalJsonSha256(jobProfile);
const evaluationSha256 = 'c'.repeat(64);

function record(overrides = {}) {
  const base = {
    schema_version: 1,
    policy_version: SCORING_POLICY_VERSION,
    job: {boss_job_id: JOB_ID, job_profile_sha256: jobProfileSha256},
    candidate: {uid: UID, name: 'Candidate A'},
    history: {
      sha256: historySha256,
      complete: true,
      checked_at: '2026-10-24T03:00:00.000Z',
      last_mid: 3,
      last_direction: 'in',
    },
    job_fit: {score: 85, hard_condition_status: 'pass'},
    score: {
      dimensions: {core_role_skills: 80, project_depth: 80, engineering_habits: 80, learning_and_collaboration: 80},
      ability_base_score: 80,
      evidence_coverage_percent: 100,
      competitions: [],
      github_projects: [],
      competition_bonus: 0,
      github_bonus: 0,
      proof_bonus: 0,
      final_signal_score: 80,
      evaluation_sha256: evaluationSha256,
    },
    state: 'awaiting_candidate_reply',
    facts: {confirmed: ['Identity matched'], unverified: [], unknown: []},
    communication: {
      round: 1,
      last_outbound_mid: 2,
      last_outbound_at: '2026-10-24T02:00:00.000Z',
      pending_inbound_mids: [3],
    },
    recommendation: 'continue_contact',
    next_round: 2,
    next_action: 'Ask only missing round-two conditions',
    sources: ['synthetic-history'],
    updated_at: '2026-10-24T03:01:00.000Z',
  };
  return {...base, ...overrides};
}

function packet(overrides = {}) {
  const currentRecord = record();
  return {
    candidate: {uid: UID, name: 'Candidate A', boss_job_id: JOB_ID},
    recordSha256: canonicalJsonSha256(currentRecord),
    jobProfileSha256,
    history: {complete: true, messages, sha256: historySha256},
    safety: {
      blocked: false,
      humanConversationHold: false,
      alreadyHandled: false,
      baseReadbackVerified: false,
      bossHandoffSent: false,
    },
    ...overrides,
  };
}

function proposal(overrides = {}, nextOverrides = {}) {
  const currentRecord = record();
  const nextRecord = record({
    communication: currentRecord.communication,
    state: 'ready_for_contact',
    next_round: 2,
    ...nextOverrides,
  });
  return {
    candidate: {uid: UID, name: 'Candidate A', boss_job_id: JOB_ID},
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    jobProfileSha256,
    expectedHistorySha256: historySha256,
    kind: 'substantive_round2',
    text: '方便再确认每周四天和日薪吗？另外请补充最快到岗时间。',
    nextRecord,
    citations: [{mid: 3, quote: '每周实习四天'}],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {packet: packet(), proposal: proposal(), currentRecord: record(), jobProfile, jobProfileHashMode: 'canonical', ...overrides};
}

function codes(result) { return result.errors.map(error => error.code); }

test('no-send stop accepts a reviewed hard conflict with the latest candidate citation and unchanged ability', () => {
  const p = proposal({kind: 'hold', text: null}, {
    state: 'current_role_mismatch', recommendation: 'stop', next_round: 0,
    job_fit: {score: 85, hard_condition_status: 'conflict'},
  });
  const result = validateProposal(input({proposal: p}));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('no-send stop rejects a missing latest candidate citation or a missing hard conflict', () => {
  const p = proposal({kind: 'hold', text: null, citations: []}, {
    state: 'current_role_mismatch', recommendation: 'stop', next_round: 0,
  });
  const result = validateProposal(input({proposal: p}));
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('stop_candidate_citation_missing'));
  assert.ok(codes(result).includes('stop_conflict_missing'));
});

test('round two rejects a stale outbound anchor even when the old reply is cited', () => {
  const newer = [...messages, {mid: 4, time: 4, from: {uid: 900}, to: {uid: UID}, body: {text: 'A later actual outbound'}}];
  const fingerprint = historyFingerprint(newer);
  const result = validateProposal(input({
    packet: packet({history: {complete: true, messages: newer, sha256: fingerprint}}),
    proposal: proposal({expectedHistorySha256: fingerprint}, {history: {...record().history, sha256: fingerprint, last_mid: 4, last_direction: 'out'}}),
  }));
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('round2_outbound_anchor_stale'));
  assert.ok(codes(result).includes('round2_requires_candidate_reply'));
  assert.ok(codes(result).includes('round2_requires_reply_citation'));
});

test('a resume platform receipt is retained but does not replace the latest recruiter text anchor', () => {
  const newer = [...messages,
    {mid: 4, time: 4, from: {uid: 900}, to: {uid: UID}, body: {type: 4, text: 'Platform attachment receipt'}},
    {mid: 5, time: 5, from: {uid: UID}, to: {uid: 900}, body: {type: 4}},
  ];
  const fingerprint = historyFingerprint(newer);
  const result = validateProposal(input({
    packet: packet({history: {complete: true, messages: newer, sha256: fingerprint}}),
    proposal: proposal({expectedHistorySha256: fingerprint}, {history: {...record().history, sha256: fingerprint, last_mid: 5, last_direction: 'in'}}),
  }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('numeric type one accepts actual recruiter text and candidate reply for round two', () => {
  const changed = structuredClone(messages);
  changed[1].body.type = 1;
  changed[2].body.type = 1;
  const fingerprint = historyFingerprint(changed);
  const result = validateProposal(input({
    packet: packet({history: {complete: true, messages: changed, sha256: fingerprint}}),
    proposal: proposal({expectedHistorySha256: fingerprint}, {history: {...record().history, sha256: fingerprint}}),
  }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('platform or malformed typed candidate text is not a genuine round-two reply', () => {
  for (const type of [4, '1', [1], null]) {
    const changed = structuredClone(messages);changed[2].body.type=type;
    const fingerprint=historyFingerprint(changed);
    const result=validateProposal(input({packet:packet({history:{complete:true,messages:changed,sha256:fingerprint}}),
      proposal:proposal({expectedHistorySha256:fingerprint},{history:{...record().history,sha256:fingerprint}})}));
    assert.equal(result.valid,false,JSON.stringify(type));
    assert.ok(codes(result).includes('round2_requires_candidate_reply'));
  }
});

test('valid proposal derives all hashes from actual content and exact candidate citation', () => {
  const result = validateProposal(input({packet: {...packet(), reviewPolicy: {newTechnologyAppeared: false}}}));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.match(result.bindingSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.proposalSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.textSha256, hash(proposal().text));
  assert.ok(result.warnings.some(warning => warning.code === 'multiple_primary_purposes'));
  assert.equal(proposal().text, '方便再确认每周四天和日薪吗？另外请补充最快到岗时间。');
});

test('old currentRecord CAS accepts a fresh inbound snapshot and new decision record', () => {
  const oldMessages = messages.slice(0, 2);
  const oldHistorySha256 = historyFingerprint(oldMessages);
  const oldCurrentRecord = record({
    history: {
      ...record().history,
      sha256: oldHistorySha256,
      last_mid: 2,
      last_direction: 'out',
    },
    communication: {
      round: 1,
      last_outbound_mid: 2,
      last_outbound_at: '2026-10-24T02:00:00.000Z',
      pending_inbound_mids: [],
    },
    state: 'awaiting_candidate_reply',
    recommendation: 'continue_contact',
    next_round: 0,
  });
  const freshMessages = [
    ...oldMessages,
    {mid: 4, time: 4, from: {uid: UID}, to: {uid: 900}, securityId: 'rotate-4', body: {text: '可以每周实习四天，日薪两百没问题'}},
  ];
  const freshHistorySha256 = historyFingerprint(freshMessages);
  assert.notEqual(oldHistorySha256, freshHistorySha256);
  const decisionRecord = record({
    history: {
      ...record().history,
      sha256: freshHistorySha256,
      last_mid: 4,
      last_direction: 'in',
    },
    communication: {...oldCurrentRecord.communication, pending_inbound_mids: [4]},
    state: 'ready_for_contact',
    recommendation: 'continue_contact',
    next_round: 2,
  });
  const freshPacket = packet({
    recordSha256: canonicalJsonSha256(oldCurrentRecord),
    history: {complete: true, messages: freshMessages, sha256: freshHistorySha256},
  });
  const freshProposal = proposal({
    expectedRecordSha256: canonicalJsonSha256(oldCurrentRecord),
    expectedHistorySha256: freshHistorySha256,
    nextRecord: decisionRecord,
    citations: [{mid: 4, quote: '每周实习四天'}],
  });
  const result = validateProposal(input({
    packet: freshPacket,
    proposal: freshProposal,
    currentRecord: oldCurrentRecord,
  }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const wrongHistory = proposal({
    ...freshProposal,
    expectedHistorySha256: '0'.repeat(64),
  });
  assert.ok(codes(validateProposal(input({
    packet: freshPacket,
    proposal: wrongHistory,
    currentRecord: oldCurrentRecord,
  }))).includes('proposal_stale_history'));

  const wrongRecordCas = proposal({
    ...freshProposal,
    expectedRecordSha256: '0'.repeat(64),
  });
  assert.ok(codes(validateProposal(input({
    packet: freshPacket,
    proposal: wrongRecordCas,
    currentRecord: oldCurrentRecord,
  }))).includes('proposal_stale_record_cas'));
});

test('stale CAS, incomplete history, wrong identity and forged citations fail closed without throwing', () => {
  const currentRecord = record();
  const stale = validateProposal(input({packet: {...packet(), recordSha256: '0'.repeat(64)}}));
  assert.equal(stale.valid, false);
  assert.ok(codes(stale).includes('stale_record_cas'));

  const incompletePacket = packet();
  incompletePacket.history = {...incompletePacket.history, complete: false};
  const incomplete = validateProposal(input({packet: incompletePacket}));
  assert.ok(codes(incomplete).includes('history_incomplete'));

  const wrongIdentity = proposal({candidate: {uid: 202, name: 'Other', boss_job_id: JOB_ID}});
  const identity = validateProposal(input({proposal: wrongIdentity}));
  assert.ok(codes(identity).includes('candidate_proposal_mismatch'));

  const forged = validateProposal(input({proposal: proposal({citations: [
    {mid: 2, quote: '每周可以实习几天？'},
    {mid: 3, quote: '改写的引用'},
  ]})}));
  assert.ok(codes(forged).includes('citation_not_candidate'));
  assert.ok(codes(forged).includes('citation_quote_mismatch'));

  assert.doesNotThrow(() => validateProposal({}));
  assert.equal(validateProposal({}).valid, false);
  assert.equal(canonicalJsonSha256(currentRecord), packet().recordSha256);
});

test('explicit blocked, human hold, terminal state and two-round limits are enforced', () => {
  const blockedPacket = packet();
  blockedPacket.safety = {...blockedPacket.safety, blocked: true};
  assert.ok(codes(validateProposal(input({packet: blockedPacket}))).includes('candidate_blocked'));

  const heldPacket = packet();
  heldPacket.safety = {...heldPacket.safety, humanConversationHold: true};
  assert.ok(codes(validateProposal(input({packet: heldPacket}))).includes('human_conversation_hold'));

  const validHold = proposal({
    kind: 'hold',
    text: null,
    citations: [],
  }, {
    communication: record().communication,
    recommendation: 'hold',
    next_round: 0,
  });
  assert.equal(validateProposal(input({packet: heldPacket, proposal: validHold})).valid, true);

  const terminalRecord = record({state: 'stop_contact', recommendation: 'stop', next_round: 0});
  const terminalPacket = packet({recordSha256: canonicalJsonSha256(terminalRecord)});
  const terminalProposal = proposal({
    expectedRecordSha256: canonicalJsonSha256(terminalRecord),
    nextRecord: record({state: 'awaiting_candidate_reply'}),
  });
  assert.ok(codes(validateProposal(input({
    packet: terminalPacket,
    proposal: terminalProposal,
    currentRecord: terminalRecord,
  }))).includes('terminal_state'));

  const wrongRoundRecord = record({communication: {...record().communication, round: 0}});
  const wrongRoundPacket = packet({recordSha256: canonicalJsonSha256(wrongRoundRecord)});
  const wrongRoundProposal = proposal({expectedRecordSha256: canonicalJsonSha256(wrongRoundRecord)});
  assert.ok(codes(validateProposal(input({
    packet: wrongRoundPacket,
    proposal: wrongRoundProposal,
    currentRecord: wrongRoundRecord,
  }))).includes('substantive_round_stale'));
});

test('HR handoff requires verified Base readback and cannot duplicate an existing handoff', () => {
  const currentRecord = record({state: 'ai_screened_pass', recommendation: 'ready_for_hr', next_round: 0});
  const nextRecord = record({
    communication: currentRecord.communication,
    state: 'ai_screened_pass',
    recommendation: 'ready_for_hr',
    next_round: 0,
  });
  const handoff = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    kind: 'hr_handoff',
    text: '你的信息已转交人事继续查看，后续会在 BOSS 上联系你。',
    nextRecord,
  });
  const unread = packet({recordSha256: canonicalJsonSha256(currentRecord)});
  assert.ok(codes(validateProposal(input({packet: unread, proposal: handoff, currentRecord}))).includes('hr_before_base_readback'));

  const readback = packet({recordSha256: canonicalJsonSha256(currentRecord)});
  readback.safety = {...readback.safety, baseReadbackVerified: true};
  assert.equal(validateProposal(input({packet: readback, proposal: handoff, currentRecord})).valid, true);

  readback.safety = {...readback.safety, bossHandoffSent: true};
  assert.ok(codes(validateProposal(input({packet: readback, proposal: handoff, currentRecord}))).includes('handoff_already_sent'));
});

test('pre-send decision records cannot pre-advance rounds or prewrite HR state', () => {
  const thirdRound = proposal({kind: 'substantive_round3'});
  assert.ok(codes(validateProposal(input({proposal: thirdRound}))).includes('proposal_kind_invalid'));

  const preAdvancedRound = proposal({}, {
    communication: {...record().communication, round: 2},
  });
  assert.ok(codes(validateProposal(input({proposal: preAdvancedRound}))).includes('next_record_round_mismatch'));

  const prewrittenAwaiting = proposal({}, {state: 'awaiting_candidate_reply'});
  assert.ok(codes(validateProposal(input({proposal: prewrittenAwaiting}))).includes('next_record_state_mismatch'));

  const currentRecord = record({state: 'ai_screened_pass', recommendation: 'ready_for_hr', next_round: 0});
  const readback = packet({recordSha256: canonicalJsonSha256(currentRecord)});
  readback.safety = {...readback.safety, baseReadbackVerified: true};
  const prewrittenHr = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    kind: 'hr_handoff',
    text: '你的信息已转交人事继续查看，后续会在 BOSS 上联系你。',
    nextRecord: record({
      communication: currentRecord.communication,
      state: 'hr_review',
      recommendation: 'ready_for_hr',
      next_round: 0,
    }),
  });
  assert.ok(codes(validateProposal(input({packet: readback, proposal: prewrittenHr, currentRecord}))).includes('handoff_state_mismatch'));

  const advancedHrRound = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    kind: 'hr_handoff',
    text: '你的信息已转交人事继续查看，后续会在 BOSS 上联系你。',
    nextRecord: record({
      communication: {...currentRecord.communication, round: 2},
      state: 'ai_screened_pass',
      recommendation: 'ready_for_hr',
      next_round: 0,
    }),
  });
  assert.ok(codes(validateProposal(input({packet: readback, proposal: advancedHrRound, currentRecord}))).includes('handoff_round_changed'));
});

test('score changes fail closed by default and require an explicit new-technology review', () => {
const changedScore = {
    ...record().score,
    dimensions: {core_role_skills: 90, project_depth: 90, engineering_habits: 90, learning_and_collaboration: 90},
    ability_base_score: 90,
    final_signal_score: 90,
  };
  const changed = proposal({}, {score: changedScore});
  const enforcedPacket = {...packet(), reviewPolicy: {newTechnologyAppeared: false}};
  const rejected = validateProposal(input({packet: enforcedPacket, proposal: changed}));
  assert.equal(rejected.valid, false);
  assert.ok(codes(rejected).includes('score_changed_without_new_technology'));

  const notEnforced = validateProposal(input({proposal: changed}));
  assert.ok(codes(notEnforced).includes('score_changed_without_new_technology'));
  const explicit = validateProposal(input({packet: {...packet(), reviewPolicy: {newTechnologyAppeared: true}}, proposal: changed}));
  assert.ok(!codes(explicit).includes('score_changed_without_new_technology'));
});
test('foreign participants, no candidate reply and empty round-two citations fail closed', () => {
  const empty = validateProposal(input({proposal: proposal({citations: []})}));
  assert.ok(codes(empty).includes('round2_requires_reply_citation'));
  const noReplyMessages = messages.slice(0, 2), sha = historyFingerprint(noReplyMessages);
  const old = record({history: {...record().history, sha256: sha, last_mid: 2, last_direction: 'out'}, communication: {...record().communication, pending_inbound_mids: []}});
  const p = packet(); p.recordSha256 = canonicalJsonSha256(old); p.history = {complete: true, sha256: sha, messages: noReplyMessages};
  const next = record({state: 'needs_more_info', history: {...old.history}, communication: {...old.communication}});
  const draft = proposal({expectedRecordSha256: p.recordSha256, expectedHistorySha256: sha, citations: []}); draft.nextRecord = next;
  assert.ok(codes(validateProposal(input({packet: p, currentRecord: old, proposal: draft}))).includes('round2_requires_candidate_reply'));
  const foreign = structuredClone(messages); foreign[2].to.uid = 777;
  const changed = packet(); changed.history = {complete: true, messages: foreign, sha256: historyFingerprint(foreign)};
  assert.ok(codes(validateProposal(input({packet: changed}))).includes('history_participants_invalid'));
});
test('missing mandatory facts fail even when the historical ledger validator is permissive', () => {
  const current = record(); delete current.facts;
  assert.ok(codes(validateProposal(input({currentRecord: current}))).includes('current_facts_invalid'));
});
test('job profile bytes are hashed as original UTF-8 bytes and canonicalized separately', () => {
  const jobProfileBytes = Buffer.from(JSON.stringify(jobProfile, null, 2), 'utf8');
  const bytesSha256 = hash(jobProfileBytes);
  assert.notEqual(bytesSha256, canonicalJsonSha256(jobProfile));
  const currentRecord = record({job: {boss_job_id: JOB_ID, job_profile_sha256: bytesSha256}});
  const nextRecord = record({
    job: {boss_job_id: JOB_ID, job_profile_sha256: bytesSha256},
    communication: currentRecord.communication,
    state: 'ready_for_contact',
    next_round: 2,
  });
  const bytesProposal = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    jobProfileSha256: bytesSha256,
    nextRecord,
  });
  const bytesPacket = packet({recordSha256: canonicalJsonSha256(currentRecord), jobProfileSha256: bytesSha256});
  const result = validateProposal({
    packet: bytesPacket,
    proposal: bytesProposal,
    currentRecord,
    jobProfile,
    jobProfileBytes,
    jobProfileHashMode: 'bytes',
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const noMode = validateProposal({
    packet: bytesPacket,
    proposal: bytesProposal,
    currentRecord,
    jobProfile,
  });
  assert.ok(codes(noMode).includes('job_profile_hash_mode_required'));
});

test('latest history message is selected by time and mid rather than array position', () => {
  const shuffled = [messages[2], messages[0], messages[1]];
  const shuffledSha256 = historyFingerprint(shuffled);
  const currentRecord = record({history: {...record().history, sha256: shuffledSha256}});
  const nextRecord = {
    ...proposal().nextRecord,
    history: {...proposal().nextRecord.history, sha256: shuffledSha256},
  };
  const shuffledPacket = packet({
    recordSha256: canonicalJsonSha256(currentRecord),
    history: {complete: true, messages: shuffled, sha256: shuffledSha256},
  });
  const shuffledProposal = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    expectedHistorySha256: shuffledSha256,
    nextRecord,
  });
  const result = validateProposal(input({
    packet: shuffledPacket,
    proposal: shuffledProposal,
    currentRecord,
  }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('numeric and string forms of the same mid are duplicate history identities', () => {
  const duplicateMessages = [...messages, {...messages[2], mid: '3', time: 4}];
  const duplicateSha256 = historyFingerprint(duplicateMessages);
  const currentRecord = record({
    history: {...record().history, sha256: duplicateSha256, last_mid: '3'},
  });
  const duplicatePacket = packet({
    recordSha256: canonicalJsonSha256(currentRecord),
    history: {complete: true, messages: duplicateMessages, sha256: duplicateSha256},
  });
  const duplicateProposal = proposal({
    expectedRecordSha256: canonicalJsonSha256(currentRecord),
    expectedHistorySha256: duplicateSha256,
    nextRecord: {
      ...proposal().nextRecord,
      history: {...proposal().nextRecord.history, sha256: duplicateSha256},
    },
  });
  const result = validateProposal(input({
    packet: duplicatePacket,
    proposal: duplicateProposal,
    currentRecord,
  }));
  assert.ok(codes(result).includes('history_mid_duplicate'));
});
test('binding changes when the same facts carry a different proposal body', () => {
  const firstProposal = proposal({text: '方便确认每周实习四天吗？'});
  const secondProposal = proposal({text: '每周实习四天是否可行？'});
  const first = validateProposal(input({proposal: firstProposal}));
  const second = validateProposal(input({proposal: secondProposal}));
  assert.equal(first.valid, true, JSON.stringify(first.errors));
  assert.equal(second.valid, true, JSON.stringify(second.errors));
  assert.notEqual(first.textSha256, second.textSha256);
  assert.notEqual(first.proposalSha256, second.proposalSha256);
  assert.notEqual(first.bindingSha256, second.bindingSha256);
});
test('substantive round two enforces deterministic ability, coverage and signal gates', () => {
  const scoreFor = dimensions => {
    const calculated = scoreInternship(dimensions);
    return {
      dimensions,
      ability_base_score: calculated.abilityBaseScore,
      evidence_coverage_percent: calculated.evidenceCoveragePercent,
      competitions: [],
      github_projects: [],
      competition_bonus: calculated.competitionBonus,
      github_bonus: calculated.githubBonus,
      proof_bonus: calculated.proofBonus,
      final_signal_score: calculated.finalSignalScore,
      evaluation_sha256: 'd'.repeat(64),
    };
  };
  const lowBase = validateProposal(input({proposal: proposal({}, {
    state: 'needs_more_info',
    score: scoreFor({core_role_skills: 50, project_depth: 50, engineering_habits: 50, learning_and_collaboration: 50}),
  })}));
  assert.ok(codes(lowBase).includes('round2_ability_gate'));
  assert.ok(!codes(lowBase).includes('round2_coverage_gate'));

  const lowCoverage = validateProposal(input({proposal: proposal({}, {
    state: 'needs_more_info',
    score: scoreFor({core_role_skills: 70, project_depth: null, engineering_habits: null, learning_and_collaboration: null}),
  })}));
  assert.ok(codes(lowCoverage).includes('round2_coverage_gate'));
  assert.ok(!codes(lowCoverage).includes('round2_ability_gate'));
  assert.ok(!codes(lowCoverage).includes('round2_signal_gate'));

  const lowSignal = validateProposal(input({proposal: proposal({}, {
    state: 'needs_more_info',
    score: scoreFor({core_role_skills: 60, project_depth: 60, engineering_habits: 60, learning_and_collaboration: 60}),
  })}));
  assert.ok(codes(lowSignal).includes('round2_signal_gate'));
  assert.ok(!codes(lowSignal).includes('round2_ability_gate'));
  assert.ok(!codes(lowSignal).includes('round2_coverage_gate'));

  const currentRoundZero = record({
    communication: {round: 0, last_outbound_mid: null, last_outbound_at: null, pending_inbound_mids: [3]},
    state: 'needs_more_info',
    score: scoreFor({core_role_skills: 50, project_depth: 50, engineering_habits: 50, learning_and_collaboration: 50}),
    next_round: 0,
  });
  const lowRoundOneDecision = record({
    communication: currentRoundZero.communication,
    state: 'needs_more_info',
    next_round: 1,
    score: scoreFor({core_role_skills: 50, project_depth: 50, engineering_habits: 50, learning_and_collaboration: 50}),
  });
  const roundOne = validateProposal(input({
    packet: packet({recordSha256: canonicalJsonSha256(currentRoundZero)}),
    currentRecord: currentRoundZero,
    proposal: proposal({
      expectedRecordSha256: canonicalJsonSha256(currentRoundZero),
      kind: 'substantive_round1',
      nextRecord: lowRoundOneDecision,
    }),
  }));
  assert.equal(roundOne.valid, true, JSON.stringify(roundOne.errors));
  assert.ok(!codes(roundOne).some(code => code.startsWith('round2_')));
});
