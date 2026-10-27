import test from 'node:test';
import assert from 'node:assert/strict';
import {planLocationFieldPatch} from './location_fields.mjs';

const candidate = {uid: 101, name: 'Candidate A', jobId: 'job-1'};
const sourceSha256 = 'a'.repeat(64);
const schoolSourceSha256 = 'b'.repeat(64);

function currentResidence(evidenceOverrides = {}, recordOverrides = {}) {
  return {
    kind: 'current_residence',
    evidence: {
      uid: candidate.uid,
      name: candidate.name,
      jobId: candidate.jobId,
      source: 'public-profile.json',
      sourceSha256,
      location: '上海',
      ...evidenceOverrides,
    },
    ...recordOverrides,
  };
}

function schoolDefault(evidenceOverrides = {}, recordOverrides = {}) {
  return {
    kind: 'school_location',
    evidence: {
      uid: candidate.uid,
      name: candidate.name,
      jobId: candidate.jobId,
      source: 'school-profile.json',
      sourceSha256: schoolSourceSha256,
      location: '杭州',
      ...evidenceOverrides,
    },
    school: '示例大学',
    sourceURL: 'https://www.example.edu.cn/campuses/hangzhou',
    ambiguity: false,
    ...recordOverrides,
  };
}

test('verified current residence wins and carries a visible source label', () => {
  const result = planLocationFieldPatch({
    candidate,
    currentResidence: currentResidence(),
    schoolDefault: schoolDefault(),
    useSchoolDefault: true,
  });

  assert.deepEqual(result.patch, {'现居地': '上海（资料现居地）'});
  assert.equal(result.status, 'confirmed');
  assert.equal(result.evidence.kind, 'current_residence');
  assert.equal(result.evidence.location, '上海');
  assert.equal(Object.hasOwn(result, 'reason'), false);
});

test('school location is used only when enabled and is visibly labelled as a default', () => {
  const disabled = planLocationFieldPatch({candidate, schoolDefault: schoolDefault()});
  assert.deepEqual(disabled.patch, {});
  assert.equal(disabled.status, 'unknown');
  assert.equal(disabled.reason, 'school_default_not_enabled');

  const enabled = planLocationFieldPatch({
    candidate,
    schoolDefault: {
      kind: 'school_location',
      uid: candidate.uid,
      name: candidate.name,
      jobId: candidate.jobId,
      source: 'school-profile.json',
      sourceSha256: schoolSourceSha256,
      location: '杭州',
      school: '示例大学',
      sourceURL: 'https://www.example.edu.cn/campuses/hangzhou',
      ambiguity: false,
    },
    useSchoolDefault: true,
  });
  assert.deepEqual(enabled.patch, {'现居地': '杭州（学校所在地默认）'});
  assert.equal(enabled.status, 'school_default');
  assert.equal(enabled.evidence.school, '示例大学');
});

test('ambiguous or unverified school cities remain unknown without guessing', () => {
  for (const value of [
    schoolDefault({}, {ambiguity: true}),
    schoolDefault({location: ''}, {ambiguity: false}),
  ]) {
    const result = planLocationFieldPatch({
      candidate,
      schoolDefault: value,
      useSchoolDefault: true,
    });
    assert.deepEqual(result.patch, {});
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'school_location_unverified');
  }
});

test('expected city is rejected as residence evidence while absent evidence stays unknown', () => {
  assert.throws(() => planLocationFieldPatch({
    candidate,
    expectedLocation: '深圳',
    currentResidence: {
      kind: 'expected_location',
      evidence: {
        uid: candidate.uid,
        name: candidate.name,
        jobId: candidate.jobId,
        source: 'job.json',
        sourceSha256,
        location: '深圳',
      },
    },
  }), /currentResidence\.kind/);

  const absent = planLocationFieldPatch({candidate});
  assert.deepEqual(absent.patch, {});
  assert.equal(absent.status, 'unknown');
  assert.equal(absent.evidence, null);
});

test('an existing value is preserved as unchanged or conflict, never overwritten', () => {
  const same = planLocationFieldPatch({
    candidate,
    currentValue: '上海（资料现居地）',
    currentResidence: currentResidence(),
  });
  assert.deepEqual(same.patch, {});
  assert.equal(same.status, 'unchanged');
  assert.equal(same.reason, 'current_value_matches');

  const different = planLocationFieldPatch({
    candidate,
    currentValue: '北京（资料现居地）',
    currentResidence: currentResidence(),
  });
  assert.deepEqual(different.patch, {});
  assert.equal(different.status, 'conflict');
  assert.equal(different.reason, 'non_empty_current_value_differs');
});

test('blank current values are treated as empty and are fillable', () => {
  for (const currentValue of [undefined, null, '', '   ', '\t\n']) {
    const result = planLocationFieldPatch({
      candidate,
      currentValue,
      currentResidence: currentResidence(),
    });
    assert.deepEqual(result.patch, {'现居地': '上海（资料现居地）'}, String(currentValue));
    assert.equal(result.status, 'confirmed', String(currentValue));
  }
});

test('identity, source hash, source, kind, and school source URL fail closed', () => {
  for (const [field, value] of [
    ['uid', 999],
    ['name', 'Candidate B'],
    ['jobId', 'job-2'],
  ]) {
    assert.throws(
      () => planLocationFieldPatch({
        candidate,
        currentResidence: currentResidence({[field]: value}),
      }),
      /does not match/,
      field,
    );
  }

  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      currentResidence: currentResidence({sourceSha256: 'not-a-sha256'}),
    }),
    /64-character SHA-256/,
  );
  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      currentResidence: currentResidence({source: '  '}),
    }),
    /source is required/,
  );
  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      currentResidence: currentResidence({}, {kind: 'ip_location'}),
    }),
    /currentResidence\.kind/,
  );
  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      schoolDefault: schoolDefault({}, {kind: 'work_location'}),
    }),
    /schoolDefault\.kind/,
  );
  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      schoolDefault: schoolDefault({}, {school: ''}),
      useSchoolDefault: true,
    }),
    /school is required/,
  );
  assert.throws(
    () => planLocationFieldPatch({
      candidate,
      schoolDefault: schoolDefault({}, {sourceURL: 'file:///private/source'}),
      useSchoolDefault: true,
    }),
    /HTTP\(S\) geography source URL/,
  );
});

