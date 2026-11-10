#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {privateDirectory} from './platform.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the host once; no services, sessions, schedulers or credentials are touched. */
export function planSkillInstallation({host, home, repoRoot = defaultRoot, env = process.env, userHome = os.homedir()}) {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'recruiting-skills.package.json'), 'utf8'));
  const profile = config.hosts?.[host];
  if (!profile) throw new Error('Use --host codex or --host deepseek-harness');
  const configured = home ?? env[profile.homeEnv]?.trim();
  const hostHome = path.resolve(configured || path.join(userHome, profile.defaultHome.replace(/^~[\\/]/, '')));
  const skillsRoot = path.join(hostHome, 'skills');
  const names = [...config.skills, path.basename(config.implementationSkill)];
  const files = [];
  for (const name of names) {
    const sourceRoot = path.join(repoRoot, 'skills', name);
    if (!fs.existsSync(path.join(sourceRoot, 'SKILL.md'))) throw new Error(`Missing skill: ${name}`);
    const pending = [sourceRoot];
    while (pending.length) {
      const dir = pending.pop();
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (['__pycache__', '.git', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.pyc')) continue;
        const source = path.join(dir, entry.name);
        if (entry.isDirectory()) { pending.push(source); continue; }
        if (!entry.isFile()) throw new Error(`Non-file skill entry: ${source}`);
        const relative = path.join(name, path.relative(sourceRoot, source));
        const target = path.join(skillsRoot, relative);
        const sha256 = digest(fs.readFileSync(source));
        const state = !fs.existsSync(target) ? 'missing' : digest(fs.readFileSync(target)) === sha256 ? 'same' : 'changed';
        files.push({relative, source, target, sha256, state});
      }
    }
  }
  return {host, home: hostHome, repoRoot: path.resolve(repoRoot), skillsRoot, version: config.version,
    entrypoint: profile.entrypoint, names, files};
}

/** Install the planned package, backing up only overwritten files in protected workspace output. */
export function installSkills(plan) {
  const pending = plan.files.filter(f => f.state !== 'same');
  if (!pending.length) return {installed: true, changedFiles: 0, backup: null};
  const backup = path.join(plan.repoRoot, 'outputs', 'windows-private', 'skill-install', randomUUID());
  privateDirectory(backup);
  for (const file of pending) {
    const bytes = fs.readFileSync(file.source);
    if (digest(bytes) !== file.sha256) throw new Error(`Source changed after planning: ${file.relative}`);
    if (fs.existsSync(file.target)) {
      const saved = path.join(backup, file.relative);
      privateDirectory(path.dirname(saved));
      fs.copyFileSync(file.target, saved, fs.constants.COPYFILE_EXCL);
    }
    fs.mkdirSync(path.dirname(file.target), {recursive: true});
    fs.writeFileSync(file.target, bytes);
    if (digest(fs.readFileSync(file.target)) !== file.sha256) throw new Error(`Installed bytes differ: ${file.relative}`);
  }
  fs.writeFileSync(path.join(backup, 'installation.json'), JSON.stringify({host: plan.host, version: plan.version,
    repoRoot: plan.repoRoot, skillsRoot: plan.skillsRoot, entrypoint: plan.entrypoint,
    files: plan.files.map(({relative, sha256}) => ({relative, sha256})),
    servicesInvoked: false, schedulerChanged: false}, null, 2), {flag: 'wx', mode: 0o600});
  return {installed: true, changedFiles: pending.length, backup};
}

function main() {
  const args = process.argv.slice(2);
  let host, home, check = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--check') check = true;
    else if (['--host', '--home'].includes(arg) && args[0] && !args[0].startsWith('--')) {
      if (arg === '--host') host = args.shift(); else home = args.shift();
    } else throw new Error('Usage: recruiting-skills-install.mjs --host <codex|deepseek-harness> [--home <host-home>] [--check]');
  }
  const plan = planSkillInstallation({host, home});
  const mismatches = plan.files.filter(f => f.state !== 'same').map(({relative, state}) => ({relative, state}));
  const result = check ? {ok: mismatches.length === 0, mismatches} : {ok: true, ...installSkills(plan)};
  console.log(JSON.stringify({...result, host: plan.host, version: plan.version, entrypoint: plan.entrypoint,
    skillsRoot: plan.skillsRoot, skills: plan.names.length, files: plan.files.length,
    servicesInvoked: false, schedulerChanged: false}));
  if (!result.ok) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; }
}
