# Deterministic candidate ledger

This workflow prevents long-running recruiting conversations from depending on an Agent's memory. The live BOSS history is the conversation fact source; one validated JSON record per `(boss_job_id, uid)` is the durable judgment source. The chat transcript, the batch report and an Agent's prior summary are never authoritative state.

## Source-of-truth order

1. Fresh complete BOSS history for the exact UID, name and `jobId`; retain its `historySha256`.
2. Explicit public evidence used for proof scoring, such as a candidate-authored GitHub contribution.
3. The candidate record under the private ledger directory.
4. Generated indexes and human-readable reports are projections only.

If these disagree, stop acting and rebuild the candidate record from the fresh history and evidence. Do not resolve a conflict from memory.

## Record layout

Use one record per candidate:

```text
<private-ledger>/<boss_job_id>/<uid>.json
```

The job and candidate identities are inside the record and the path must match them. Never store two records for the same job and UID. Raw chats, credentials, phone numbers, email bodies and PDF bytes stay outside the record; use source references and normalized facts.

The record schema is [candidate-record.schema.json](../assets/candidate-record.schema.json). The record binds:

- policy version and exact job-profile SHA-256;
- exact candidate identity and complete-history fingerprint;
- reviewed dimension inputs, competition evidence, GitHub evidence, deterministic score and job-fit gate;
- current state, confirmed facts, unverified claims, unknowns and next action;
- current round, last outbound message and pending inbound message IDs.

## Required update loop

Let `<skill>` be the recruiting skill directory and `<ledger>` a protected local directory.

```powershell
node <skill>\scripts\candidate_ledger.mjs hash --file <job-profile.json>
node <skill>\scripts\validate_contracts.mjs record <candidate-record.json>
node <skill>\scripts\candidate_ledger.mjs upsert --dir <ledger> --record <candidate-record.json> --job-profile <job-profile.json>
node <skill>\scripts\candidate_ledger.mjs show --dir <ledger> --job-id <boss-job-id> --uid <uid> --job-profile <job-profile.json>
node <skill>\scripts\candidate_ledger.mjs verify --dir <ledger>
node <skill>\scripts\candidate_ledger.mjs index --dir <ledger> --output <private-index.json>
```

For an existing record, `upsert` requires the current `recordSha256` returned by `show`:

```powershell
node <skill>\scripts\candidate_ledger.mjs upsert --dir <ledger> --record <new-record.json> --expected-sha256 <observed-record-sha256> --job-profile <job-profile.json>
```

A stale hash, changed job profile, duplicate identity, wrong job/UID path, incomplete history or score that differs from deterministic recomputation must stop the candidate workflow. Never bypass with a manual file overwrite.

## Batch and subagent protocol

1. The coordinator reads the job profile and generated index only to choose work.
2. Before each contact or reply, load just one candidate record with `show` and refresh that BOSS history.
3. If the history fingerprint or pending inbound IDs changed, update the facts and evaluation first; do not reuse the previous draft.
4. A subagent receives only the job profile and one candidate record. It returns evidence, proposed score inputs and a draft. It cannot read other candidates or send.
5. The coordinator recomputes the score, validates the updated record and performs any external action serially.
6. After every meaningful event, update the record with optimistic concurrency and run `verify`. Rebuild `index` only after verification passes.
7. After a confirmed send, set `awaiting_candidate_reply`, record the unique outbound `mid` and clear only the inbound IDs actually reviewed. After a confirmed Base readback, change to `hr_review`; after reloading the conversation, record the exact closing message separately.

The index is for routing, ranking and spotting stale records. It cannot justify a pass by itself.

## GitHub evidence

Public GitHub review is read-only. It must establish candidate attribution and job relevance before adding points.

- Owned or maintained repository: use candidate-authored commits and implementation scope.
- Fork: compare against upstream, exclude inherited files and commits, and count only candidate-authored substantive changes or merged contributions in that fork.
- External repository: use merged pull requests or other attributable changes.
- A dropped fork, copied upstream tree, empty repository, unrelated project or unverifiable commit count adds 0.
- Never execute candidate code. Static file inspection and public metadata are enough for ranking evidence.

Store both the normalized evidence and source URL in `score.github_projects`; store the resulting bonus from `scripts/scoring.mjs`, not a hand-typed value.

## Fail-closed rules

- History incomplete, `hasMore=true`, identity ambiguity, duplicate record or score mismatch: stop.
- Unknown `abilityBaseScore`: record `skipped_unknown_base`, recommendation `skip`, round `0`; do not enrich or message this batch.
- More than two substantive rounds: stop and hand the existing evidence to HR; do not continue technical questioning.
- Send result unknown: preserve the attempt, do not retry, inspect history and reconcile manually.
- Policy or job-profile version changed: re-evaluate before the next decision.
- Record cannot be updated with the expected hash: preserve both versions and reconcile; never last-write-wins.