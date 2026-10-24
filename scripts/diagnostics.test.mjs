import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {attachDiagnosticContext, serializeDiagnosticError} from './diagnostics.mjs';

test('diagnostic serialization keeps a stable error envelope and JSON-safe bounded values', () => {
  const secondary = new TypeError('native reset', {cause: {code: 'ECONNRESET'}});
  const primary = new Error('Inspector CDP request timed out; no automatic mutation retry', {cause: secondary});
  primary.code = 'CDP_REQUEST_TIMEOUT';
  attachDiagnosticContext(primary, {
    stage: 'cdp', action: 'Runtime.evaluate', requestId: 20, elapsedMs: 20000, transport: 'websocket',
  });
  const result = serializeDiagnosticError(primary);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.stage, 'cdp');
  assert.equal(result.action, 'Runtime.evaluate');
  assert.equal(result.requestId, 20);
  assert.equal(result.elapsed, 20000);
  assert.equal(result.elapsedMs, 20000);
  assert.equal(result.code, 'CDP_REQUEST_TIMEOUT');
  assert.equal(result.name, 'Error');
  assert.match(result.message, /request timed out/);
  assert.equal(result.cause.name, 'TypeError');
  assert.match(result.stack, /Error:/);
  assert.equal(result.context.transport, 'websocket');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test('diagnostic serialization redacts credentials, identifiers, expressions, payloads, URLs and private paths', () => {
  const error = new Error('Cookie: session=secret-value at https://user:pass@example.test/signed?token=abc; auth_key=FIXTURE_SIGNED_VALUE; securityId=sec-123; encryptUid=enc-456; token=secret-token body=private-chat-body payload=private-payload expression=private-expression');
  error.stack = 'Error: fixture\n    at C:\\Users\\private-user\\project\\scripts\\runtime.mjs:10:2';
  const own = {name: 'fixture'};
  own.self = own;
  const result = serializeDiagnosticError(error, {
    stage: 'sdk',
    action: 'invoke',
    rawExpression: 'window.iBossRoot.chat.sendMessage("private chat body", target)',
    payload: {securityId: 'sec-789', encryptUid: 'enc-012', text: 'private chat body'},
    cookie: 'session-cookie-value',
    token: 'bearer-token-value',
    signedUrl: 'https://example.test/download?signature=private-signature',
    context: own,
    long: 'x'.repeat(5000),
  });
  const json = JSON.stringify(result);
  for (const forbidden of [
    'private-user', 'private chat body', 'sec-123', 'enc-456', 'session-cookie-value', 'bearer-token-value',
    'private-signature', 'sec-789', 'enc-012', 'user:pass', 'FIXTURE_SIGNED_VALUE', 'secret-token', 'private-chat-body', 'private-payload', 'private-expression',
  ]) assert.equal(json.includes(forbidden), false, forbidden);
  assert.equal(result.context.rawExpression, '[REDACTED]');
  assert.equal(result.context.payload, '[REDACTED]');
  assert.equal(result.context.cookie, '[REDACTED]');
  assert.equal(result.context.token, '[REDACTED]');
  assert.match(result.stack, /runtime\.mjs:10:2/);
  assert.equal(result.context.signedUrl, '[REDACTED]');
  assert.equal(result.context.context.self, '[CIRCULAR]');
  assert.ok(result.context.long.length < 5000);
  assert.doesNotThrow(() => JSON.parse(json));
});

test('explicit serialization context overrides attached defaults without exposing thrown non-errors', () => {
  const error = new Error('fixture failure');
  attachDiagnosticContext(error, {stage: 'old-stage', requestId: 1});
  const result = serializeDiagnosticError(error, {stage: 'cleanup', elapsed: 12});
  assert.equal(result.stage, 'cleanup');
  assert.equal(result.requestId, 1);
  assert.equal(result.elapsed, 12);
  const primitive = serializeDiagnosticError('opaque failure', {stage: 'orchestration', code: 'FIXTURE'});
  assert.equal(primitive.stage, 'orchestration');
  assert.equal(primitive.code, 'FIXTURE');
  assert.equal(primitive.cause, 'opaque failure');
  assert.doesNotThrow(() => JSON.stringify(primitive));
});
test('diagnostic serialization redacts inline JSON text and body values', () => {
  const error = new Error('failure {"body":{"text":"FIXTURE_PRIVATE_BODY"},"payload":"FIXTURE_PAYLOAD"}');
  const result = serializeDiagnosticError(error, {stage: 'sdk'});
  const json = JSON.stringify(result);
  assert.equal(json.includes('FIXTURE_PRIVATE_BODY'), false);
  assert.equal(json.includes('FIXTURE_PAYLOAD'), false);
  assert.match(result.message, /failure/);
  assert.doesNotThrow(() => JSON.parse(json));
});

test('stack redaction keeps Windows and POSIX basenames with line and column while hiding users', () => {
  const windows = new Error('windows');
  windows.stack = 'Error: windows\n    at main (C:\\Users\\PRIVATE_USER\\project\\scripts\\runtime.mjs:111:20)';
  const posix = new Error('posix');
  posix.stack = 'Error: posix\n    at main (/home/PRIVATE_USER/project/scripts/runtime.mjs:111:20)';
  const windowsStack = serializeDiagnosticError(windows, {stage: 'read'}).stack;
  const posixStack = serializeDiagnosticError(posix, {stage: 'read'}).stack;
  for (const stack of [windowsStack, posixStack]) {
    assert.match(stack, /runtime\.mjs:111:20/);
    assert.equal(stack.includes('PRIVATE_USER'), false);
  }
});

test('diagnostic serialization preserves a cross-realm error cause message', () => {
  const foreign = vm.runInNewContext('new TypeError("fixture reset", {cause: {code: "ECONNRESET"}})');
  const result = serializeDiagnosticError(new Error('outer', {cause: foreign}), {stage: 'discovery'});
  assert.equal(result.stage, 'discovery');
  assert.equal(result.cause.name, 'TypeError');
  assert.equal(result.cause.message, 'fixture reset');
  assert.equal(result.cause.cause.code, 'ECONNRESET');
});

test('diagnostic serialization has no side effects on frozen errors and bounds top-level context', () => {
  const frozen = Object.freeze(new Error('fixture'));
  const result = serializeDiagnosticError(frozen, {stage: 'read'});
  assert.equal(result.stage, 'read');
  assert.equal(result.message, 'fixture');
  assert.equal(Object.isFrozen(frozen), true);
  const context = Object.fromEntries(Array.from({length: 50}, (_, index) => ['field' + index, index]));
  const bounded = serializeDiagnosticError(new Error('bounded'), {stage: 'context', ...context});
  assert.ok(Object.keys(bounded.context).length <= 41);
  assert.equal(bounded.context['[TRUNCATED]'], true);
});
test('cleanup context merges inner and outer cleanup failures', () => {
  const primary = new Error('primary');
  primary.code = 'FIXTURE_PRIMARY';
  attachDiagnosticContext(primary, {stage: 'sdk', cleanup: [{stage: 'cleanup', action: 'close-inspector'}]});
  attachDiagnosticContext(primary, {cleanup: [{stage: 'cleanup', action: 'release-send-lock'}]});
  const result = serializeDiagnosticError(primary);
  assert.equal(result.stage, 'sdk');
  assert.equal(result.context.cleanup.length, 2);
  assert.equal(result.context.cleanup[0].action, 'close-inspector');
  assert.equal(result.context.cleanup[1].action, 'release-send-lock');
});
test('nested plain stack strings keep basename locations while hiding user paths', () => {
  const result = serializeDiagnosticError(new Error('nested stack'), {
    stage: 'runner',
    nested: {stack: '    at C:\\Users\\PRIVATE_USER\\runner.mjs:1:1'},
  });
  assert.match(result.context.nested.stack, /runner\.mjs:1:1/);
  assert.equal(result.context.nested.stack.includes('PRIVATE_USER'), false);
});

test('a stable outer code preserves a differing native numeric code', () => {
  const error = new Error('native remote');
  error.code = -32000;
  attachDiagnosticContext(error, {stage: 'ownership', code: 'CDP_REMOTE_ERROR'});
  const result = serializeDiagnosticError(error);
  assert.equal(result.code, 'CDP_REMOTE_ERROR');
  assert.equal(result.nativeCode, -32000);
});