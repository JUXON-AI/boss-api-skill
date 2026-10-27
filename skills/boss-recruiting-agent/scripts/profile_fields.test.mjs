import test from 'node:test';
import assert from 'node:assert/strict';
import {extractProfileFields, planProfileFieldPatch} from './profile_fields.mjs';

const candidate = {uid: 101, name: 'Candidate A', jobId: 'job-1'};
const sha = 'a'.repeat(64);

function card({
  mid = 1,
  time = 1_700_000_000_000,
  fromUid = candidate.uid,
  userUid = candidate.uid,
  name = candidate.name,
  jobId = candidate.jobId,
  age,
  gender,
  school,
  schoolName,
  experiences = [],
} = {}) {
  const resume = {
    user: {uid: userUid, name},
    jobId,
    experiences,
  };
  if (age !== undefined) resume.age = age;
  if (gender !== undefined) resume.gender = gender;
  if (school !== undefined) resume.school = school;
  if (schoolName !== undefined) resume.schoolName = schoolName;
  return {mid, time, from: {uid: fromUid}, body: {resume}};
}

function snapshot(messages, source = 'snapshot-a') {
  return {source, sourceSha256: sha, messages};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

test('extracts age labels without deriving from unrelated resume fields', () => {
  const result = extractProfileFields({
    candidate,
    snapshots: [snapshot([
      card({
        age: '24岁',
        gender: '女',
        school: '示例大学',
        experiences: [
          {type: 2, organization: '示例大学'},
          {type: 1, organization: '不应采用的经历'},
        ],
      }),
    ])],
  });

  assert.deepEqual(result.values, {age: 24, gender: '女', school: '示例大学'});
  assert.deepEqual(Object.keys(result.evidence.age).sort(), [
    'mid', 'path', 'rawValue', 'source', 'sourceSha256',
  ]);
  assert.equal(result.evidence.age.mid, 1);
  assert.equal(result.evidence.age.path, 'body.resume.age');
  assert.equal(result.evidence.age.rawValue, '24岁');
  assert.deepEqual(result.conflicts, []);
});

test('missing, zero, malformed, fractional, and out-of-range ages stay unknown', () => {
  const missing = extractProfileFields({
    candidate,
    snapshots: [snapshot([card()])],
  });
  assert.equal(hasOwn(missing.values, 'age'), false);
  assert.equal(missing.unknown.age, 'missing');

  const invalidCases = [null, '', 0, '0', -1, '24周岁', 24.5, '24.0', 121, NaN, Infinity];
  for (const [index, age] of invalidCases.entries()) {
    const result = extractProfileFields({
      candidate,
      snapshots: [snapshot([card({mid: index + 1, age})])],
    });
    assert.equal(hasOwn(result.values, 'age'), false, `age fixture ${String(age)}`);
    assert.equal(result.unknown.age, 'invalid_age', `age fixture ${String(age)}`);
  }
});

test('ages come only from age and accept pure numeric strings', () => {
  const unrelated = card();
  unrelated.body.resume.birthday = '2000-01-01';
  unrelated.body.resume.graduationYear = 2023;
  unrelated.body.resume.nameAge = 24;

  const missing = extractProfileFields({candidate, snapshots: [snapshot([unrelated])]});
  assert.equal(missing.unknown.age, 'missing');

  const numericString = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({age: '28'})])],
  });
  assert.equal(numericString.values.age, 28);
});

test('resume cards with any identity mismatch fail closed', () => {
  const mismatches = [
    card({fromUid: 999}),
    card({userUid: 999}),
    card({name: 'Candidate B'}),
    card({jobId: 'job-2'}),
  ];
  for (const message of mismatches) {
    assert.throws(
      () => extractProfileFields({candidate, snapshots: [snapshot([message])]}),
      /does not match/,
    );
  }

  const unrelated = {mid: 9, time: 1_700_000_100_000, from: {uid: 999}, body: {text: 'unrelated'}};
  const result = extractProfileFields({
    candidate,
    snapshots: [snapshot([unrelated, card({age: 30})])],
  });
  assert.equal(result.values.age, 30);
});

test('unmapped numeric gender values including zero are unknown', () => {
  for (const gender of [0, 1, 2]) {
    const result = extractProfileFields({
      candidate,
      snapshots: [snapshot([card({mid: gender + 1, gender})])],
    });
    assert.equal(hasOwn(result.values, 'gender'), false, `gender ${gender}`);
    assert.equal(result.unknown.gender, 'unverified_numeric_gender_mapping');
  }

  const unverified = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({gender: 1})])],
    genderMapping: {values: {1: '男'}, source: 'fixture', sourceSha256: sha, verified: false},
  });
  assert.equal(unverified.unknown.gender, 'unverified_numeric_gender_mapping');
});

test('verified mappings support an explicit zero-to-female mapping', () => {
  const mapping = {
    values: {0: '女', 1: '男', 3: '其他', 4: '未知'},
    source: 'verified-private-mapping',
    sourceSha256: sha,
    verified: true,
  };

  const zero = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({gender: 0})])],
    genderMapping: mapping,
  });
  assert.equal(zero.values.gender, '女');
  assert.equal(zero.evidence.gender.rawValue, 0);
  assert.equal(zero.evidence.gender.path, 'body.resume.gender');

  const other = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({gender: 3})])],
    genderMapping: mapping,
  });
  assert.equal(other.values.gender, '其他');

  const unmapped = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({gender: 9})])],
    genderMapping: mapping,
  });
  assert.equal(unmapped.unknown.gender, 'unmapped_numeric_gender');

  const invalidLabel = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({gender: 4})])],
    genderMapping: mapping,
  });
  assert.equal(invalidLabel.unknown.gender, 'invalid_gender_mapping_label');
});

test('schools come from explicit fields or one education organization and ambiguity is a conflict', () => {
  const explicit = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({schoolName: '明确院校'})])],
  });
  assert.equal(explicit.values.school, '明确院校');
  assert.equal(explicit.evidence.school.path, 'body.resume.schoolName');

  const uniqueEducation = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({
      experiences: [
        {type: 1, organization: '公司'},
        {type: 2, organization: '唯一院校'},
      ],
    })])],
  });
  assert.equal(uniqueEducation.values.school, '唯一院校');
  assert.equal(uniqueEducation.evidence.school.path, 'body.resume.experiences[1].organization');

  const ambiguous = extractProfileFields({
    candidate,
    snapshots: [snapshot([card({
      experiences: [
        {type: 2, organization: '院校甲'},
        {type: 2, organization: '院校乙'},
      ],
    })])],
  });
  assert.equal(hasOwn(ambiguous.values, 'school'), false);
  assert.equal(ambiguous.conflicts[0].field, 'school');
  assert.equal(ambiguous.conflicts[0].reason, 'multiple_schools_without_primary');
  assert.equal(ambiguous.conflicts[0].evidence.length, 2);
});

test('latest non-missing field wins without allowing new missing values to erase old data', () => {
  const oldCard = card({mid: 1, time: 1_700_000_000_000, age: 22, gender: '男', school: '旧院校'});
  const newCard = card({mid: 2, time: 1_700_000_100_000, age: undefined, gender: '女', school: '新院校'});
  const result = extractProfileFields({
    candidate,
    snapshots: [
      snapshot([oldCard], 'old'),
      snapshot([newCard], 'new'),
    ],
  });

  assert.equal(result.values.age, 22);
  assert.equal(result.evidence.age.source, 'old');
  assert.equal(result.values.gender, '女');
  assert.equal(result.values.school, '新院校');
});

test('different values at the same latest time conflict instead of being guessed', () => {
  const result = extractProfileFields({
    candidate,
    snapshots: [snapshot([
      card({mid: 1, time: 1_700_000_100_000, age: 25, gender: '男'}),
      card({mid: 2, time: 1_700_000_100_000, age: 26, gender: '女'}),
    ])],
  });

  assert.equal(hasOwn(result.values, 'age'), false);
  assert.equal(hasOwn(result.values, 'gender'), false);
  assert.deepEqual(result.conflicts.map(item => item.field), ['age', 'gender']);
  assert.ok(result.conflicts.every(item => item.reason === 'same_latest_time_different_values'));
});

test('matching values at the same time do not fabricate a conflict', () => {
  const result = extractProfileFields({
    candidate,
    snapshots: [snapshot([
      card({mid: 1, time: 1_700_000_100_000, age: '30岁'}),
      card({mid: 2, time: 1_700_000_100_000, age: 30}),
    ])],
  });
  assert.equal(result.values.age, 30);
  assert.equal(result.conflicts.length, 0);
});

test('patch planning only fills empty canonical fields and preserves other metadata', () => {
  const metadata = {
    ...extractProfileFields({candidate, snapshots: [snapshot([card({age: 31, gender: '女', school: '示例院校'})])]}),
    score: 99,
    hrStatus: 'do-not-copy',
    contactTime: 'do-not-copy',
  };
  const currentValues = {
    age: 30,
    gender: '女',
    school: null,
    score: 12,
    hrStatus: 'keep-current',
    contactTime: 'keep-current',
  };

  const plan = planProfileFieldPatch({candidate, currentValues, metadata});
  assert.deepEqual(plan.patch, {school: '示例院校'});
  assert.deepEqual(plan.unchanged, {gender: '女'});
  assert.deepEqual(plan.conflicts, [{
    field: 'age',
    reason: 'non_empty_current_value_differs',
    currentValue: 30,
    incomingValue: 31,
  }]);
  assert.deepEqual(plan.unavailable, {});
  assert.equal(hasOwn(plan.patch, 'score'), false);
  assert.equal(hasOwn(plan.patch, 'hrStatus'), false);
  assert.equal(hasOwn(plan.patch, 'contactTime'), false);
});

test('patch planning treats only null, undefined, empty string, and empty arrays as fillable', () => {
  const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({age: 24, gender: '男', school: '院校'})])]});
  const plan = planProfileFieldPatch({
    candidate,
    currentValues: {age: '', gender: undefined, school: []},
    metadata,
  });
  assert.deepEqual(plan.patch, {age: 24, gender: '男', school: '院校'});

  const zeroIsNotEmpty = planProfileFieldPatch({
    candidate,
    currentValues: {age: 0},
    metadata,
  });
  assert.equal(hasOwn(zeroIsNotEmpty.patch, 'age'), false);
  assert.equal(zeroIsNotEmpty.conflicts[0].field, 'age');
});

test('age validation accepts the full 1..120 range without recruiting thresholds', () => {
  for (const age of [1, '15岁', 16, 101, 120]) {
    const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({age})])]});
    assert.equal(metadata.values.age, Number(String(age).replace('岁', '')));
    assert.equal(planProfileFieldPatch({candidate, metadata}).patch.age, metadata.values.age);
  }
});

test('extract carries a copied identity and plan requires the matching target identity', () => {
  const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({age: 24})])]});
  assert.deepEqual(metadata.candidate, candidate);
  assert.notEqual(metadata.candidate, candidate);
  for (const target of [
    {...candidate, uid: 102}, {...candidate, name: 'Candidate B'}, {...candidate, jobId: 'job-2'},
  ]) {
    assert.throws(() => planProfileFieldPatch({candidate: target, metadata}), /does not match/);
  }
  assert.throws(() => planProfileFieldPatch({metadata}), /candidate/);
});

test('plan rejects bare metadata and incomplete or incompatible evidence', () => {
  assert.throws(() => planProfileFieldPatch({candidate, metadata: {age: 24}}), /metadata/);
  const extracted = extractProfileFields({candidate, snapshots: [snapshot([card({age: 24})])]});
  for (const field of ['source', 'sourceSha256', 'mid', 'path', 'rawValue']) {
    const metadata = structuredClone(extracted);
    delete metadata.evidence.age[field];
    assert.throws(() => planProfileFieldPatch({candidate, metadata}), /evidence/);
  }
  for (const evidence of [{}, {age: {mid: 1}}]) {
    assert.throws(() => planProfileFieldPatch({candidate, metadata: {...extracted, evidence}}), /evidence/);
  }
  for (const change of [{rawValue: 99}, {path: 'body.resume.birthday'}, {sourceSha256: 'not-a-hash'}]) {
    const metadata = structuredClone(extracted);
    Object.assign(metadata.evidence.age, change);
    assert.throws(() => planProfileFieldPatch({candidate, metadata}), /evidence/);
  }
});

test('an unsortable field observation blocks old values while missing fields do not', () => {
  for (const time of [undefined, null, '', 'not-a-time', 0]) {
    for (const age of [24, 0]) {
      const bad = card({mid: 2, age});
      bad.time = time;
      const metadata = extractProfileFields({candidate, snapshots: [snapshot([
        card({age: 20, gender: '女', school: '旧院校'}), bad,
      ])]});
      assert.equal(metadata.values.age, undefined);
      assert.equal(metadata.unknown.age, 'invalid_message_time');
      assert.equal(metadata.values.gender, '女');
      assert.equal(metadata.values.school, '旧院校');
    }
  }
  const metadata = extractProfileFields({candidate, snapshots: [snapshot([
    card({age: 20, gender: '女', school: '旧院校'}),
    card({mid: 2, time: 'bad', gender: '男', school: '新院校'}),
  ])]});
  assert.equal(metadata.values.age, 20);
  assert.equal(metadata.unknown.gender, 'invalid_message_time');
  assert.equal(metadata.unknown.school, 'invalid_message_time');
});

test('identifiers compare by String with no trimming or unsafe numeric identities', () => {
  const target = {...candidate, uid: '101', jobId: '42'};
  const metadata = extractProfileFields({candidate: target, snapshots: [snapshot([card({jobId: 42, age: 24})])]});
  assert.equal(metadata.values.age, 24);
  assert.equal(planProfileFieldPatch({candidate: {...target, uid: 101, jobId: 42}, metadata}).patch.age, 24);
  for (const jobId of [' 42', '042', '42 ', 43]) {
    assert.throws(() => extractProfileFields({candidate: target, snapshots: [snapshot([card({jobId})])]}), /does not match/);
  }
  for (const uid of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, {}, '', '   ', true, 1.5]) {
    assert.throws(() => extractProfileFields({candidate: {...target, uid}, snapshots: []}), /candidate.uid/);
  }
});

test('unknown gender and school placeholders are fillable but confirmed facts are protected', () => {
  const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({age: 24, gender: '女', school: '示例大学'})])]});
  for (const placeholder of ['未知', ['未知']]) {
    const plan = planProfileFieldPatch({candidate, metadata, currentValues: {age: placeholder, gender: placeholder, school: placeholder}});
    assert.deepEqual(plan.patch, {gender: '女', school: '示例大学'});
    assert.deepEqual(plan.conflicts.map(item => item.field), ['age']);
  }
  for (const gender of ['男', '其他', ['男']]) {
    const plan = planProfileFieldPatch({candidate, metadata, currentValues: {gender, school: '其他大学'}});
    assert.deepEqual(plan.conflicts.map(item => item.field), ['gender', 'school']);
  }
});

test('mapped gender evidence carries its mapping source and is required by the planner', () => {
  const genderMapping = {values: {0: '女'}, source: 'fixture-mapping-source', sourceSha256: 'b'.repeat(64), verified: true};
  const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({gender: 0})])], genderMapping});
  assert.deepEqual(metadata.evidence.gender.genderMapping, {
    source: genderMapping.source, sourceSha256: genderMapping.sourceSha256, code: 0, label: '女',
  });
  assert.deepEqual(planProfileFieldPatch({candidate, metadata}).patch, {gender: '女'});
  for (const key of ['source', 'sourceSha256', 'code', 'label']) {
    const broken = structuredClone(metadata);
    delete broken.evidence.gender.genderMapping[key];
    assert.throws(() => planProfileFieldPatch({candidate, metadata: broken}), /evidence/);
  }
  const broken = structuredClone(metadata);
  delete broken.evidence.gender.genderMapping;
  assert.throws(() => planProfileFieldPatch({candidate, metadata: broken}), /evidence/);
});

test('unknown school placeholders never shadow a real explicit or education institution', () => {
  for (const placeholder of ['未知', '  未知\t']) {
    for (const field of ['school', 'schoolName']) {
      const metadata = extractProfileFields({candidate, snapshots: [snapshot([card({
        [field]: placeholder,
        experiences: [
          {type: 2, organization: ' 未知 '},
          {type: 2, organization: ' 示例大学 '},
        ],
      })])]});
      assert.equal(metadata.values.school, ' 示例大学 ');
      assert.equal(metadata.evidence.school.path, 'body.resume.experiences[1].organization');
      assert.equal(metadata.evidence.school.rawValue, ' 示例大学 ');
      assert.deepEqual(metadata.conflicts, []);
      assert.deepEqual(planProfileFieldPatch({candidate, metadata}).patch, {school: ' 示例大学 '});
    }
    const explicit = extractProfileFields({candidate, snapshots: [snapshot([card({
      school: placeholder, schoolName: '明确院校',
    })])]});
    assert.equal(explicit.values.school, '明确院校');

    const unknown = extractProfileFields({candidate, snapshots: [snapshot([card({
      school: placeholder, experiences: [{type: 2, organization: placeholder}],
    })])]});
    assert.equal(unknown.values.school, undefined);
    assert.equal(unknown.unknown.school, 'invalid_school');
    assert.deepEqual(planProfileFieldPatch({candidate, metadata: unknown}).patch, {});
  }
});

test('invalid Gregorian dates block observations and cannot borrow older field values', () => {
  for (const time of [
    '2026-02-30', '2026-02-30T12:00:00Z', '2026-02-29T12:00:00+08:00',
    '2100-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-00-15T00:00:00Z', '2026-13-15T00:00:00Z', '2026-01-00T00:00:00Z',
    '2026-01-32T00:00:00Z',
  ]) {
    const metadata = extractProfileFields({candidate, snapshots: [snapshot([
      card({age: 20, gender: '男', school: '旧院校'}),
      card({mid: 2, time, age: 24, gender: '女', school: '新院校'}),
    ])]});
    assert.deepEqual(metadata.values, {}, time);
    assert.deepEqual(metadata.unknown, {
      age: 'invalid_message_time', gender: 'invalid_message_time', school: 'invalid_message_time',
    }, time);
    assert.deepEqual(planProfileFieldPatch({candidate, metadata}).patch, {}, time);
  }
});

test('valid Gregorian leap dates and epoch or ISO offset times remain sortable', () => {
  for (const time of [
    '2024-02-29', '2000-02-29T00:00:00Z', '2024-02-29T23:59:59.123Z',
    '2024-02-29T23:59:59+08:00', '2024-02-29T00:00:00-05:00',
    '2024-02-29T00:00:00+0800', '2026-02-28T12:00:00Z',
    1_704_067_200, '1704067200', 1_704_067_200_000, '1704067200000',
  ]) {
    const metadata = extractProfileFields({candidate, snapshots: [snapshot([
      card({time: '1999-01-01T00:00:00Z', age: 20}), card({mid: 2, time, age: 24}),
    ])]});
    assert.equal(metadata.values.age, 24, String(time));
    assert.equal(metadata.evidence.age.mid, 2, String(time));
  }
});
