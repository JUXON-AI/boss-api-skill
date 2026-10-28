import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {buildTalentCreateValues, buildTalentProfilePatch, readVerifiedGenderMapping, readVerifiedProfileFields} from './talent_profile_fields.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, profileName = 'Sample A') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-fields-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('profile-fields-fixture-'));
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const candidate = {uid: 101, name: 'Sample A', jobId: '7'};
  const snapshot = {candidate: {...candidate}, history: {original_order_redacted: [{mid: 11, time: 1790000000000, from: {uid: 101}, body: {resume: {user: {uid: 101, name: profileName}, jobId: 7, age: '23', gender: 0, experiences: [{type: 2, organization: '示例大学'}]}}}]}};
  const source = path.join(dir, 'history.json');fs.writeFileSync(source, JSON.stringify(snapshot));
  const sourceSha256 = hash(fs.readFileSync(source));
  const expression = '1===this.item.gender?"男":0===this.item.gender?"女":""';
  const mappingSource = path.join(dir, 'client.js');fs.writeFileSync(mappingSource, '/* fixture */'+expression);
  const mapping = {verified: true, values: {'0': '女', '1': '男'}, source: mappingSource, sourceSha256: hash(fs.readFileSync(mappingSource)), evidence: {offset: 13, expression}};
  const genderMappingFile = path.join(dir, 'mapping.json');fs.writeFileSync(genderMappingFile, JSON.stringify(mapping));
  return {candidate, source, sourceSha256, genderMappingFile, snapshot, mapping, dir};
}
test('verified original bytes produce only fill-only descriptive Base fields', t => {
  const f = fixture(t);const result = buildTalentProfilePatch({...f, currentValues: {'年龄': null, '性别': ['未知'], '院校': '示例大学', '能力评分': 76, 'HR复核状态': ['待复核'], '最终联系时间': '2026-10-01 10:00:00'}});
  assert.deepEqual(result.patch, {'年龄': 23, '性别': '女'});assert.deepEqual(result.unchanged, {'院校': '示例大学'});
  assert.equal(result.evidence['年龄'].sourceSha256, f.sourceSha256);assert.equal(result.evidence['年龄'].mid, 11);
  assert.ok(!Object.hasOwn(result.patch, '院校评分'));assert.ok(!Object.hasOwn(result.patch, '能力评分'));
});
test('changed original history is rejected before planning a write', t => {
  const f = fixture(t);fs.appendFileSync(f.source, ' ');assert.throws(() => buildTalentProfilePatch(f), /source bytes changed/);
});
test('changed mapping code or swapped labels cannot use a verified flag as proof', t => {
  const f = fixture(t);f.mapping.values['0']='男';fs.writeFileSync(f.genderMappingFile, JSON.stringify(f.mapping));assert.throws(() => readVerifiedGenderMapping(f.genderMappingFile), /enum labels/);
  f.mapping.values['0']='女';fs.writeFileSync(f.genderMappingFile, JSON.stringify(f.mapping));fs.appendFileSync(f.mapping.source, ' ');assert.throws(() => readVerifiedGenderMapping(f.genderMappingFile), /source bytes changed/);
});
test('an existing confirmed demographic or school value is preserved as a conflict', t => {
  const f=fixture(t);const p=buildTalentProfilePatch({...f,currentValues:{'年龄':24,'性别':['男'],'院校':'另一所示例学校'}});assert.deepEqual(p.patch,{});assert.equal(p.conflicts.length,3);
});
test('a card name mismatch requires explicit same-snapshot contact evidence', t => {
  const f=fixture(t,'求职者');assert.throws(()=>readVerifiedProfileFields(f),/explicit identity evidence/);
  const aliasesFile=path.join(f.dir,'aliases.json');const alias={uid:101,jobId:'7',candidateName:'Sample A',profileName:'求职者',source:f.source,sourceSha256:f.sourceSha256};fs.writeFileSync(aliasesFile,JSON.stringify({accepted:[alias]}));
  const result=readVerifiedProfileFields({...f,aliasesFile});assert.equal(result.candidate.name,'Sample A');assert.equal(result.identityAliasEvidence.profileName,'求职者');assert.equal(result.values.age,23);
});
test('an alias cannot authorize a different snapshot contact', t => {
  const f=fixture(t,'求职者');f.snapshot.candidate.name='Other';fs.writeFileSync(f.source,JSON.stringify(f.snapshot));f.sourceSha256=hash(fs.readFileSync(f.source));
  const aliasesFile=path.join(f.dir,'aliases.json');fs.writeFileSync(aliasesFile,JSON.stringify({accepted:[{uid:101,jobId:'7',candidateName:'Sample A',profileName:'求职者',source:f.source,sourceSha256:f.sourceSha256}]}));assert.throws(()=>readVerifiedProfileFields({...f,aliasesFile}),/contact name mismatch/);
});

test('create payload hook fills confirmed fields and preserves all unrelated values', t => {
  const f=fixture(t);const values={'姓名':'Sample A','院校':'示例大学','能力评分':76,'HR复核状态':'待复核','最终联系时间':'2026-10-01 10:00:00'};
  const result=buildTalentCreateValues({...f,values});
  assert.deepEqual(result.values,{...values,'年龄':23,'性别':'女'});
  assert.equal(result.writtenFields,7);assert.deepEqual(result.omittedFields,['现居地','附件']);
  assert.equal(Object.hasOwn(values,'年龄'),false);
  assert.throws(()=>buildTalentCreateValues({...f,values:{...values,'院校':'另一示例大学'}}),/conflict/);
  const missing=buildTalentCreateValues({...f,values:{...values,'院校评分':undefined,'附件':undefined}});
  assert.equal(missing.writtenFields,7);assert.deepEqual(missing.omittedFields,['现居地','附件']);
  const legacyValues={...values,'院校评分':91};
  const migrated=buildTalentCreateValues({...f,values:legacyValues});
  assert.equal(Object.hasOwn(migrated.values,'院校评分'),false);
  assert.equal(migrated.values['能力评分'],76);
  assert.equal(legacyValues['院校评分'],91);
});

test('unsafe numeric contact IDs cannot pass the I/O identity check after JSON rounding', t => {
  const f=fixture(t);const rounded=9007199254740992;
  f.candidate.uid=String(rounded);f.snapshot.candidate.uid=rounded;
  f.snapshot.history.original_order_redacted[0].from.uid=String(rounded);
  f.snapshot.history.original_order_redacted[0].body.resume.user.uid=String(rounded);
  fs.writeFileSync(f.source,JSON.stringify(f.snapshot));f.sourceSha256=hash(fs.readFileSync(f.source));
  assert.throws(()=>readVerifiedProfileFields(f),/UID mismatch/);
});

test('create hook fills explicit education and official rank with verified original bytes', t => {
  const f=fixture(t);f.snapshot.history.original_order_redacted[0].body.resume.education='硕士';
  fs.writeFileSync(f.source,JSON.stringify(f.snapshot));f.sourceSha256=hash(fs.readFileSync(f.source));
  const rawFile=path.join(f.dir,'official.json');fs.writeFileSync(rawFile,JSON.stringify({code:200,data:{rankings:[{univNameCn:'示例大学',ranking:'18'}]}}));
  const rankingFile=path.join(f.dir,'ranking.json');fs.writeFileSync(rankingFile,JSON.stringify({year:2026,category:'中国大学排名（主榜）',sourceUrl:'https://www.shanghairanking.cn/rankings/bcur/2026',sourceSha256:hash(fs.readFileSync(rawFile)),entries:[{name:'示例大学',rank:18}]}));
  const educationPolicyFile=path.join(f.dir,'education-policy.json');fs.writeFileSync(educationPolicyFile,JSON.stringify({year:2026,catalogs:[{file:rankingFile,sha256:hash(fs.readFileSync(rankingFile)),rawFile}]}));
  const values={'姓名':'Sample A','院校':'示例大学','能力评分':76,'HR复核状态':'待复核'};
  const result=buildTalentCreateValues({...f,values,educationPolicyFile});
  assert.equal(result.values['学历'],'硕士');assert.equal(result.values['院校'],'示例大学（18）');
  assert.equal(result.values['能力评分'],76);assert.equal(result.values['HR复核状态'],'待复核');
  fs.appendFileSync(rawFile,' ');
  assert.throws(()=>buildTalentCreateValues({...f,values,educationPolicyFile}),/source bytes changed/);
});
