import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';

const SERVICE = 'boss-talent-push';
const VERSION = 1;
const MAX_BODY_BYTES = 4_096;
const MAX_QUEUE_LENGTH = 8;
const EVENT_TYPE = 'talent.base_verified';
const EVENT_KEYS = new Set(['type', 'jobId', 'uid', 'recordId']);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i;
const BEARER_TOKEN = /^[\x21-\x7e]{32,}$/;

class HttpInputError extends Error {
  constructor(status) {
    super('invalid HTTP input');
    this.status = status;
  }
}

class QueueOverflowError extends Error {
  constructor() {
    super('handler queue is full');
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPositiveId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return String(parsed);
}

function normalizeEvent(value) {
  if (!isPlainObject(value)) throw new HttpInputError(400);
  const keys = Object.keys(value);
  if (keys.length !== EVENT_KEYS.size || !keys.every((key) => EVENT_KEYS.has(key))) {
    throw new HttpInputError(400);
  }
  const jobId = canonicalPositiveId(value.jobId);
  const uid = canonicalPositiveId(value.uid);
  if (value.type !== EVENT_TYPE
    || jobId === null
    || uid === null
    || typeof value.recordId !== 'string'
    || value.recordId.length > 80
    || !/^rec[a-zA-Z0-9]+$/.test(value.recordId)) {
    throw new HttpInputError(400);
  }
  return {
    type: EVENT_TYPE,
    jobId,
    uid,
    recordId: value.recordId,
  };
}

// One active handler plus at most `capacity` waiting requests, shared by both POST routes.
function createSerialQueue(capacity) {
  const waiting = [];
  let active = false;

  function drain() {
    if (active) return;
    const next = waiting.shift();
    if (next === undefined) return;
    active = true;
    Promise.resolve()
      .then(next.action)
      .then(next.resolve, next.reject)
      .then(() => {
        active = false;
        drain();
      });
  }

  return (action) => new Promise((resolve, reject) => {
    if (active && waiting.length >= capacity) {
      reject(new QueueOverflowError());
      return;
    }
    waiting.push({action, resolve, reject});
    drain();
  });
}

function responseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    status = 503;
    body = JSON.stringify({ok: false, error: 'service_unavailable'});
  }
  try {
    response.writeHead(status, {
      ...responseHeaders(),
      'Content-Length': Buffer.byteLength(body),
      'Connection': 'close',
    });
    response.end(body);
  } catch {
    response.destroy();
  }
}

function sendFixedError(response, status, error) {
  sendJson(response, status, {ok: false, error});
}

function hasOriginHeader(request) {
  return Object.hasOwn(request.headers, 'origin');
}

function isAuthorized(request, expectedAuthorization) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const actual = Buffer.from(authorization, 'latin1');
  if (actual.length !== expectedAuthorization.length) return false;
  return timingSafeEqual(actual, expectedAuthorization);
}

function hasJsonContentType(request) {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && JSON_CONTENT_TYPE.test(contentType);
}

function declaredBodyLength(request) {
  const raw = request.headers['content-length'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new HttpInputError(400);
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new HttpInputError(413);
  if (length > MAX_BODY_BYTES) throw new HttpInputError(413);
  return length;
}

function readBoundedBody(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let declaredLength;
    const chunks = [];

    const cleanup = () => {
      request.off('aborted', onAborted);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    };

    const fail = (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!request.destroyed) request.resume();
      reject(new HttpInputError(status));
    };

    const onAborted = () => fail(400);
    const onError = () => fail(400);
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(413);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      if (declaredLength !== null && size !== declaredLength) {
        fail(400);
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    };

    try {
      declaredLength = declaredBodyLength(request);
    } catch (error) {
      cleanup();
      if (!request.destroyed) request.resume();
      reject(error);
      return;
    }

    request.on('aborted', onAborted);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

async function readEvent(request) {
  const body = await readBoundedBody(request);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpInputError(400);
  }
  return normalizeEvent(parsed);
}

function normalizeHandlerResponse(result) {
  if (result === undefined) {
    return {status: 200, data: {ok: true}};
  }
  if (!isPlainObject(result)
    || Object.keys(result).length !== 2
    || !Object.hasOwn(result, 'httpStatus')
    || !Object.hasOwn(result, 'data')
    || !Number.isInteger(result.httpStatus)
    || result.httpStatus < 200
    || result.httpStatus > 599
    || !isPlainObject(result.data)) {
    throw new TypeError('invalid handler response');
  }
  return {status: result.httpStatus, data: result.data};
}

function configureRequest(request, response) {
  request.on('error', () => {});
  response.on('error', () => {});
}

export function createTalentPushHttpServer({token, handleEvent, handleReconcile, configId} = {}) {
  if(configId!==undefined&&(typeof configId!=='string'||!/^[a-f0-9]{64}$/.test(configId)))throw new TypeError('configId must be a SHA-256 binding');
  if (typeof token !== 'string' || !BEARER_TOKEN.test(token)) {
    throw new TypeError('token must be at least 32 visible ASCII characters');
  }
  if (typeof handleEvent !== 'function') {
    throw new TypeError('handleEvent must be a function');
  }
  if (handleReconcile !== undefined && typeof handleReconcile !== 'function') {
    throw new TypeError('handleReconcile must be a function when provided');
  }

  const expectedAuthorization = Buffer.from(`Bearer ${token}`, 'ascii');
  const enqueue = createSerialQueue(MAX_QUEUE_LENGTH);

  return http.createServer((request, response) => {
    configureRequest(request, response);
    void (async () => {
      if (hasOriginHeader(request)) {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 403, 'origin_forbidden');
        return;
      }

      if (request.url === '/health') {
        if (request.method !== 'GET') {
          if (!request.destroyed) request.resume();
          sendFixedError(response, 405, 'method_not_allowed');
          return;
        }
        sendJson(response, 200, {ok: true, service: SERVICE, version: VERSION,...(configId?{configId}:{})});
        return;
      }

      const isScreened = request.url === '/talent-screened';
      const isReconcile = request.url === '/talent-reconcile';
      if (!isScreened && !isReconcile) {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 404, 'not_found');
        return;
      }
      if (request.method !== 'POST') {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 405, 'method_not_allowed');
        return;
      }
      if (isReconcile && handleReconcile === undefined) {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 404, 'not_found');
        return;
      }
      if (!isAuthorized(request, expectedAuthorization)) {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 401, 'unauthorized');
        return;
      }
      if (!hasJsonContentType(request)) {
        if (!request.destroyed) request.resume();
        sendFixedError(response, 415, 'unsupported_media_type');
        return;
      }

      let event;
      try {
        event = await readEvent(request);
      } catch (error) {
        if (error instanceof HttpInputError) {
          sendFixedError(response, error.status, error.status === 413 ? 'payload_too_large' : 'bad_request');
        } else {
          sendFixedError(response, 503, 'service_unavailable');
        }
        return;
      }

      try {
        const handler = isReconcile ? handleReconcile : handleEvent;
        const result = await enqueue(() => handler(event));
        const normalized = normalizeHandlerResponse(result);
        sendJson(response, normalized.status, normalized.data);
      } catch (error) {
        if (error instanceof QueueOverflowError) {
          sendFixedError(response, 429, 'queue_full');
        } else {
          sendFixedError(response, 503, 'service_unavailable');
        }
      }
    })().catch(() => {
      sendFixedError(response, 503, 'service_unavailable');
    });
  });
}

