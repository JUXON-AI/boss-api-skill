import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {planLocationFieldPatch} from './location_fields.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function bound(file, sha) {
  assert.match(sha, /^[a-f0-9]{64}$/i);
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), sha, 'location source bytes changed');
  return JSON.parse(bytes.toString('utf8'));
}
function assertTarget(snapshot, candidate) {
  if (snapshot.candidate) {
    assert.equal(String(snapshot.candidate.uid), String(candidate.uid));
    assert.equal(snapshot.candidate.name, candidate.name);
    assert.equal(String(snapshot.candidate.jobId), String(candidate.jobId));
  } else {
    const messages = snapshot.history?.original_order_redacted ?? snapshot.history?.originalOrderRedacted
      ?? snapshot.response?.zpData?.messages ?? snapshot.zpData?.messages ?? snapshot.messages;
    const cards = messages?.filter(m => m.body?.resume);
    assert.ok(cards?.length, 'original snapshot must independently bind candidate and job');
    for (const m of cards) {
      assert.equal(String(m.from?.uid), String(candidate.uid));
      assert.equal(String(m.body.resume.user?.uid), String(candidate.uid));
      assert.equal(String(m.body.resume.jobId), String(candidate.jobId));
      assert.equal(m.body.resume.user?.name, candidate.name);
    }
  }
}

/** Descriptive metadata only. The caller has already verified the profile identity. */
export function buildTalentLocationPatch({candidate, source, sourceSha256, school,
  currentValue, locationPolicyFile, currentResidence} = {}) {
  if (!locationPolicyFile) return {patch: {}, status: 'unknown', reason: 'location_policy_not_configured'};
  const policy = read(locationPolicyFile);
  assert.equal(policy.enabled, true);
  assert.equal(String(policy.jobId), String(candidate.jobId), 'location policy job mismatch');
  const snapshot = bound(source, sourceSha256);
  const registry = bound(policy.registry.source, policy.registry.sourceSha256);
  assert.equal(hash(fs.readFileSync(registry.source)), registry.sourceSha256, 'school geography dataset changed');
  const normalized = registry.aliases?.[school] ?? school;
  const geography = registry.schools[normalized];
  const accepted = currentResidence ?? policy.acceptedResidence?.find(e => String(e.uid) === String(candidate.uid)
    && e.name === candidate.name && String(e.jobId) === String(candidate.jobId));
  if (accepted) {
    assert.equal(accepted.kind, 'current_residence');
    assert.equal(String(accepted.uid), String(candidate.uid));
    assert.equal(accepted.name, candidate.name);
    assert.equal(String(accepted.jobId), String(candidate.jobId));
    const original = accepted.source === source && accepted.sourceSha256 === sourceSha256
      ? snapshot : bound(accepted.source, accepted.sourceSha256);
    assertTarget(original, candidate);
    const messages = original.history?.original_order_redacted ?? original.history?.originalOrderRedacted
      ?? original.response?.zpData?.messages ?? original.zpData?.messages ?? original.messages;
    assert.ok(Array.isArray(messages));
    const message = messages.find(m => String(m.mid) === String(accepted.messageMid));
    assert.equal(String(message?.from?.uid), String(candidate.uid), 'residence must be candidate own message');
    assert.ok(typeof accepted.quote === 'string' && accepted.quote.includes(accepted.location));
    assert.match(accepted.quote, /我(?:现在|目前)?(?:就)?住在|现居(?:地)?|目前居住在/);
    assert.ok(JSON.stringify(message.body).includes(accepted.quote), 'residence quote missing from original message');
  }
  const schoolDefault = geography ? {...geography, kind: 'school_location',
    uid: candidate.uid, name: candidate.name, jobId: candidate.jobId,
    source, sourceSha256, school: normalized} : undefined;
  return planLocationFieldPatch({candidate, currentValue, currentResidence: accepted,
    schoolDefault, useSchoolDefault: policy.useSchoolDefault === true});
}
