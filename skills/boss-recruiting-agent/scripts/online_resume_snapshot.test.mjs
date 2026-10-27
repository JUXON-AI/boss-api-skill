import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildOnlineResumeSnapshot} from './online_resume_snapshot.mjs';

const candidate = Object.freeze({uid: 101, name: '合成候选人甲', jobId: 'job-synthetic-7'});
const sourceSha256 = 'a'.repeat(64);
const kind = 'boss_online_resume_summary_snapshot';

function summary(overrides = {}) {
  return {
    education: [{
      school: '合成大学',
      major: '软件工程',
      degreeName: '本科',
      startDateDesc: '2018.09',
      endDateDesc: '2022.06',
      educationDescription: '合成教育说明',
    }],
    work: [{
      company: '合成科技有限公司',
      brandName: '合成品牌',
      positionName: '后端工程师',
      department: '平台研发部',
      jobName: '服务端开发',
      startDateDesc: '2022.07',
      endDateDesc: '2024.06',
      startYearMonStr: '2022年07月',
      endYearMonStr: '2024年06月',
      workDescription: '合成工作说明',
      responsibility: '合成职责说明',
    }],
    projects: [{
      name: '合成项目',
      roleName: '项目负责人',
      startDateDesc: '2023.01',
      endDateDesc: '2023.12',
      projectDescription: '合成项目说明',
      description: '合成项目简介',
      responsibility: '合成项目职责',
      achievement: '合成项目成果',
    }],
    fullTextVerified: false,
    ...overrides,
  };
}

function source(overrides = {}) {
  const record = {
    schemaVersion: 1,
    candidate: {uid: candidate.uid, name: candidate.name, jobId: candidate.jobId},
    at: '2026-10-26T02:00:00.000Z',
    resume: {
      status: 'summary',
      obtainedAt: '2026-10-26T01:59:00.000Z',
      summary: summary(),
    },
  };
  return {
    ...record,
    ...overrides,
    candidate: {...record.candidate, ...(overrides.candidate || {})},
    resume: {
      ...record.resume,
      ...(overrides.resume || {}),
      summary: overrides.resume && Object.prototype.hasOwnProperty.call(overrides.resume, 'summary')
        ? overrides.resume.summary
        : record.resume.summary,
    },
  };
}

function build(overrides = {}) {
  return buildOnlineResumeSnapshot({
    candidate,
    source: source(),
    sourceSha256,
    sourcePath: 'C:\\synthetic\\records\\101.json',
    ...overrides,
  });
}

test('builds the exact summary snapshot shape and labels it as partial', () => {
  const snapshot = build();
  assert.deepEqual(Object.keys(snapshot), [
    'candidate', 'kind', 'fullTextVerified', 'source', 'generatedLabel', 'sections', 'idempotencyKey',
  ]);
  assert.deepEqual(snapshot.candidate, candidate);
  assert.equal(snapshot.kind, kind);
  assert.equal(snapshot.fullTextVerified, false);
  assert.equal(snapshot.generatedLabel, 'BOSS线上简历摘要（非完整正文）');
  assert.equal(snapshot.source.capturedAt, '2026-10-26T01:59:00.000Z');
  assert.deepEqual(Object.keys(snapshot.sections), ['education', 'work', 'projects']);
  assert.equal(snapshot.generatedLabel.includes('PDF'), false);
});

test('strictly binds input identity to source UID, name, and jobId', () => {
  assert.throws(() => build({source: source({candidate: {uid: 999}})}), /UID, name, and jobId/);
  assert.throws(() => build({source: source({candidate: {name: '另一姓名'}})}), /UID, name, and jobId/);
  assert.throws(() => build({source: source({candidate: {jobId: 'other-job'}})}), /UID, name, and jobId/);
});

test('rejects a missing or malformed source hash', () => {
  assert.throws(() => build({sourceSha256: undefined}), /64-character lowercase hex SHA-256/);
  assert.throws(() => build({sourceSha256: 'abc'}), /64-character lowercase hex SHA-256/);
  assert.throws(() => build({sourceSha256: 'A'.repeat(64)}), /64-character lowercase hex SHA-256/);
});

test('rejects empty or sensitive-only card data', () => {
  assert.throws(() => build({
    source: source({resume: {summary: summary({education: [], work: [], projects: []})}}),
  }), /card-only data is rejected/);
  assert.throws(() => build({
    source: source({resume: {summary: summary({
      education: [{securityId: 'secret', school: '   ', phone: '10000'}],
      work: [],
      projects: [],
    })}}),
  }), /card-only data is rejected/);
});

test('preserves the two work year-month date fields', () => {
  const cleaned = build().sections.work[0];
  assert.equal(cleaned.startYearMonStr, '2022年07月');
  assert.equal(cleaned.endYearMonStr, '2024年06月');
  assert.equal(cleaned.startDateDesc, '2022.07');
  assert.equal(cleaned.endDateDesc, '2024.06');
});

test('keeps original hostile text byte-for-byte as inert data', () => {
  const hostile = '<img src=x onerror="globalThis.__snapshotEscaped=1">& ${process.exit(9)} </script>';
  const snapshot = build({
    sourcePath: 'C:\\synthetic\\never-read\\$(do_not_run).json',
    source: source({resume: {summary: summary({
      education: [{
        school: hostile,
        educationDescription: {text: hostile, securityId: 'nested-secret'},
      }],
      work: [],
      projects: [],
    })}}),
  });
  assert.equal(snapshot.sections.education[0].school, hostile);
  assert.equal(snapshot.sections.education[0].educationDescription.text, hostile);
  assert.equal(snapshot.source.path, 'C:\\synthetic\\never-read\\$(do_not_run).json');
  assert.equal(globalThis.__snapshotEscaped, undefined);
});

test('stable idempotency key ignores invocation path and source object key order', () => {
  const first = build();
  const reordered = {
    resume: {
      summary: summary(),
      obtainedAt: '2026-10-26T01:59:00.000Z',
      status: 'summary',
    },
    at: '2026-10-26T02:00:00.000Z',
    candidate: {...candidate},
    schemaVersion: 1,
  };
  const second = build({source: reordered, sourcePath: 'different\\metadata\\path.json'});
  const expected = crypto.createHash('sha256')
    .update(`${candidate.jobId}${candidate.uid}${sourceSha256}${kind}`)
    .digest('hex');
  assert.equal(first.idempotencyKey, expected);
  assert.equal(second.idempotencyKey, expected);
});

test('drops every non-whitelisted and sensitive field, including nested metadata', () => {
  const snapshot = build({
    source: source({resume: {summary: summary({
      education: [{
        school: '合成大学',
        securityId: 'secret-security',
        encryptUid: 'secret-encrypt',
        avatar: 'https://secret.example/avatar',
        phone: '18800000000',
        email: 'secret@example.test',
        hyperLink: {url: 'https://secret.example'},
        note: 'drop me',
      }],
      work: [{
        company: '合成公司',
        responsibility: {
          text: '保留职责原文',
          securityId: 'nested-security',
          metadata: {url: 'https://secret.example', note: '保留普通说明', email: 'nested@example.test'},
        },
      }],
      projects: [],
    })}}),
  });
  assert.deepEqual(snapshot.sections.education[0], {school: '合成大学'});
  assert.deepEqual(snapshot.sections.work[0], {
    company: '合成公司',
    responsibility: {text: '保留职责原文', metadata: {note: '保留普通说明'}},
  });
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    'secret-security', 'secret-encrypt', 'secret.example/avatar', '18800000000',
    'secret@example.test', 'https://secret.example', 'nested-security', 'nested@example.test',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test('supports permitted scalar, array, and plain-object values while omitting empty values', () => {
  const snapshot = build({
    source: source({resume: {summary: summary({
      education: [{
        school: '合成大学',
        major: 0,
        degreeName: false,
        educationDescription: {
          level: 3,
          verified: true,
          tags: ['原文标签', null, '   '],
          emptyObject: {},
          emptyArray: [],
          nullable: null,
        },
      }],
      work: [],
      projects: [],
    })}}),
  });
  assert.deepEqual(snapshot.sections.education[0], {
    school: '合成大学',
    major: 0,
    degreeName: false,
    educationDescription: {level: 3, verified: true, tags: ['原文标签']},
  });
});

test('rejects non-summary or full-text claims and invalid cache timestamps', () => {
  assert.throws(() => build({source: source({resume: {status: 'unavailable'}})}), /status must be summary/);
  assert.throws(() => build({source: source({resume: {summary: summary({fullTextVerified: true})}})}), /must be false/);
  assert.throws(() => build({source: source({at: 'not-a-date'})}), /ISO timestamp/);
  assert.throws(() => build({source: source({resume: {obtainedAt: 'not-a-date'}})}), /ISO timestamp/);
});
