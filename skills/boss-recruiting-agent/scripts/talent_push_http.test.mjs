import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createTalentPushHttpServer} from './talent_push_http.mjs';

const TOKEN = 'synthetic-token-0123456789-ABCDEFG';
const EVENT = Object.freeze({
  type: 'talent.base_verified',
  jobId: 42,
  uid: '9007199254740991',
  recordId: 'recSynthetic123',
});

test('health binds the configured routing fingerprint without exposing credentials',async()=>{
  const configId='a'.repeat(64);
  await withServer({token:TOKEN,configId,handleEvent:async()=>({ok:true})},async baseUrl=>{
    const health=await (await fetch(baseUrl+'/health')).json();assert.deepEqual(health,{ok:true,service:'boss-talent-push',version:1,configId});assert.equal(JSON.stringify(health).includes(TOKEN),false);
  });
  assert.throws(()=>createTalentPushHttpServer({token:TOKEN,configId:'not-a-sha',handleEvent:async()=>({ok:true})}),/configId/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startServer(options) {
  const server = createTalentPushHttpServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {server, baseUrl: `http://127.0.0.1:${address.port}`};
}

async function stopServer(server) {
  const closed = once(server, 'close');
  server.close();
  server.closeIdleConnections?.();
  await closed;
}

async function withServer(options, run) {
  const {server, baseUrl} = await startServer(options);
  try {
    return await run(baseUrl, server);
  } finally {
    await stopServer(server);
  }
}

function post(baseUrl, pathname, payload, {
  token = TOKEN,
  raw = false,
  headers = {},
} = {}) {
  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };
  if (token !== null) requestHeaders.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: requestHeaders,
    body: raw || typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function expectFixedError(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), {ok: false, error});
}

test('factory requires a strong token and event handler', () => {
  assert.throws(
    () => createTalentPushHttpServer({token: 'x'.repeat(31), handleEvent() {}}),
    /token must be at least 32 visible ASCII characters/,
  );
  assert.throws(
    () => createTalentPushHttpServer({token: TOKEN}),
    /handleEvent must be a function/,
  );
  assert.throws(
    () => createTalentPushHttpServer({token: TOKEN, handleEvent() {}, handleReconcile: true}),
    /handleReconcile must be a function/,
  );
  assert.throws(
    () => createTalentPushHttpServer({token: `${'x'.repeat(31)}\n`, handleEvent() {}}),
    /token must be at least 32 visible ASCII characters/,
  );

  const server = createTalentPushHttpServer({token: TOKEN, handleEvent() {}});
  assert.ok(server instanceof http.Server);
  assert.equal(server.listening, false);
});

test('health is minimal and routing returns 405 or 404 without handlers', async () => {
  const calls = [];
  await withServer({
    token: TOKEN,
    handleEvent(event) {
      calls.push(event);
    },
  }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'boss-talent-push',
      version: 1,
    });

    const browserHealth = await fetch(`${baseUrl}/health`, {
      headers: {Origin: 'http://synthetic.invalid'},
    });
    await expectFixedError(browserHealth, 403, 'origin_forbidden');

    const wrongMethod = await fetch(`${baseUrl}/talent-screened`, {
      method: 'GET',
      headers: {Authorization: `Bearer ${TOKEN}`},
    });
    await expectFixedError(wrongMethod, 405, 'method_not_allowed');

    const healthWrongMethod = await fetch(`${baseUrl}/health`, {method: 'POST'});
    await expectFixedError(healthWrongMethod, 405, 'method_not_allowed');

    const missingPath = await fetch(`${baseUrl}/not-an-endpoint`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TOKEN}`},
    });
    await expectFixedError(missingPath, 404, 'not_found');

    const missingReconcile = await post(baseUrl, '/talent-reconcile', EVENT);
    await expectFixedError(missingReconcile, 404, 'not_found');
  });
  assert.deepEqual(calls, []);
});

test('authentication, Origin, media type, schema, and body limit reject before handlers', async () => {
  let calls = 0;
  await withServer({
    token: TOKEN,
    handleEvent() {
      calls += 1;
    },
  }, async (baseUrl) => {
    await expectFixedError(
      await post(baseUrl, '/talent-screened', EVENT, {token: null}),
      401,
      'unauthorized',
    );
    await expectFixedError(
      await post(baseUrl, '/talent-screened', EVENT, {
        headers: {Origin: 'http://synthetic.invalid'},
      }),
      403,
      'origin_forbidden',
    );
    await expectFixedError(
      await post(baseUrl, '/talent-screened', EVENT, {
        headers: {'Content-Type': 'text/plain'},
      }),
      415,
      'unsupported_media_type',
    );
    await expectFixedError(
      await post(baseUrl, '/talent-screened', '{"broken"', {raw: true}),
      400,
      'bad_request',
    );

    const invalidPayloads = [
      [],
      'primitive',
      {...EVENT, extra: true},
      {...EVENT, content: 'private candidate text'},
      {...EVENT, targetUrl: 'https://synthetic.invalid'},
      {...EVENT, type: 'talent.other'},
      {...EVENT, jobId: 0},
      {...EVENT, jobId: '01'},
      {...EVENT, jobId: '9007199254740992'},
      {...EVENT, uid: 1.5},
      {...EVENT, uid: '-1'},
      {...EVENT, recordId: 'rec'},
      {...EVENT, recordId: `rec${'A'.repeat(78)}`},
    ];
    for (const payload of invalidPayloads) {
      await expectFixedError(
        await post(baseUrl, '/talent-screened', payload),
        400,
        'bad_request',
      );
    }

    const oversized = JSON.stringify({...EVENT, padding: 'x'.repeat(4_096)});
    await expectFixedError(
      await post(baseUrl, '/talent-screened', oversized, {raw: true}),
      413,
      'payload_too_large',
    );

    const encoded = new TextEncoder().encode('x'.repeat(4_097));
    const chunkedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 2_048));
        controller.enqueue(encoded.subarray(2_048));
        controller.close();
      },
    });
    const chunked = await fetch(`${baseUrl}/talent-screened`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: chunkedBody,
      duplex: 'half',
    });
    await expectFixedError(chunked, 413, 'payload_too_large');
  });
  assert.equal(calls, 0);
});

test('authorized event is normalized and custom handler response is returned', async () => {
  const calls = [];
  await withServer({
    token: TOKEN,
    handleEvent(event) {
      calls.push(event);
      if (calls.length === 1) {
        return {
          httpStatus: 202,
          data: {accepted: true, event},
        };
      }
      return undefined;
    },
  }, async (baseUrl) => {
    const response = await post(baseUrl, '/talent-screened', EVENT);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      event: {
        type: 'talent.base_verified',
        jobId: '42',
        uid: '9007199254740991',
        recordId: 'recSynthetic123',
      },
    });

    const defaultResponse = await post(baseUrl, '/talent-screened', {
      ...EVENT,
      jobId: '43',
    }, {
      headers: {'Content-Type': 'application/json; charset=UTF-8'},
    });
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(await defaultResponse.json(), {ok: true});
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    type: 'talent.base_verified',
    jobId: '42',
    uid: '9007199254740991',
    recordId: 'recSynthetic123',
  });
});

test('handler failures return a generic response without secrets or request data', async () => {
  const privateBodyMarker = 'PRIVATE_BODY_MARKER';
  const handlerSecret = 'HANDLER_SECRET_SHOULD_NOT_ESCAPE';
  await withServer({
    token: TOKEN,
    handleEvent() {
      throw new Error(`${handlerSecret} ${privateBodyMarker} ${TOKEN}`);
    },
  }, async (baseUrl) => {
    const response = await post(baseUrl, '/talent-screened', {
      ...EVENT,
      recordId: 'recPrivateMarker',
    });
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), {ok: false, error: 'service_unavailable'});
    assert.doesNotMatch(text, /synthetic-token|HANDLER_SECRET|PRIVATE_BODY_MARKER|recPrivateMarker|stack/i);
  });
});

test('duplicate business events are invoked serially in receipt order', async () => {
  const gate = deferred();
  const firstStarted = deferred();
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  await withServer({
    token: TOKEN,
    async handleEvent(event) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const ordinal = calls.length;
      calls.push(event.recordId);
      if (ordinal === 0) {
        firstStarted.resolve();
        await gate.promise;
      }
      inFlight -= 1;
      return {httpStatus: 200, data: {ok: true, ordinal}};
    },
  }, async (baseUrl) => {
    const first = post(baseUrl, '/talent-screened', EVENT);
    await firstStarted.promise;
    const second = post(baseUrl, '/talent-screened', EVENT);
    try {
      await delay(75);
      assert.deepEqual(calls, ['recSynthetic123']);
    } finally {
      gate.resolve();
    }
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.json())), [
      {ok: true, ordinal: 0},
      {ok: true, ordinal: 1},
    ]);
  });

  assert.deepEqual(calls, ['recSynthetic123', 'recSynthetic123']);
  assert.equal(maxInFlight, 1);
});

test('queue overflow returns 429 while one shared queue bounds pending handlers', async () => {
  const gate = deferred();
  const firstStarted = deferred();
  let calls = 0;
  let released = false;

  await withServer({
    token: TOKEN,
    async handleEvent() {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await gate.promise;
      }
      return {httpStatus: 200, data: {ok: true}};
    },
  }, async (baseUrl) => {
    const first = post(baseUrl, '/talent-screened', EVENT);
    await firstStarted.promise;
    const waiting = Array.from({length: 8}, (_, index) => post(baseUrl, '/talent-screened', {
      ...EVENT,
      recordId: `recQueued${index}`,
    }));
    await delay(150);

    const overflowPromise = post(baseUrl, '/talent-screened', {
      ...EVENT,
      recordId: 'recOverflow',
    });
    const overflow = await Promise.race([
      overflowPromise.then((response) => response),
      delay(1_000).then(() => null),
    ]);
    try {
      assert.ok(overflow, 'overflow request should resolve before the queue is released');
      await expectFixedError(overflow, 429, 'queue_full');
    } finally {
      released = true;
      gate.resolve();
    }
    const responses = await Promise.all([first, ...waiting, overflowPromise]);
    assert.ok(responses.slice(0, 9).every((response) => response.status === 200));
  });

  assert.equal(released, true);
  assert.equal(calls, 9);
});

test('reconcile uses its own handler and shares the serial queue with events', async () => {
  const gate = deferred();
  const eventStarted = deferred();
  const order = [];
  let eventCalls = 0;
  let reconcileCalls = 0;
  let reconciledEvent;

  await withServer({
    token: TOKEN,
    async handleEvent(event) {
      eventCalls += 1;
      order.push(`event:${event.recordId}`);
      eventStarted.resolve();
      await gate.promise;
      return {httpStatus: 200, data: {handled: 'event'}};
    },
    handleReconcile(event) {
      reconcileCalls += 1;
      reconciledEvent = event;
      order.push(`reconcile:${event.recordId}`);
      return {httpStatus: 200, data: {handled: 'reconcile'}};
    },
  }, async (baseUrl) => {
    const eventRequest = post(baseUrl, '/talent-screened', EVENT);
    await eventStarted.promise;
    const reconcileRequest = post(baseUrl, '/talent-reconcile', {
      ...EVENT,
      recordId: 'recReconcileOnly',
    });
    try {
      await delay(75);
      assert.equal(reconcileCalls, 0);
    } finally {
      gate.resolve();
    }
    const [eventResponse, reconcileResponse] = await Promise.all([
      eventRequest,
      reconcileRequest,
    ]);
    assert.equal(eventResponse.status, 200);
    assert.equal(reconcileResponse.status, 200);
  });

  assert.equal(eventCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(reconciledEvent.recordId, 'recReconcileOnly');
  assert.deepEqual(order, [
    'event:recSynthetic123',
    'reconcile:recReconcileOnly',
  ]);
});

test('aborted clients do not leave rejected request promises unhandled', async () => {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  let calls = 0;

  await withServer({
    token: TOKEN,
    async handleEvent() {
      calls += 1;
      handlerStarted.resolve();
      await releaseHandler.promise;
      return {httpStatus: 200, data: {ok: true}};
    },
  }, async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/talent-screened`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(EVENT),
      signal: controller.signal,
    });
    try {
      await handlerStarted.promise;
      controller.abort();
      await assert.rejects(request, /abort/i);
    } finally {
      releaseHandler.resolve();
    }
    await delay(25);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  });

  assert.equal(calls, 1);
});


test('invalid or unserializable handler responses become generic 503s', async () => {
  let calls = 0;
  await withServer({
    token: TOKEN,
    handleEvent() {
      calls += 1;
      if (calls === 1) {
        const data = {secret: TOKEN};
        data.self = data;
        return {httpStatus: 200, data};
      }
      return {httpStatus: 200, data: ['not-an-object']};
    },
  }, async (baseUrl) => {
    const circular = await post(baseUrl, '/talent-screened', EVENT);
    const circularText = await circular.text();
    assert.equal(circular.status, 503);
    assert.deepEqual(JSON.parse(circularText), {ok: false, error: 'service_unavailable'});
    assert.doesNotMatch(circularText, /synthetic-token|self/i);

    const invalid = await post(baseUrl, '/talent-screened', {
      ...EVENT,
      recordId: 'recInvalidResult',
    });
    await expectFixedError(invalid, 503, 'service_unavailable');
  });
  assert.equal(calls, 2);
});
