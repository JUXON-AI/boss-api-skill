# Scoring and communication policy

## Evidence hierarchy

Use the current run snapshot as the only candidate-specific source. Within a snapshot:

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
| 75–89 | Strong evidence, multiple details, validation or measurable outcome |
| 90–100 | Exceptional depth or independently verified production evidence |

If a dimension has no usable evidence, use `null`. Never replace missing evidence with zero.

Default dimensions and weights:

| Dimension | Weight |
| --- | ---: |
| `core_role_skills` | 35 |
| `project_depth` | 30 |
| `engineering_habits` | 20 |
| `learning_and_collaboration` | 15 |

Compute `ability_score` over known dimensions only:

```text
sum(weight × score for non-null dimensions)
÷ sum(weight for non-null dimensions)
```

Use `evidence_coverage_percent = sum(weight of non-null dimensions)`. Report both the score and coverage. A score without coverage is not a pass.

## Job-fit scoring

Use four fit factors with equal unit scale:

- role skill alignment: 35
- project/proof depth: 25
- engineering and AI-assisted validation: 15
- confirmed logistics: 25

Use the same known-dimension normalization. Missing logistics stays unknown. An explicit location, schedule, duration, or start-date conflict produces `hard_condition_status=conflict` and caps `job_fit_score` at 39. A candidate preference that has not been confirmed is `unknown`, not a conflict.

## Candidate state and decision

Use these enum values:

- `ready_for_contact`: enough role evidence to ask the next high-value questions; no confirmed hard conflict.
- `needs_more_info`: evidence coverage is below 60%, core skills or project ownership is unresolved, or a critical logistics answer is pending.
- `awaiting_candidate_reply`: a question has been sent and the next action is to wait.
- `ai_screened_pass`: after no more than two substantive rounds, evidence coverage is at least 70%, ability score is at least 60, logistics do not conflict, and a HR handoff summary is ready.
- `talent_pool_candidate`: ability score is at least 65 but current-role timing, logistics, or scope does not fit, or the candidate may fit another role.
- `current_role_mismatch`: explicit hard conflict for the current job.
- `stop_contact`: candidate declined or requested no further contact.

These are workflow recommendations only. A human still decides interview and hire outcomes.

`next_round` is the substantive round number proposed by the current message: `1`, `2`, or `0` when no message should be sent. Requesting an attachment as part of the next message still counts as that round.

## Two-round conversation

### Round 1

Confirm role direction, project ownership, AI-assisted workflow, and how generated code was validated. Request an attachment only when it is necessary to verify material claims. Ask no more than three concise questions.

### Round 2

For internships: confirm daily pay, location, days per week, minimum internship duration, school paperwork and start date.

For full-time roles: confirm monthly salary expectations, current employment and handover period, location/work mode, role direction or level and earliest start date. Ask about another offer deadline only when relevant. Do not repeat answered questions; confirm salary structures and benefits with HR rather than inventing them.

After round 2, generate the HR handoff summary. Do not continue technical interviewing over BOSS chat.

## Approved status language

Before an internal handoff:

> 简历已收到并完成初步评估，经历与岗位方向比较匹配。后续会由招聘团队进一步复核；若进入下一轮，我们会通过 BOSS 或您简历中的邮箱联系并确认面试安排，最终结果以正式通知为准。

After a real Base/HR handoff exists:

> 简历已提交给招聘团队进一步审核。若通过本轮筛选，我们会通过 BOSS 或您简历中的邮箱联系并确认下一步安排，最终结果以正式通知为准。

Use contact channels only when the company workflow supports them. Do not guarantee an email.

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
- ability score, coverage, and evidence
- job-fit score and hard-condition status
- confirmed facts, unverified claims, unknowns
- attachment status
- proposed message and stop conditions
- `requires_human_review: true`
