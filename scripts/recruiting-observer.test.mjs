import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash} from './runtime.mjs';
import {observeOnce} from './recruiting-observer.mjs';

function setup() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-observer-fixture-'));
  const source = path.join(parent, 'source.js'), auth = path.join(parent, 'authorization.json');
  fs.writeFileSync(source, 'synthetic source; never execute'); fs.writeFileSync(auth, '{}');
  const candidate = {uid: 42, name: '合成对象', jobId: 'fixture', lastTS: 1, relationType: 5};
  const config = {schemaVersion: 1, jobId: 'fixture', root: path.join(parent, 'private'), scope: [candidate],
    workflowLocks: [path.join(parent, 'workflow.lock')], authorization: {readCurrentJob: true, newGreetings: true, reference: auth},
    clientSource: {path: source, member: 'assets/fixture.js', sha256: hash(fs.readFileSync(source))}, maxHistoriesPerPass: 2};
  return {parent, config, candidate};
}
test('an active workflow prevents any observer session or checkpoint mutation', async () => {
  const f = setup();
  try {
    fs.writeFileSync(f.config.workflowLocks[0], 'owned');
    const result = await observeOnce(f.config, {withSession: () => {throw new Error('session must not open');}});
    assert.equal(result.status, 'yielded');
    assert.equal(fs.existsSync(f.config.root), false);
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});

test('invalid handled-mid types fail before any session, lock or output', async () => {
  const f = setup();
  try {
    f.config.scope[0].handledMids = ['10'];
    let called = false;
    await assert.rejects(observeOnce(f.config, {withSession: async () => {called = true;}}), /positive safe integer/);
    assert.equal(called, false);
    assert.equal(fs.existsSync(f.config.root), false);
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});
test('two passes queue each exact inbound once, and a later mid remains visible', async () => {
  const f = setup(); let mid = 10, calls = 0;
  const withSession = async callback => callback({contacts: async () => [f.candidate], history: async () => {
    calls++; return {complete: true, sha256: 'a'.repeat(64), messages: [{mid, time: 1, from: {uid: 42}, to: {uid: 9}, body: {text: '合成答复'}}]};
  }});
  try {
    const first = await observeOnce(f.config, {withSession, wait: async () => {}});
    const second = await observeOnce(f.config, {withSession, wait: async () => {}});
    assert.equal(first.queued, 1); assert.equal(second.queued, 0); assert.equal(calls, 1);
    mid = 11; f.candidate.lastTS = 2;
    const third = await observeOnce(f.config, {withSession, wait: async () => {}});
    assert.equal(third.queued, 1); assert.equal(calls, 2);
    assert.equal(fs.readdirSync(path.join(f.config.root, 'events')).length, 2);
    assert.equal(fs.existsSync(path.join(f.config.root, 'observer.lock')), false);
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});
test('an event survives loss of the checkpoint without requeueing its exact mid', async () => {
  const f = setup(); let second = false;
  const withSession = async callback => callback({contacts: async () => [f.candidate], history: async () => ({complete: true, sha256: 'a'.repeat(64),
    messages: [10, ...(second ? [11] : [])].map(mid => ({mid, time: mid, from: {uid: 42}, to: {uid: 9}, body: {text: '合成答复'}}))})});
  try {
    await observeOnce(f.config, {withSession, wait: async () => {}});
    fs.unlinkSync(path.join(f.config.root, 'checkpoint.json')); second = true;
    const result = await observeOnce(f.config, {withSession, wait: async () => {}});
    assert.equal(result.queued, 1);
    const events = fs.readdirSync(path.join(f.config.root, 'events')).map(file => JSON.parse(fs.readFileSync(path.join(f.config.root, 'events', file), 'utf8')));
    assert.deepEqual(events.flatMap(e => e.candidateTextMids).sort(), [10, 11]);
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});
test('failed full-history read is visible and cannot advance its watermark', async () => {
  const f = setup();
  try {
    const result = await observeOnce(f.config, {withSession: async callback => callback({contacts: async () => [f.candidate], history: async () => {throw Object.assign(new Error('synthetic failure'), {code: 'TEST_TRANSPORT'});}}), wait: async () => {}});
    assert.equal(result.complete, 0); assert.equal(result.status, 'partial_or_yielded');
    assert.equal(fs.existsSync(path.join(f.config.root, 'checkpoint.json')), false);
    assert.equal(result.failures[0].code, 'TEST_TRANSPORT');
    let replayed = false;
    const second = await observeOnce(f.config, {withSession: async callback => callback({contacts: async () => [f.candidate], history: async () => {replayed = true; throw new Error('must not replay');}}), wait: async () => {}});
    assert.equal(replayed, false);
    assert.ok(second.failures.some(x => x.code === 'READ_FAILURE_PENDING_REVIEW'));
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});
test('an invalid saved checkpoint cannot strand an observer lock', async () => {
  const f = setup();
  try {
    // A workflow skip creates no private output; first run safely initializes it.
    await observeOnce(f.config, {withSession: async callback => callback({contacts: async () => []}), wait: async () => {}});
    fs.writeFileSync(path.join(f.config.root, 'checkpoint.json'), 'invalid-json');
    await assert.rejects(observeOnce(f.config), /JSON/);
    assert.equal(fs.existsSync(path.join(f.config.root, 'observer.lock')), false);
  } finally {fs.rmSync(f.parent, {recursive: true, force: true});}
});
