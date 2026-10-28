import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEducationRankPatch, extractEducation} from './talent_education_fields.mjs';

const SOURCE = 'verified-snapshot.json';
const SOURCE_SHA256 = 'a'.repeat(64);
const CANDIDATE = Object.freeze({uid: 101, name: '示例候选', jobId: '7'});
const RANKING = Object.freeze({
  year: 2026,
  category: '中国大学排名（主榜）',
  sourceUrl: 'https://www.shanghairanking.cn/rankings/bcur/2026',
  sourceSha256: 'b'.repeat(64),
  entries: [{name: '示例大学', rank: 18}],
});

function resumeMessage(resume = {}, identity = CANDIDATE) {
  return {
    mid: 12,
    from: {uid: identity.uid},
    body: {resume: {
      user: {uid: identity.uid, name: identity.name},
      jobId: identity.jobId,
      ...resume,
    }},
  };
}

function input(messages, extra = {}) {
  return {
    candidate: {...CANDIDATE},
    snapshot: {candidate: {...CANDIDATE}, history: {original_order_redacted: messages}},
    source: SOURCE,
    sourceSha256: SOURCE_SHA256,
    ...extra,
  };
}

function aliasedInput(overrides = {}, messageIdentity = {...CANDIDATE, name: '简历姓名'}) {
  return input([resumeMessage({school: '示例大学', degree: '本科'}, messageIdentity)], {
    identityAlias: {
      uid: CANDIDATE.uid,
      jobId: CANDIDATE.jobId,
      candidateName: CANDIDATE.name,
      profileName: '简历姓名',
      source: SOURCE,
      sourceSha256: SOURCE_SHA256,
      mid: 12,
      ...overrides,
    },
  });
}

test('requires an exact UID, name, and job match for resume evidence', () => {
  const wrongName = {...CANDIDATE, name: '同名候选'};
  assert.throws(() => extractEducation(input([resumeMessage({degree: '本科'})], {candidate: wrongName})), /name/i);
  const wrongJobMessage = resumeMessage({degree: '本科'}, {...CANDIDATE, jobId: '8'});
  assert.throws(() => extractEducation(input([wrongJobMessage])), /job/i);
});

test('allows a profile-name alias only for its bound original card', () => {
  const result = extractEducation(aliasedInput());
  assert.equal(result.values.degree, '本科');
  assert.equal(result.values.school, '示例大学');
  assert.equal(result.evidence.degree[0].identityAlias.profileName, '简历姓名');
  assert.equal(result.evidence.degree[0].identityAlias.mid, 12);
});

test('passes a verified identity alias through the rank patch builder', () => {
  const result = buildEducationRankPatch({...aliasedInput(), ranking: RANKING});
  assert.deepEqual(result.patch, {'学历': '本科', '院校': '示例大学（18）'});
});

test('rejects identity aliases with a different source digest, UID, or message mid', () => {
  assert.throws(() => extractEducation(aliasedInput({sourceSha256: 'c'.repeat(64)})), /sourceSha256/i);
  assert.throws(() => extractEducation(aliasedInput({uid: 102})), /UID/i);
  assert.throws(() => extractEducation(aliasedInput({mid: 13})), /mid/i);
});

test('rejects a profile-name mismatch when no explicit identity alias is supplied', () => {
  const {identityAlias, ...withoutAlias} = aliasedInput();
  assert.ok(identityAlias);
  assert.throws(() => extractEducation(withoutAlias), /name mismatch/i);
});

test('requires snapshot candidate name to remain the candidate name when using an alias', () => {
  const aliased = aliasedInput();
  aliased.snapshot.candidate.name = '简历姓名';
  assert.throws(() => extractEducation(aliased), /snapshot candidate name mismatch/i);
});

test('does not allow an alias card with a different sender UID or job', () => {
  const wrongUid = aliasedInput({}, {...CANDIDATE, uid: 102, name: '简历姓名'});
  assert.throws(() => extractEducation(wrongUid), /sender UID mismatch/i);
  const wrongJob = aliasedInput({}, {...CANDIDATE, jobId: '8', name: '简历姓名'});
  assert.throws(() => extractEducation(wrongJob), /jobId mismatch/i);
});

test('does not interpret numeric education enums', () => {
  const result = extractEducation(input([resumeMessage({degree: 3})]));
  assert.equal(result.values.degree, undefined);
  assert.equal(result.unknown.degree, 'unrecognized_explicit_degree');
});

test('conflicting explicit degree strings remain unknown', () => {
  const result = extractEducation(input([resumeMessage({degree: '本科', educationName: '硕士'})]));
  assert.equal(result.values.degree, undefined);
  assert.equal(result.conflicts[0].field, 'degree');
  assert.deepEqual(result.conflicts[0].values, ['本科', '硕士']);
});

test('school evidence alone never implies the candidate degree', () => {
  const result = extractEducation(input([resumeMessage({school: '示例大学'})]));
  assert.equal(result.values.school, '示例大学');
  assert.equal(result.values.degree, undefined);
  assert.equal(result.unknown.degree, 'missing_explicit_degree');
});

test('falls back to an education experience organization without changing its name', () => {
  const result = extractEducation(input([resumeMessage({experiences: [
    {type: 2, organization: '示例大学信息工程学院（东校区）'},
  ]})]));
  assert.equal(result.values.school, '示例大学信息工程学院（东校区）');
  assert.equal(result.evidence.school[0].path, 'body.resume.experiences[0].organization');
});

test('falls back when school aliases contain only the unknown placeholder', () => {
  const result = extractEducation(input([resumeMessage({school: '未知', experiences: [
    {type: 2, organization: '示例大学'},
  ]})]));
  assert.equal(result.values.school, '示例大学');
});

test('ignores non-education experience organizations as school evidence', () => {
  const result = extractEducation(input([resumeMessage({experiences: [
    {type: 1, organization: '示例大学'},
    {type: 3, organization: '另一所大学'},
  ]})]));
  assert.equal(result.values.school, undefined);
  assert.equal(result.unknown.school, 'missing_explicit_school');
});

test('conflicting education experience schools remain unknown', () => {
  const result = extractEducation(input([resumeMessage({experiences: [
    {type: 2, organization: '示例大学'},
    {type: 2, organization: '另一所大学'},
  ]})]));
  assert.equal(result.values.school, undefined);
  assert.equal(result.conflicts.find(conflict => conflict.field === 'school').reason, 'conflicting_explicit_school');
});

test('reads history.messages and top-level messages snapshots', () => {
  const message = resumeMessage({degreeName: '博士'});
  const base = input([]);
  const history = extractEducation({...base, snapshot: {candidate: {...CANDIDATE}, history: {messages: [message]}}});
  const topLevel = extractEducation({...base, snapshot: {candidate: {...CANDIDATE}, messages: [message]}});
  assert.equal(history.values.degree, '博士');
  assert.equal(topLevel.values.degree, '博士');
});

test('uses the exact matching school name and verified rank', () => {
  const messages = [resumeMessage({school: '示例大学', degreeName: '大专'})];
  const ranking = {...RANKING, entries: [
    {name: '示例大学（东校区）', rank: 2},
    {name: '示例大学', rank: 18},
  ]};
  const result = buildEducationRankPatch({...input(messages), ranking});
  assert.deepEqual(result.patch, {'学历': '专科', '院校': '示例大学（18）'});
  assert.equal(result.evidence['院校'].ranking.rank, 18);
});

test('labels non-main ranking categories in the displayed school value', () => {
  const ranking = {...RANKING, category: '中国大学排名（医药类）'};
  const result = buildEducationRankPatch({
    ...input([resumeMessage({schoolName: '示例大学'})]),
    ranking,
  });
  assert.equal(result.patch['院校'], '示例大学（18，中国大学排名（医药类））');
});

test('updates an existing numeric rank only for the same exact school', () => {
  const result = buildEducationRankPatch({
    ...input([resumeMessage({school: '示例大学'})]),
    currentValues: {'院校': '示例大学（55）'},
    ranking: {...RANKING, entries: [{name: '示例大学', rank: '10–20'}]},
  });
  assert.equal(result.patch['院校'], '示例大学（10–20）');
});

test('preserves an official lower-bound rank without presenting it as an exact rank', () => {
  const result = buildEducationRankPatch({
    ...input([resumeMessage({school: '示例大学'})]),
    ranking: {...RANKING, entries: [{name: '示例大学', rank: '501+'}]},
  });
  assert.equal(result.patch['院校'], '示例大学（501+）');
  assert.equal(result.evidence['院校'].ranking.rank, '501+');
});

test('recognizes existing same-school lower-bound and range ranks for idempotent updates', () => {
  for (const rank of ['501+', '301–350']) {
    const result = buildEducationRankPatch({
      ...input([resumeMessage({school: '示例大学'})]),
      currentValues: {'院校': `示例大学（${rank}）`},
      ranking: {...RANKING, entries: [{name: '示例大学', rank}]},
    });
    assert.deepEqual(result.patch, {});
    assert.deepEqual(result.conflicts, []);
  }

  const updated = buildEducationRankPatch({
    ...input([resumeMessage({school: '示例大学'})]),
    currentValues: {'院校': '示例大学（301–350）'},
    ranking: {...RANKING, entries: [{name: '示例大学', rank: '501+'}]},
  });
  assert.equal(updated.patch['院校'], '示例大学（501+）');
});

test('fills only education fields and leaves existing scores outside the patch', () => {
  const currentValues = {'能力评分': 82, '院校评分': 91, '学历': '本科', '院校': '示例大学'};
  const result = buildEducationRankPatch({
    ...input([resumeMessage({school: '示例大学', degree: '本科'})]),
    currentValues,
    ranking: RANKING,
  });
  assert.deepEqual(result.patch, {'院校': '示例大学（18）'});
  assert.deepEqual(currentValues, {'能力评分': 82, '院校评分': 91, '学历': '本科', '院校': '示例大学'});
  assert.deepEqual(Object.keys(result), ['patch', 'evidence', 'conflicts', 'unavailable']);
});

test('preserves conflicting current education and school values', () => {
  const result = buildEducationRankPatch({
    ...input([resumeMessage({school: '示例大学', degree: '本科'})]),
    currentValues: {'学历': '硕士', '院校': '另一所大学'},
    ranking: RANKING,
  });
  assert.deepEqual(result.patch, {});
  assert.deepEqual(result.conflicts.map(conflict => conflict.field), ['学历', '院校']);
});

test('validates ranking origin, digest, and actual positive ranks', () => {
  const base = {...input([resumeMessage({school: '示例大学'})]), ranking: RANKING};
  assert.throws(() => buildEducationRankPatch({...base, ranking: {...RANKING, sourceUrl: 'https://shanghairanking.cn.evil.test/rankings/2026'}}), /official/i);
  assert.throws(() => buildEducationRankPatch({...base, ranking: {...RANKING, sourceSha256: 'bad'}}), /SHA-256/i);
  assert.throws(() => buildEducationRankPatch({...base, ranking: {...RANKING, entries: [{name: '示例大学', rank: '第18名'}]}}), /rank/i);
});

test('a previously displayed same-category school rank is idempotent', () => {
  const result=buildEducationRankPatch({...input([resumeMessage({school:'示例大学',degree:'本科'})]),
    currentValues:{'院校':'示例大学（18，中国民办高校排名（主榜））','学历':'本科'},
    ranking:{...RANKING,category:'中国民办高校排名（主榜）'}});
  assert.deepEqual(result.patch,{});assert.deepEqual(result.conflicts,[]);
});
