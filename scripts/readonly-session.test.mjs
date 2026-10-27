import test from 'node:test';
import assert from 'node:assert/strict';
import {withReadonlySession} from './readonly-session.mjs';
import {acquireInspectorLock} from './runtime.mjs';

const candidate = {uid: 42, name: '合成对象', jobId: 'fixture-job', securityId: 'not-persisted'};
function fixture() {
  const counts = {connections: 0, actions: []};
  const connect = async callback => {
    counts.connections++;
    return callback({bridge: async (type, action) => {
      counts.actions.push(action);
      if (action === '_sdk_getLoginStatus') return {code: 0, data: true};
      if (action === 'zprelationGetFriendList') return {code: 0, zpData: {friendList: [candidate]}};
      return {code: 0, zpData: {hasMore: false, messages: [{mid: 1, from: {uid: 42}, to: {uid: 9}, body: {text: '合成消息'}}]}};
    }});
  };
  return {connect, counts};
}
test('one owned connection and one login serve multiple sequential reads without exposing writes', async () => {
  const f = fixture();
  await withReadonlySession(async session => {
    assert.deepEqual(Object.keys(session).sort(), ['contacts', 'history']);
    await session.contacts(1);
    const history = await session.history(candidate);
    assert.equal(history.complete, true);
    await session.contacts(1);
    await assert.rejects(session.history({...candidate, jobId: 'wrong-job'}), /matched contact/);
  }, f);
  assert.equal(f.counts.connections, 1);
  assert.equal(f.counts.actions.filter(x => x === '_sdk_getLoginStatus').length, 1);
});
test('concurrent read requests fail rather than parallel SDK access', async () => {
  const f = fixture();
  await withReadonlySession(async session => {
    const first = session.contacts(1);
    await assert.rejects(session.contacts(2), /busy/);
    await first;
  }, f);
});
test('workflow priority and call bounds stop before issuing another request', async () => {
  const f = fixture(); let available = true;
  await withReadonlySession(async session => {
    await session.contacts(1); available = false;
    await assert.rejects(session.history(candidate), e => e.code === 'OBSERVER_YIELD');
  }, {...f, canRead: () => available});
  assert.equal(f.counts.actions.includes('zpChatHistoryMsg'), false);
});
test('foreground waits only for a live tagged observer; lock contention is not a business retry', async () => {
  let busy = true, now = 0, waits = 0;
  const conflict = Object.assign(new Error('exists'), {code: 'EEXIST'});
  const io = {openSync() {if (busy) throw conflict; return 77;}, readFileSync() {return JSON.stringify({pid: 3, action: 'bounded_readonly_observer'});}};
  const fd = await acquireInspectorLock('fixture', {io, alive: () => true, now: () => now, wait: async ms => {waits++; now += ms; busy = false;}});
  assert.equal(fd, 77); assert.equal(waits, 1);
  busy = true;
  await assert.rejects(acquireInspectorLock('fixture', {io, alive: () => false}), /exists/);
  io.readFileSync = () => JSON.stringify({pid: 3, action: 'operation'});
  await assert.rejects(acquireInspectorLock('fixture', {io, alive: () => true}), /exists/);
});
test('the owner publication gap gets bounded grace without deleting another lock', async () => {
  let attempts = 0, clock = 0;
  const error = Object.assign(new Error('exists'), {code: 'EEXIST'});
  const io = {openSync() {if (++attempts === 1) throw error; return 8;}, readFileSync: () => ''};
  assert.equal(await acquireInspectorLock('fixture', {io, now: () => clock, wait: async ms => {clock += ms;}}), 8);
  assert.equal(attempts, 2);
});
test('different jobs for the same UID use separate freshly matched contacts', async () => {
  let calls = 0;
  const connect = async callback => callback({bridge: async (_type, action, data) => {
    if (action === '_sdk_getLoginStatus') return {code: 0, data: true};
    if (action === 'zprelationGetFriendList') return {code: 0, zpData: {friendList: [{...candidate, jobId: data.page === 1 ? 'a' : 'b'}]}};
    calls++; return {code: 0, zpData: {hasMore: false, messages: [{mid: 1, from: {uid: 42}, to: {uid: 9}, body: {text: '合成消息'}}]}};
  }});
  await withReadonlySession(async session => {await session.contacts(1); await session.contacts(2); await session.history({...candidate, jobId: 'a'});}, {connect});
  assert.equal(calls, 1);
});
test('a source pin must match both the packaged bytes and the loaded resource before SDK reads', async () => {
  let reads = 0;
  const connect = async callback => callback({identity: {execPath: process.execPath}, main: async () => ({sha256: 'a'.repeat(64), entryBound: false, memberReferenced: true}),
    bridge: async () => {reads++; return {code: 0, data: true};}});
  await assert.rejects(withReadonlySession(s => s.contacts(1), {connect, sourcePin: {member: 'assets/fixture.js', sha256: 'a'.repeat(64)}}), /loaded client source/);
  assert.equal(reads, 0);
});
