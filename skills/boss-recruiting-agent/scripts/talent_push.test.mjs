import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildTalentPush, talentPushEventKey} from './talent_push.mjs';

function fixture() {
  return {
    candidate: {
      uid: '10001',
      name: '合成候选人',
      jobId: '20002',
    },
    screening: {
      state: 'ai_screened_pass',
      abilityBaseScore: 82,
      evidenceCoveragePercent: 86,
      finalSignalScore: 88,
      conditionsConfirmed: 6,
      aiCodingConfirmed: true,
    },
    base: {
      recordId: 'recSynthetic001',
      uid: '10001',
      jobId: '20002',
      name: '合成候选人',
      jobName: '合成岗位工程师',
      conclusion: '通过',
      hrStatus: '待复核',
      url: 'https://open.feishu.cn/base/appSynthetic?table=tblSynthetic&view=vewSynthetic',
      salary: '合成薪资范围',
      arrival: '合成到岗安排',
      school: '合成大学',
      technicalSummary: '使用合成技术栈完成过内部工具，表述仅来自候选人自述。',
    },
    group: {
      chatId: 'oc_synthetic_internal_group',
      name: '合成招聘内部群',
      external: false,
    },
    expected: {
      jobId: '20002',
      chatId: 'oc_synthetic_internal_group',
      groupName: '合成招聘内部群',
      baseUrl: 'https://open.feishu.cn/base/appSynthetic?table=tblSynthetic&view=vewSynthetic',
    },
    paused: false,
  };
}

const clone = value => structuredClone(value);
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const allNodes = result => result.content.zh_cn.content.flat();

function changed(mutator) {
  const input = fixture();
  mutator(input);
  return input;
}

test('builds the bounded post contract and hashes the exact UTF-8 wire JSON', () => {
  const input = fixture();
  const before = clone(input);
  const result = buildTalentPush(input);

  assert.deepEqual(input, before, 'the builder must not mutate supplied data');
  assert.deepEqual(Object.keys(result).sort(), [
    'content',
    'eventKey',
    'msgType',
    'payloadSha256',
    'recipientChatId',
  ]);
  assert.equal(result.msgType, 'post');
  assert.equal(result.recipientChatId, 'oc_synthetic_internal_group');
  assert.match(result.eventKey, /^talentpush_[a-f0-9]{36}$/);
  assert.ok(result.eventKey.length <= 50);
  assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    result.payloadSha256,
    sha256(JSON.stringify({msg_type: 'post', content: result.content})),
  );

  assert.equal(result.content.zh_cn.title, 'AI人才推荐 · HR待复核');
  assert.ok(result.content.zh_cn.content.every(Array.isArray));
  const nodes = allNodes(result);
  assert.ok(nodes.every(node => node.tag === 'text' || node.tag === 'a'));
  assert.equal(nodes.filter(node => node.tag === 'a').length, 1, 'exactly one link is allowed');
  assert.equal(nodes.filter(node => node.tag === 'at').length, 0, 'no at tags are allowed');
  assert.ok(nodes.filter(node => node.tag === 'text').every(node =>
    Object.keys(node).sort().join(',') === 'tag,text'));
  const link = nodes.find(node => node.tag === 'a');
  assert.deepEqual(link, {
    tag: 'a',
    text: '人才库',
    href: input.expected.baseUrl,
  });

  const rendered = JSON.stringify(result.content);
  for (const required of [
    '姓名',
    '应聘岗位',
    '院校：',
    '基础 82',
    '证据覆盖 86%',
    '综合信号 88',
    '6项现实条件已确认',
    '有本人AI辅助编程实践自述',
    'AI初筛通过，待HR复核；不代表面试或录用',
    '简历人才库详见',
    '候选人自述，未经独立核验',
  ]) {
    assert.match(rendered, new RegExp(required));
  }
});

test('accepts only the permitted states and inclusive 60/70/65 score gates', () => {
  const boundary = fixture();
  boundary.screening.state = 'hr_review';
  boundary.screening.abilityBaseScore = 60;
  boundary.screening.evidenceCoveragePercent = 70;
  boundary.screening.finalSignalScore = 65;
  assert.doesNotThrow(() => buildTalentPush(boundary));

  const failures = [
    [input => { input.screening.state = 'needs_more_info'; }, /state must be/],
    [input => { input.screening.abilityBaseScore = 59.99; }, /at least 60/],
    [input => { input.screening.evidenceCoveragePercent = 69.99; }, /at least 70/],
    [input => { input.screening.finalSignalScore = 64.99; }, /at least 65/],
    [input => { input.screening.abilityBaseScore = '82'; }, /finite number/],
    [input => { input.screening.conditionsConfirmed = 5; }, /must equal 6/],
    [input => { input.screening.conditionsConfirmed = 7; }, /must equal 6/],
    [input => { input.screening.aiCodingConfirmed = false; }, /must be true/],
  ];
  for (const [mutate, pattern] of failures) {
    assert.throws(() => buildTalentPush(changed(mutate)), pattern);
  }
});

test('rejects unsafe, mismatched, and noncanonical identities', () => {
  const failures = [
    [input => { input.candidate.uid = '010001'; }, /canonical positive decimal/],
    [input => { input.candidate.jobId = '20002.0'; }, /canonical positive decimal/],
    [input => { input.candidate.uid = '10002'; }, /UID mismatch/],
    [input => { input.candidate.jobId = '20003'; }, /job ID mismatch/],
    [input => { input.candidate.name = '合成候选人甲'; }, /name mismatch/],
    [input => { input.base.recordId = 'row001'; }, /rec\.\.\. ID/],
    [input => { input.group.chatId = 'group001'; }, /oc_\.\.\. chat ID/],
  ];
  for (const [mutate, pattern] of failures) {
    assert.throws(() => buildTalentPush(changed(mutate)), pattern);
  }
});

test('rejects wrong job, wrong group, a renamed group, or an external destination', () => {
  const failures = [
    [input => { input.expected.jobId = '20003'; }, /expected job ID mismatch/],
    [input => { input.expected.chatId = 'oc_other_internal_group'; }, /expected chat ID mismatch/],
    [input => { input.expected.groupName = '其他内部群'; }, /expected group name mismatch/],
    [input => { input.group.external = true; }, /external must be false/],
    [input => { input.group.external = 'false'; }, /external must be false/],
  ];
  for (const [mutate, pattern] of failures) {
    assert.throws(() => buildTalentPush(changed(mutate)), pattern);
  }
});

test('requires an unpaused, already-passed, HR-pending Base row and exact saved link', () => {
  const failures = [
    [input => { input.paused = true; }, /paused must be false/],
    [input => { input.paused = 'false'; }, /paused must be false/],
    [input => { input.base.conclusion = '待定'; }, /conclusion must equal 通过/],
    [input => { input.base.hrStatus = '已完成'; }, /hrStatus must equal 待复核/],
    [input => { delete input.base.technicalSummary; }, /technicalSummary must be an enumerable data property/],
    [input => { input.base.salary = ''; }, /salary must be nonempty/],
    [input => { input.base.url = input.expected.baseUrl + '&view=other'; }, /does not exactly match/],
    [input => { input.base.url = 'http://open.feishu.cn/base/appSynthetic'; input.expected.baseUrl = input.base.url; }, /absolute HTTPS URL/],
    [input => {
      input.base.url = 'https://internal:credential@open.feishu.cn/base/appSynthetic';
      input.expected.baseUrl = input.base.url;
    }, /URL credentials/],
    [input => {
      input.base.url = input.expected.baseUrl + '&record=recSynthetic001';
      input.expected.baseUrl = input.base.url;
    }, /configured Base table, not a record deep link/],
  ];
  for (const [mutate, pattern] of failures) {
    assert.throws(() => buildTalentPush(changed(mutate)), pattern);
  }
});

test('keeps injected markup literal, emits no at/html tag, and excludes direct identity data', () => {
  const input = fixture();
  const injectedName = '合成<候选人>&"测试"';
  input.candidate.name = injectedName;
  input.base.name = injectedName;
  input.base.technicalSummary = [
    '使用 Node.js <at id="all">@all</at> </text><script>alert(1)</script> **Markdown**。',
    '邮箱 synthetic@example.test；手机 138 0013 8000；座机 (010) 87654321；',
    '证件 110101199001011234。',
  ].join('');
  input.base.gender = 'SYNTHETIC_GENDER';
  input.base.age = 29;
  input.base.phone = 'PHONE_SHOULD_NOT_APPEAR';
  input.base.email = 'EMAIL_SHOULD_NOT_APPEAR';
  input.base.securityId = 'SECURITY_SHOULD_NOT_APPEAR';
  input.base.fullChat = 'FULL_CHAT_SHOULD_NOT_APPEAR';
  input.candidate.securityId = 'CANDIDATE_SECURITY_SHOULD_NOT_APPEAR';
  input.group.fullChat = 'GROUP_CHAT_SHOULD_NOT_APPEAR';

  const result = buildTalentPush(input);
  const nodes = allNodes(result);
  const rendered = JSON.stringify(result);
  const texts = nodes.filter(node => node.tag === 'text').map(node => node.text);

  assert.equal(nodes.filter(node => node.tag === 'at').length, 0);
  assert.equal(nodes.filter(node => node.tag === 'a').length, 1);
  assert.ok(nodes.every(node => !['markdown', 'interactive', 'html'].includes(node.tag)));
  assert.equal(texts.filter(value => value === injectedName).length, 1);
  assert.ok(texts.some(value => value === `技术自述（候选人自述，未经独立核验）：`));
  assert.ok(texts.some(value => value.includes('<at id="all">@all</at>')));
  assert.ok(texts.some(value => value.includes('</text><script>alert(1)</script>')));
  assert.ok(texts.some(value => value.includes('**Markdown**')));

  for (const secret of [
    'synthetic@example.test',
    '138 0013 8000',
    '(010) 87654321',
    '110101199001011234',
    'SYNTHETIC_GENDER',
    'PHONE_SHOULD_NOT_APPEAR',
    'EMAIL_SHOULD_NOT_APPEAR',
    'SECURITY_SHOULD_NOT_APPEAR',
    'FULL_CHAT_SHOULD_NOT_APPEAR',
    'CANDIDATE_SECURITY_SHOULD_NOT_APPEAR',
    'GROUP_CHAT_SHOULD_NOT_APPEAR',
  ]) {
    assert.equal(rendered.includes(secret), false, `output leaked ${secret}`);
  }
  assert.ok(texts.some(value => value.includes('［联系方式已脱敏］')));
  assert.ok(texts.some(value => value.includes('来源：候选人自述，未经独立核验。')));
});

test('bounds text and IDs and rejects missing metadata without a fallback', () => {
  const atLimit = fixture();
  atLimit.base.technicalSummary = '技'.repeat(350);
  assert.doesNotThrow(() => buildTalentPush(atLimit));

  const tooLong = fixture();
  tooLong.base.technicalSummary = '技'.repeat(351);
  assert.throws(() => buildTalentPush(tooLong), /exceeds 350 characters/);

  const tooLongName = fixture();
  tooLongName.candidate.name = '名'.repeat(101);
  tooLongName.base.name = tooLongName.candidate.name;
  assert.throws(() => buildTalentPush(tooLongName), /candidate\.name exceeds 100 characters/);

  assert.throws(() => buildTalentPush(changed(input => {
    delete input.group.name;
  })), /group\.name must be an enumerable data property/);
  assert.throws(() => buildTalentPush(changed(input => {
    delete input.expected.baseUrl;
  })), /expected\.baseUrl must be an enumerable data property/);
});

test('accepts safe numeric identity inputs and rejects malformed closed-boundary values', () => {
  const numeric = fixture();
  numeric.candidate.uid = 10001;
  numeric.base.uid = 10001;
  numeric.candidate.jobId = 20002;
  numeric.base.jobId = 20002;
  numeric.expected.jobId = 20002;
  assert.doesNotThrow(() => buildTalentPush(numeric));

  assert.throws(() => buildTalentPush(null), /input must be an object/);
  assert.throws(() => buildTalentPush(changed(input => {
    input.candidate = [];
  })), /candidate must be an object/);
  assert.throws(() => buildTalentPush(changed(input => {
    input.candidate = Object.create({inherited: true});
  })), /candidate must be a plain object/);
  assert.throws(() => buildTalentPush(changed(input => {
    input.candidate.uid = 0;
  })), /positive safe integer/);
  assert.throws(() => buildTalentPush(changed(input => {
    input.candidate.uid = Number.MAX_SAFE_INTEGER + 1;
  })), /positive safe integer/);
  assert.throws(() => buildTalentPush(changed(input => {
    input.base.url = 'https://[invalid-host';
    input.expected.baseUrl = input.base.url;
  })), /absolute HTTPS URL/);
});
test('exports one runtime de-dupe helper that exactly matches the builder key', () => {
  const input = fixture();
  const built = buildTalentPush(input);
  const identity = {
    chatId: input.group.chatId,
    jobId: input.candidate.jobId,
    uid: input.candidate.uid,
    recordId: input.base.recordId,
  };
  const earlyKey = talentPushEventKey(identity);

  assert.equal(earlyKey, built.eventKey);
  assert.match(earlyKey, /^talentpush_[a-f0-9]{36}$/);
  assert.ok(earlyKey.length <= 50);
  assert.equal(talentPushEventKey({
    chatId: identity.chatId,
    jobId: 20002,
    uid: 10001,
    recordId: identity.recordId,
    jobFit: {ignored: true},
  }), built.eventKey);

  assert.throws(() => talentPushEventKey(null), /event identity must be an object/);
  assert.throws(() => talentPushEventKey({...identity, recordId: 'row001'}), /recordId must be a safe rec\.\.\. ID/);
});

test('renders optional school as 未提供 without creating a screening gate', () => {
  for (const school of [null, undefined, '', '   ']) {
    const input = fixture();
    input.base.school = school;
    const result = buildTalentPush(input);
    const schoolLine = result.content.zh_cn.content.find(line =>
      line[0]?.tag === 'text' && line[0].text === '院校：');
    assert.deepEqual(schoolLine, [
      {tag: 'text', text: '院校：'},
      {tag: 'text', text: '未提供'},
    ]);
  }

  const missing = fixture();
  delete missing.base.school;
  assert.doesNotThrow(() => buildTalentPush(missing));

  const accessor = fixture();
  Object.defineProperty(accessor.base, 'school', {
    enumerable: true,
    get() {
      throw new Error('school accessor must not execute');
    },
  });
  assert.throws(() => buildTalentPush(accessor), /school must be an enumerable data property when present/);
});
test('keeps one idempotency key across metadata edits but changes it with record identity', () => {
  const first = buildTalentPush(fixture());
  const editedInput = fixture();
  editedInput.candidate.name = '合成候选人（资料更新）';
  editedInput.base.name = editedInput.candidate.name;
  editedInput.base.jobName = '合成岗位工程师（新版本）';
  editedInput.base.school = '合成理工大学';
  editedInput.base.salary = '更新后的合成薪资';
  editedInput.base.arrival = '更新后的合成到岗安排';
  editedInput.base.technicalSummary = '更新后的合成技术自述，仍然仅来自候选人自述。';
  editedInput.base.url = 'https://open.feishu.cn/base/appSynthetic?table=tblSynthetic&view=vewUpdated';
  editedInput.expected.baseUrl = editedInput.base.url;
  editedInput.group.name = '合成招聘内部群（更名）';
  editedInput.expected.groupName = editedInput.group.name;
  editedInput.screening.state = 'hr_review';
  editedInput.screening.abilityBaseScore = 91;
  editedInput.screening.evidenceCoveragePercent = 93;
  editedInput.screening.finalSignalScore = 94;

  const edited = buildTalentPush(editedInput);
  assert.equal(edited.eventKey, first.eventKey, 'metadata edits must not permit a duplicate push');
  assert.notEqual(edited.payloadSha256, first.payloadSha256);
  assert.notDeepEqual(edited.content, first.content);

  const replacementRecord = fixture();
  replacementRecord.base.recordId = 'recSynthetic002';
  replacementRecord.base.url = 'https://open.feishu.cn/base/appSynthetic?table=tblSynthetic&view=vewSynthetic';
  replacementRecord.expected.baseUrl = replacementRecord.base.url;
  assert.notEqual(buildTalentPush(replacementRecord).eventKey, first.eventKey);

  const replacementCandidate = fixture();
  replacementCandidate.candidate.uid = '10009';
  replacementCandidate.base.uid = '10009';
  assert.notEqual(buildTalentPush(replacementCandidate).eventKey, first.eventKey);

  const replacementJob = fixture();
  replacementJob.candidate.jobId = '20009';
  replacementJob.base.jobId = '20009';
  replacementJob.expected.jobId = '20009';
  assert.notEqual(buildTalentPush(replacementJob).eventKey, first.eventKey);
});







