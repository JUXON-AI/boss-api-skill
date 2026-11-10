import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planSkillInstallation, installSkills} from './recruiting-skills-install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-host-skills-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('boss-host-skills-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const repoRoot = path.join(root, 'repo');
  for (const name of ['workflow', 'implementation']) {
    fs.mkdirSync(path.join(repoRoot, 'skills', name), {recursive: true});
    fs.writeFileSync(path.join(repoRoot, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n`);
  }
  fs.writeFileSync(path.join(repoRoot, 'recruiting-skills.package.json'), JSON.stringify({version: 'test', skills: ['workflow'],
    implementationSkill: 'skills/implementation', hosts: {
      codex: {entrypoint: 'workflow', homeEnv: 'CODEX_HOME', defaultHome: '~/.codex'},
      'deepseek-harness': {entrypoint: 'workflow', homeEnv: 'DSH_HOME', defaultHome: '~/.dsh'}
    }}));
  return {root, repoRoot, userHome: path.join(root, 'user'), env: {}};
}

test('host homes stay separate and respect explicit home before environment/default', t => {
  const f = fixture(t);
  assert.equal(planSkillInstallation({...f, host: 'codex'}).home, path.join(f.userHome, '.codex'));
  assert.equal(planSkillInstallation({...f, host: 'deepseek-harness'}).home, path.join(f.userHome, '.dsh'));
  const envHome = path.join(f.root, 'env');
  assert.equal(planSkillInstallation({...f, host: 'deepseek-harness', env: {DSH_HOME: envHome}}).home, envHome);
  assert.equal(planSkillInstallation({...f, host: 'deepseek-harness', env: {DSH_HOME: ' '}}).home, path.join(f.userHome, '.dsh'));
  assert.equal(planSkillInstallation({...f, host: 'deepseek-harness', env: {DSH_HOME: envHome}, home: f.userHome}).home, f.userHome);
  assert.throws(() => planSkillInstallation({...f, host: 'unknown'}));
});

test('installation backs up actual prior bytes, preserves unrelated skills and is idempotent', t => {
  const f = fixture(t), options = {...f, host: 'deepseek-harness'};
  const plan = planSkillInstallation(options);
  fs.mkdirSync(path.dirname(plan.files[0].target), {recursive: true});
  fs.writeFileSync(plan.files[0].target, 'old local rules');
  fs.mkdirSync(path.join(plan.skillsRoot, 'unrelated'), {recursive: true});
  fs.writeFileSync(path.join(plan.skillsRoot, 'unrelated', 'SKILL.md'), 'keep');
  const installed = installSkills(planSkillInstallation(options));
  assert.equal(fs.readFileSync(path.join(installed.backup, plan.files[0].relative), 'utf8'), 'old local rules');
  assert.ok(planSkillInstallation(options).files.every(f => f.state === 'same'));
  assert.equal(installSkills(planSkillInstallation(options)).changedFiles, 0);
  assert.equal(fs.readFileSync(path.join(plan.skillsRoot, 'unrelated', 'SKILL.md'), 'utf8'), 'keep');
  const proof = JSON.parse(fs.readFileSync(path.join(installed.backup, 'installation.json'), 'utf8'));
  assert.equal(proof.schedulerChanged, false); assert.equal(proof.servicesInvoked, false);
});

test('source changes after planning are rejected and missing skill bodies cannot be installed', t => {
  const f = fixture(t), options = {...f, host: 'deepseek-harness'};
  const plan = planSkillInstallation(options);
  fs.appendFileSync(plan.files[0].source, 'changed');
  assert.throws(() => installSkills(plan), /Source changed/);
  assert.equal(fs.existsSync(plan.files[0].target), false);
  fs.unlinkSync(plan.files[0].source);
  assert.throws(() => planSkillInstallation(options), /Missing skill/);
});
