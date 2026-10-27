import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('observer cleanup discovery uses one absolute deadline, not twenty independent 1.5-second waits', async () => {
  const timers = new Set(); let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    const timer = setTimeout(() => {timers.delete(timer); res.end('[]');}, 500);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.BOSS_INSPECTOR_URL;
  process.env.BOSS_INSPECTOR_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const {targets} = await import('./runtime.mjs?observer-deadline-test');
    const start = Date.now();
    await assert.rejects(targets({deadline: start + 60}));
    assert.ok(Date.now() - start < 450, 'deadline must beat the synthetic 500ms response');
    assert.equal(calls, 1);
    await assert.rejects(targets({deadline: Date.now() - 1}));
    assert.equal(calls, 1, 'expired deadline cannot start another HTTP request');
  } finally {
    if (old === undefined) delete process.env.BOSS_INSPECTOR_URL; else process.env.BOSS_INSPECTOR_URL = old;
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
