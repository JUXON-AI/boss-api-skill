const DIAGNOSTIC_SCHEMA_VERSION = 1;
const MAX_STRING = 1200;
const MAX_STACK = 6000;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_TOTAL_NODES = 240;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const CIRCULAR = '[CIRCULAR]';
const UNSAFE = '[UNAVAILABLE]';
const RESERVED_CONTEXT_KEYS = new Set(['stage', 'action', 'requestId', 'elapsed', 'elapsedMs', 'code', 'name', 'message', 'cause', 'stack']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY = /^(?:authorization|cookie|set[-_]?cookie|token|secret|password|passwd|auth[-_]?key|api[-_]?key|security[-_]?id|encrypt[-_]?uid|signature|signed[-_]?url|raw(?:[-_]?expression)?|expression|payload|text|body|content|url|href|session)$|(?:cookie|token|secret|password|passwd|signature|session|message)$|(?:chat|response|request|user|raw)(?:text|body|content|url|href)$/i;
const SENSITIVE_ASSIGNMENT = /((?:"?(?:authorization|cookie|set-cookie|token|secret|password|passwd|auth[-_]?key|api[-_]?key|security[-_]?id|encrypt[-_]?uid|signature|session|raw(?:[-_]?expression)?|expression|payload|text|body|content)"?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi;
const TOKEN_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const SENSITIVE_JSON_VALUE = /((?:"|')?(?:authorization|cookie|set-cookie|token|secret|password|passwd|auth[-_]?key|api[-_]?key|security[-_]?id|encrypt[-_]?uid|signature|session|raw(?:[-_]?expression)?|expression|payload|text|body|content)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]+)/gi;
const REMOTE_URL = /\b(?:https?|wss?|bosszp):\/\/[^\s"'<>]+/gi;
const STACK_PATH_WITH_BASENAME = /(?:(?:file:\/\/\/)?[A-Za-z]:[\\/](?:[^()\r\n]*[\\/])|\/(?:Users|home|tmp|var|private|opt|workspace)\/(?:[^()\r\n]*\/))([^\\/()\r\n]+)(?=:\d+(?::\d+)?)/g;

function boundedString(value, limit = MAX_STRING, {redactPaths = false} = {}) {
  let text;
  try {
    text = String(value);
  } catch {
    return UNSAFE;
  }
  text = text
    .replace(REMOTE_URL, '[REDACTED_URL]')
    .replace(BEARER, '[REDACTED_AUTH]')
    .replace(TOKEN_LIKE, '[REDACTED_TOKEN]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_JSON_VALUE, '$1[REDACTED]');
  if (redactPaths) text = text.replace(STACK_PATH_WITH_BASENAME, '$1');
  return text.length > limit ? text.slice(0, limit) + TRUNCATED : text;
}

function boundedLabel(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const label = boundedString(value, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(label) ? label : redactedValue(value);
}

function redactedValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return boundedString(value);
  if (typeof value === 'symbol') return boundedString(value.description ?? 'symbol');
  return REDACTED;
}

function safeScalar(value, {allowNumber = true} = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return boundedString(value, 160);
}

function getContext(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {};
  try {
    const context = error.diagnosticContext;
    return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  } catch {
    return {};
  }
}

function mergeContext(error, context) {
  const attached = getContext(error);
  const supplied = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  return {...attached, ...supplied};
}

function newSafeState() {
  return {ancestors: new WeakSet(), expanded: new WeakSet(), remaining: MAX_TOTAL_NODES};
}

function safeValue(value, depth = 0, state = newSafeState()) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return boundedString(value, MAX_STRING, {redactPaths: true});
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol') return boundedString(value);
  if (typeof value === 'function') return '[FUNCTION]';
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (typeof value !== 'object') return UNSAFE;
  if (state.ancestors.has(value)) return CIRCULAR;
  if (state.expanded.has(value)) return '[SHARED]';
  if (state.remaining <= 0) return TRUNCATED;
  state.remaining--;
  state.ancestors.add(value);
  state.expanded.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      const length = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let index = 0; index < length; index++) {
        try { items.push(safeValue(value[index], depth + 1, state)); }
        catch { items.push(UNSAFE); }
      }
      if (value.length > MAX_ARRAY_ITEMS) items.push(TRUNCATED);
      return items;
    }
    let errorLike = value instanceof Error;
    if (!errorLike) {
      try { errorLike = Object.prototype.toString.call(value) === '[object Error]'; } catch {}
    }
    if (errorLike) return safeError(value, depth + 1, state);
    const result = {};
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); }
    catch { return UNSAFE; }
    const keys = Reflect.ownKeys(descriptors).filter(key => typeof key === 'string' && (descriptors[key].enumerable || key === 'name' || key === 'code'));
    let count = 0;
    for (const key of keys) {
      if (count >= MAX_OBJECT_KEYS) break;
      if (DANGEROUS_KEYS.has(key)) continue;
      const outputKey = key.length > 80 ? key.slice(0, 80) + TRUNCATED : key;
      if (SENSITIVE_KEY.test(key)) {
        Object.defineProperty(result, outputKey, {value: REDACTED, enumerable: true});
        count++;
        continue;
      }
      const descriptor = descriptors[key];
      if (!('value' in descriptor)) {
        Object.defineProperty(result, outputKey, {value: UNSAFE, enumerable: true});
        count++;
        continue;
      }
      Object.defineProperty(result, outputKey, {value: safeValue(descriptor.value, depth + 1, state), enumerable: true, writable: true, configurable: true});
      count++;
    }
    if (keys.length > count) result[TRUNCATED] = true;
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function safeError(error, depth = 0, state = newSafeState(), contextOverride = null) {
  const context = contextOverride && typeof contextOverride === 'object' && !Array.isArray(contextOverride) ? contextOverride : getContext(error);
  let name = 'Error';
  let message = 'Operation failed';
  let stack = null;
  try { if (error?.name) name = boundedLabel(error.name, 'Error'); } catch {}
  try { if (error?.message) message = boundedString(error.message, MAX_STRING, {redactPaths: true}); } catch { message = UNSAFE; }
  try { if (error?.stack) stack = boundedString(error.stack, MAX_STACK, {redactPaths: true}); } catch { stack = UNSAFE; }
  let directCode = null;
  try { directCode = safeScalar(error?.code); } catch {}
  const contextCode = safeScalar(context.code);
  const elapsedCandidate = context.elapsedMs ?? context.elapsed;
  const elapsed = Number.isFinite(Number(elapsedCandidate)) && Number(elapsedCandidate) >= 0
    ? Math.min(Number(elapsedCandidate), 86_400_000)
    : null;
  const extras = {};
  let contextKeyCount = 0;
  for (const [key, value] of Object.entries(context)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) continue;
    if (contextKeyCount >= MAX_OBJECT_KEYS) break;
    const outputKey = key.length > 80 ? key.slice(0, 80) + TRUNCATED : key;
    if (SENSITIVE_KEY.test(key)) extras[outputKey] = REDACTED;
    else extras[outputKey] = safeValue(value, depth + 1, state);
    contextKeyCount++;
  }
  if (Object.keys(context).filter(key => !RESERVED_CONTEXT_KEYS.has(key)).length > contextKeyCount) extras[TRUNCATED] = true;
  let cause = null;
  try {
    if (error?.cause !== undefined && error.cause !== null) cause = safeValue(error.cause, depth + 1, state);
  } catch { cause = UNSAFE; }
  return {
    stage: boundedLabel(context.stage, 'unknown'),
    action: boundedLabel(context.action ?? context.method, null),
    requestId: safeScalar(context.requestId),
    elapsed,
    elapsedMs: elapsed,
    code: contextCode ?? directCode,
    nativeCode: contextCode !== null && directCode !== null && String(contextCode) !== String(directCode) ? directCode : null,
    name,
    message,
    cause,
    stack,
    context: extras,
  };
}

export function attachDiagnosticContext(error, context = {}) {
  const supplied = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    const wrapped = new Error('Operation failed', {cause: error});
    Object.defineProperty(wrapped, 'diagnosticContext', {value: {...supplied}, enumerable: false, configurable: true, writable: true});
    return wrapped;
  }
  const previous = getContext(error);
  const merged = {...supplied, ...previous};
  if (supplied.cleanup !== undefined && previous.cleanup !== undefined) {
    const previousCleanup = Array.isArray(previous.cleanup) ? previous.cleanup : [previous.cleanup];
    const suppliedCleanup = Array.isArray(supplied.cleanup) ? supplied.cleanup : [supplied.cleanup];
    merged.cleanup = [...previousCleanup, ...suppliedCleanup];
  }
  try {
    Object.defineProperty(error, 'diagnosticContext', {value: merged, enumerable: false, configurable: true, writable: true});
    return error;
  } catch {
    let message = 'Operation failed';
    try { message = error.message || message; } catch {}
    const wrapped = new Error(message, {cause: error});
    Object.defineProperty(wrapped, 'diagnosticContext', {value: merged, enumerable: false, configurable: true, writable: true});
    return wrapped;
  }
}

export function serializeDiagnosticError(error, context = {}) {
  const merged = mergeContext(error, context);
  const source = error && typeof error === 'object'
    ? error
    : new Error('Operation failed', {cause: error});
  return {schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, ...safeError(source, 0, newSafeState(), merged)};
}