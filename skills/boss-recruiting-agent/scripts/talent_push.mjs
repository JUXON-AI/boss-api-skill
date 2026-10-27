import {createHash} from 'node:crypto';

const ALLOWED_STATES = new Set(['ai_screened_pass', 'hr_review']);
const REDACTION = '［联系方式已脱敏］';
const MAX = Object.freeze({
  candidateName: 100,
  jobName: 160,
  school: 200,
  salary: 120,
  arrival: 120,
  groupName: 120,
  technicalSummary: 350,
  baseUrl: 2048,
  decimalId: 32,
  recordId: 96,
  chatId: 96,
});
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
const CHINA_MOBILE_PATTERN = /(?<!\d)(?:\+?86[\s-]*)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/gu;
const CHINA_LANDLINE_PATTERN = /(?<!\d)(?:\+?86[\s-]*)?(?:\(?0\d{2,3}\)?[\s-]?)\d{7,8}(?!\d)/gu;
const INTERNATIONAL_PHONE_PATTERN = /(?<!\d)\+\d(?:[\s().-]?\d){7,14}(?!\d)/gu;
const LONG_NUMERIC_ID_PATTERN = /(?<!\d)\d{7,32}(?!\d)/gu;

function fail(message) {
  throw new TypeError(`unsafe talent push: ${message}`);
}

function asRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function readField(object, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail(`${label} must be an enumerable data property`);
  }
  return descriptor.value;
}

function readOptionalField(object, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail(`${label} must be an enumerable data property when present`);
  }
  return descriptor.value;
}
function nestedRecord(object, key, label) {
  return asRecord(readField(object, key, label), label);
}

function textField(value, label, maxLength) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.trim().length === 0) fail(`${label} must be nonempty`);
  if ([...value].length > maxLength) fail(`${label} exceeds ${maxLength} characters`);
  return value;
}

function hasDirectContact(value) {
  EMAIL_PATTERN.lastIndex = 0;
  CHINA_MOBILE_PATTERN.lastIndex = 0;
  CHINA_LANDLINE_PATTERN.lastIndex = 0;
  INTERNATIONAL_PHONE_PATTERN.lastIndex = 0;
  return EMAIL_PATTERN.test(value)
    || CHINA_MOBILE_PATTERN.test(value)
    || CHINA_LANDLINE_PATTERN.test(value)
    || INTERNATIONAL_PHONE_PATTERN.test(value);
}

function contactFreeTextField(value, label, maxLength) {
  const text = textField(value, label, maxLength);
  if (hasDirectContact(text)) fail(`${label} must not contain direct contact details`);
  return text;
}

function optionalContactFreeTextField(value, label, maxLength) {
  if (value === null || value === undefined
    || (typeof value === 'string' && value.trim().length === 0)) {
    return '未提供';
  }
  return contactFreeTextField(value, label, maxLength);
}
function positiveDecimalId(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
    return String(value);
  }
  if (typeof value !== 'string'
    || value.length > MAX.decimalId
    || !/^[1-9]\d*$/.test(value)) {
    fail(`${label} must be a canonical positive decimal ID`);
  }
  return value;
}

function recordId(value, label) {
  if (typeof value !== 'string'
    || value.length > MAX.recordId
    || !/^rec[A-Za-z0-9_-]+$/.test(value)) {
    fail(`${label} must be a safe rec... ID`);
  }
  return value;
}

function chatId(value, label) {
  if (typeof value !== 'string'
    || value.length > MAX.chatId
    || !/^oc_[A-Za-z0-9_-]+$/.test(value)) {
    fail(`${label} must be a safe oc_... chat ID`);
  }
  return value;
}

function boundedScore(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(`${label} must be a finite number from 0 through 100`);
  }
  return value;
}

function httpsUrl(value, label) {
  const text = textField(value, label, MAX.baseUrl);
  if (text !== text.trim() || /\s/u.test(text)) fail(`${label} must contain no whitespace`);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    fail(`${label} must not contain URL credentials`);
  }
  if (['record', 'record_id', 'recordId'].some(key => parsed.searchParams.has(key))) {
    fail(`${label} must link to the configured Base table, not a record deep link`);
  }
  return text;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(label);
}

function redactContacts(value) {
  return value
    .replace(EMAIL_PATTERN, REDACTION)
    .replace(CHINA_MOBILE_PATTERN, REDACTION)
    .replace(CHINA_LANDLINE_PATTERN, REDACTION)
    .replace(INTERNATIONAL_PHONE_PATTERN, REDACTION)
    .replace(LONG_NUMERIC_ID_PATTERN, REDACTION);
}

function text(value) {
  return {tag: 'text', text: value};
}

function labelledLine(label, value) {
  return [text(label), text(value)];
}

function sha256Utf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Build the Feishu custom-bot `post` payload for an already screened and saved
 * talent record. This function is intentionally pure: it performs no I/O and
 * accepts no raw conversation, contact fields, or fallback metadata.
 */
/**
 * Compute the stable runtime de-dupe key from only group, job, UID, and saved
 * record identity. Metadata edits intentionally do not change the key.
 */
export function talentPushEventKey(input) {
  const identity = asRecord(input, 'event identity');
  const safeChatId = chatId(readField(identity, 'chatId', 'eventIdentity.chatId'), 'eventIdentity.chatId');
  const safeJobId = positiveDecimalId(
    readField(identity, 'jobId', 'eventIdentity.jobId'),
    'eventIdentity.jobId',
  );
  const safeUid = positiveDecimalId(readField(identity, 'uid', 'eventIdentity.uid'), 'eventIdentity.uid');
  const safeRecordId = recordId(
    readField(identity, 'recordId', 'eventIdentity.recordId'),
    'eventIdentity.recordId',
  );
  const eventIdentity = JSON.stringify([safeChatId, safeJobId, safeUid, safeRecordId]);
  return `talentpush_${sha256Utf8(eventIdentity).slice(0, 36)}`;
}
export function buildTalentPush(input) {
  const root = asRecord(input, 'input');
  const candidate = nestedRecord(root, 'candidate', 'candidate');
  const screening = nestedRecord(root, 'screening', 'screening');
  const base = nestedRecord(root, 'base', 'base');
  const group = nestedRecord(root, 'group', 'group');
  const expected = nestedRecord(root, 'expected', 'expected');

  const uid = positiveDecimalId(readField(candidate, 'uid', 'candidate.uid'), 'candidate.uid');
  const candidateName = contactFreeTextField(
    readField(candidate, 'name', 'candidate.name'),
    'candidate.name',
    MAX.candidateName,
  );
  const candidateJobId = positiveDecimalId(
    readField(candidate, 'jobId', 'candidate.jobId'),
    'candidate.jobId',
  );

  const state = readField(screening, 'state', 'screening.state');
  if (typeof state !== 'string' || !ALLOWED_STATES.has(state)) {
    fail('screening.state must be ai_screened_pass or hr_review');
  }
  const abilityBaseScore = boundedScore(
    readField(screening, 'abilityBaseScore', 'screening.abilityBaseScore'),
    'screening.abilityBaseScore',
  );
  const evidenceCoveragePercent = boundedScore(
    readField(screening, 'evidenceCoveragePercent', 'screening.evidenceCoveragePercent'),
    'screening.evidenceCoveragePercent',
  );
  const finalSignalScore = boundedScore(
    readField(screening, 'finalSignalScore', 'screening.finalSignalScore'),
    'screening.finalSignalScore',
  );
  if (abilityBaseScore < 60) fail('screening.abilityBaseScore must be at least 60');
  if (evidenceCoveragePercent < 70) fail('screening.evidenceCoveragePercent must be at least 70');
  if (finalSignalScore < 65) fail('screening.finalSignalScore must be at least 65');
  assertEqual(
    readField(screening, 'conditionsConfirmed', 'screening.conditionsConfirmed'),
    6,
    'screening.conditionsConfirmed must equal 6',
  );
  assertEqual(
    readField(screening, 'aiCodingConfirmed', 'screening.aiCodingConfirmed'),
    true,
    'screening.aiCodingConfirmed must be true',
  );

  const savedRecordId = recordId(readField(base, 'recordId', 'base.recordId'), 'base.recordId');
  const baseUid = positiveDecimalId(readField(base, 'uid', 'base.uid'), 'base.uid');
  const baseJobId = positiveDecimalId(readField(base, 'jobId', 'base.jobId'), 'base.jobId');
  const baseName = contactFreeTextField(
    readField(base, 'name', 'base.name'),
    'base.name',
    MAX.candidateName,
  );
  const jobName = contactFreeTextField(
    readField(base, 'jobName', 'base.jobName'),
    'base.jobName',
    MAX.jobName,
  );
  assertEqual(readField(base, 'conclusion', 'base.conclusion'), '通过', 'base.conclusion must equal 通过');
  assertEqual(readField(base, 'hrStatus', 'base.hrStatus'), '待复核', 'base.hrStatus must equal 待复核');
  const actualBaseUrl = httpsUrl(readField(base, 'url', 'base.url'), 'base.url');
  const salary = contactFreeTextField(readField(base, 'salary', 'base.salary'), 'base.salary', MAX.salary);
  const arrival = contactFreeTextField(
    readField(base, 'arrival', 'base.arrival'),
    'base.arrival',
    MAX.arrival,
  );
  const school = optionalContactFreeTextField(
    readOptionalField(base, 'school', 'base.school'),
    'base.school',
    MAX.school,
  );
  const technicalSummary = textField(
    readField(base, 'technicalSummary', 'base.technicalSummary'),
    'base.technicalSummary',
    MAX.technicalSummary,
  );

  const recipientChatId = chatId(readField(group, 'chatId', 'group.chatId'), 'group.chatId');
  const groupName = textField(readField(group, 'name', 'group.name'), 'group.name', MAX.groupName);
  assertEqual(readField(group, 'external', 'group.external'), false, 'group.external must be false');

  const expectedJobId = positiveDecimalId(
    readField(expected, 'jobId', 'expected.jobId'),
    'expected.jobId',
  );
  const expectedChatId = chatId(readField(expected, 'chatId', 'expected.chatId'), 'expected.chatId');
  const expectedGroupName = textField(
    readField(expected, 'groupName', 'expected.groupName'),
    'expected.groupName',
    MAX.groupName,
  );
  const expectedBaseUrl = httpsUrl(
    readField(expected, 'baseUrl', 'expected.baseUrl'),
    'expected.baseUrl',
  );

  assertEqual(uid, baseUid, 'candidate and Base UID mismatch');
  assertEqual(candidateJobId, baseJobId, 'candidate and Base job ID mismatch');
  assertEqual(candidateJobId, expectedJobId, 'candidate and expected job ID mismatch');
  assertEqual(candidateName, baseName, 'candidate and Base name mismatch');
  assertEqual(recipientChatId, expectedChatId, 'group and expected chat ID mismatch');
  assertEqual(groupName, expectedGroupName, 'group and expected group name mismatch');
  assertEqual(actualBaseUrl, expectedBaseUrl, 'Base URL does not exactly match the expected saved record URL');
  assertEqual(readField(root, 'paused', 'paused'), false, 'paused must be false');

  const safeTechnicalSummary = redactContacts(technicalSummary);
  const content = {
    zh_cn: {
      title: 'AI人才推荐 · HR待复核',
      content: [
        labelledLine('姓名：', candidateName),
        labelledLine('应聘岗位：', jobName),
        labelledLine('院校：', school),
        labelledLine(
          '筛选结果：',
          `基础 ${abilityBaseScore} / 证据覆盖 ${evidenceCoveragePercent}% / 综合信号 ${finalSignalScore}`,
        ),
        labelledLine('技术自述（候选人自述，未经独立核验）：', safeTechnicalSummary),
        labelledLine('薪资：', salary),
        labelledLine('到岗：', arrival),
        [text('6项现实条件已确认；有本人AI辅助编程实践自述')],
        [text('流程状态：AI初筛通过，待HR复核；不代表面试或录用')],
        [
          text('简历人才库详见：'),
          {tag: 'a', text: '人才库', href: actualBaseUrl},
        ],
        [text('来源：候选人自述，未经独立核验。')],
      ],
    },
  };

    const eventKey = talentPushEventKey({
    chatId: recipientChatId,
    jobId: candidateJobId,
    uid,
    recordId: savedRecordId,
  });
  const payloadSha256 = sha256Utf8(JSON.stringify({msg_type: 'post', content}));

  return {
    eventKey,
    payloadSha256,
    msgType: 'post',
    content,
    recipientChatId,
  };
}






