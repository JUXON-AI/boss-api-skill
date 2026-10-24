# Scoring and communication policy

## Evidence hierarchy

For internships, clarify capabilities through ordinary conversation: technologies, tools, personally owned features, and work the candidate can complete independently. Do not request code verification, exercises, benchmark results or validation materials. First messages start with “你好”, without prefixing a name.

Use the current fresh history snapshot plus explicitly recorded public GitHub observations as the only candidate-specific evidence. A GitHub URL by itself is a claim until its authorship and contribution scope have been inspected. Within a BOSS snapshot:

1. `history.zpData.messages` is the authoritative conversation source.
2. If a legacy snapshot includes `derived.latest_inbound_text` or `derived.latest_outbound_text`, they are convenience projections only. New technical history snapshots may omit `derived`; inspect the original messages and timestamps.
3. A BOSS `body.resume` object is a profile summary card. It is not an attachment PDF.
4. Distinguish an attachment request, a received attachment link, a downloaded PDF and parsed text. Only report the stage actually observed in history or download evidence.
5. `body.resume.city` is the candidate's present/profile location. It does not prove willingness or refusal to work elsewhere.
6. `body.resume.salary` is the candidate's salary field; `body.resume.jobSalary` is the posted job salary. Do not merge their semantics.

## Dimension anchors

Use a 0–100 score for dimensions with enough evidence:

| Score | Meaning |
| ---: | --- |
| 0–19 | Explicit weak evidence or direct contradiction |
| 20–39 | Very limited or secondhand evidence |
| 40–59 | Basic alignment, mostly self-reported with no concrete detail |
| 60–74 | Concrete relevant evidence with some technical ownership |
| 75–89 | Detailed relevant capability descriptions and personal responsibility; internships do not require a validation exercise |
| 90–100 | Exceptional relevant depth and clearly described scope; do not turn internship chat into a proof exercise |

If a dimension has no usable evidence, use `null`. Never replace missing evidence with zero.

Cost gate: after one review of the existing compact resume/greeting packet, if the reviewed `abilityBaseScore` is still null (“待了解”), skip that candidate for this batch. Do not spend another enrichment pass, delegate deeper research or send capability questions to fill an entirely unknown base. Keep the null score and source, with a local skip reason; this is neither a screening pass nor an automatic rejection notification. A known numeric base with some null dimensions remains eligible for ordinary review. Competition bonuses cannot rescue an unknown base. Apply this gate to the reviewed scoring result, not the batch collector's lexical `analysis.abilityScore`, which is deliberately null for every unreviewed record.

Default dimensions and weights:

| Dimension | Weight |
| --- | ---: |
| `core_role_skills` | 35 |
| `project_depth` | 30 |
| `engineering_habits` | 20 |
| `learning_and_collaboration` | 15 |

For internships, the legacy `engineering_habits` key means development-tool usage and practical working ability, including AI-assisted development. It does not require a code-verification answer. Compute the base ability score over known dimensions only:

```text
sum(weight × score for non-null dimensions)
÷ sum(weight for non-null dimensions)
```

### Proof bonus

Keep three quantities separate: `abilityBaseScore`, `proofBonus`, and `finalSignalScore`.

```text
proofBonus = min(24, competitionBonus + githubBonus)
finalSignalScore = min(100, abilityBaseScore + proofBonus)
```

Proof signals affect ranking and the final signal, but never increase ability evidence coverage. An unknown `abilityBaseScore` stays unknown and is skipped even with strong awards or GitHub. A high proof bonus also cannot by itself rescue a weak base above the screening gate.

Competition rubric uses the strongest job-relevant award, not the sum:

| Level | 1st | 2nd | 3rd |
| --- | ---: | ---: | ---: |
| National | 18 | 15 | 12 |
| Provincial | 12 | 9 | 6 |
| School | 4 | 3 | 2 |

Apply an evidence multiplier:

- `verified` or `publicly_observed`: 1.0.
- `document_provided`: 1.0, while still recording that authenticity was not independently checked.
- `self_reported`: 0.75 provisional.
- Unknown level, prize or relevance: 0 until resolved. Do not request certificates merely to continue the conversation.

### GitHub proof

A GitHub link by itself adds 0. Inspect the public repository without executing candidate code and record `repo`, `source`, `relation`, `isFork`, `candidateAuthoredCommits`, `substantiveContribution`, `mergedPullRequests`, `hasTestsOrDemo`, `jobRelevant`, and `claimStatus`. Use only `publicly_observed` or `verified` GitHub evidence for scoring.

- Credit only candidate-attributable work: authored commits, merged pull requests, or clearly attributable changes in forks. A fork that only contains upstream code scores 0.
- In a fork, compare against upstream and ignore files or commits that merely mirror the parent. Candidate-authored commits or merged changes can receive the same evidence as other repositories.
- The strongest relevant repository contributes; do not sum every repository.
- Start at 8 points for one substantive attributable contribution; add 4 for at least five commits or one merged PR; add 4 for at least twenty substantive commits or at least ten as repository owner; add 2 for a test suite, runnable demo, or other inspectable evidence. A fork contribution receives a 1-point discount. Cap GitHub at 18.
- Read-only inspection can establish code presence and authorship signals. It does not prove that every listed feature works, so do not execute untrusted project code or label the capability as independently validated.

`scripts/scoring.mjs` computes all derived values deterministically. Store the reviewed inputs and evidence in the candidate record; never type a final score independently.

Use `evidence_coverage_percent = sum(weight of non-null dimensions)`. Report both the score and coverage. A score without coverage is not a pass.

## Job-fit scoring

Use four fit factors with equal unit scale:

- role skill alignment: 35
- project/proof depth: 25
- practical development and tool usage: 15 (for internships; no validation exercise)
- confirmed logistics: 25

Use the same known-dimension normalization. Missing logistics stays unknown. An explicit location, schedule, duration, or start-date conflict produces `hard_condition_status=conflict` and caps `job_fit_score` at 39. A candidate preference that has not been confirmed is `unknown`, not a conflict.

## Candidate state and decision

Use these enum values:

- `ready_for_contact`: enough role evidence to ask the next high-value questions; no confirmed hard conflict.
- `needs_more_info`: evidence coverage is below 60%, core skills or project ownership is unresolved, or a critical logistics answer is pending.
- `awaiting_candidate_reply`: a question has been sent and the next action is to wait.
- `ai_screened_pass`: after no more than two substantive rounds, evidence coverage is at least 70%, `abilityBaseScore >= 60`, `finalSignalScore >= 65`, logistics do not conflict, and a HR handoff summary is ready. The base gate is mandatory, so proof evidence cannot convert an unknown or weak ability base into a pass.
- `talent_pool_candidate`: `abilityBaseScore >= 65` and `finalSignalScore >= 70`, but current-role timing, logistics, or scope does not fit, or the candidate may fit another role.
- `current_role_mismatch`: explicit hard conflict for the current job.
- `stop_contact`: candidate declined or requested no further contact.

These are workflow recommendations only. A human still decides interview and hire outcomes.

`next_round` is the substantive round number proposed by the current message: `1`, `2`, or `0` when no message should be sent. Requesting an attachment as part of the next message still counts as that round.

## Two-round conversation

### Round 1

For internships, ask what technologies and AI tools the candidate can use, what features they personally built, and what they can complete independently. Invite relevant competition awards or a public GitHub contribution as an optional addition. Ask no more than three concise questions and use already provided answers. Do not ask interns to validate code, explain a verification process, take tests, or submit evidence materials. Full-time questions depend on the confirmed job profile. Do not routinely request attachments.

### Round 2

For internships: confirm daily pay, location, days per week, minimum internship duration, school paperwork and start date.

For full-time roles: confirm monthly salary expectations, current employment and handover period, location/work mode, role direction or level and earliest start date. Ask about another offer deadline only when relevant. Do not repeat answered questions; confirm salary structures and benefits with HR rather than inventing them.

After round 2, generate the HR handoff summary. Do not continue technical interviewing over BOSS chat.

## Approved status language

Before an internal handoff:

> 好的，了解了，我把你的能力情况和到岗安排整理一下，后续有进展会在 BOSS 上联系你。

After a real Base/HR handoff exists:

> 你的相关信息已转交给人事 HR 进一步处理，有消息会第一时间在 BOSS 上联系你。

If an actual incoming resume email in the recruiting team's Feishu mailbox has been matched to this BOSS candidate and the current job, replace the closing sentence with:

> 有消息会第一时间通过 BOSS 或你发送简历时使用的邮箱联系你。

Use the sender address of that matched resume email. A resume contact address, online profile or BOSS attachment alone does not establish this email channel. Keep the mail-message reference, identity match and job match in private local evidence only. If no matching mail is confirmed, retain the BOSS-only wording. Read and send mail under the `lark-mail` skill; this wording does not authorize sending email or prove mailbox access. Do not guarantee an email or describe an internal handoff before it actually succeeds.

Use the more explicit HR-handoff wording only after the actual handoff is verified, including a Base record readback when the workflow uses Base. “第一时间” refers to providing an update once there is news; it does not imply an interview, approval or a specific turnaround time. Do not send a second closing message merely to replace an earlier closing that has already been sent.

## Prohibited claims

- “你已通过筛选”
- “一定会有面试”
- “最终一定会发邮件”
- “已经录用” or salary promises before approval
- “我已经提交给 HR” without a real handoff record
- questions about age, gender, ethnicity, marital or parental status as hiring criteria

## Final handoff summary

Return JSON matching `assets/candidate-evaluation.schema.json`, containing:

- candidate identity and job identity
- state and recommendation
- `abilityBaseScore`, `finalSignalScore`, coverage, competition bonus, GitHub bonus, proof bonus, and evidence
- job-fit score and hard-condition status
- confirmed facts, unverified claims, unknowns
- attachment status
- proposed message and stop conditions
- candidate record path and `recordSha256` after the deterministic ledger confirms the score and state
- `requires_human_review: true`
