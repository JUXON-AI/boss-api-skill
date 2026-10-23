# HR communication corpus

The corpus improves tone through retrieval, not silent model training. Only HR-approved entries may influence later drafts.

## Source of truth

Use the live Feishu table configured in `./.codex/boss-recruiting.json` under `lark.talent_base.corpus_table_id`. The repository document `docs/hr-corpus-template.md` is a starter outline, not approval for any wording.

## Before drafting a message

Complete the CLI/skill/user-login checks in [lark-setup.md](lark-setup.md) before querying the live corpus. A local starter template is not a substitute for authenticated, HR-approved rows.

1. Classify the candidate situation into one or more scenario categories.
2. Query enabled rows from the corpus. For internship jobs use `岗位类型` of `实习` or `通用`; for full-time jobs use `全职` or `通用`. Prefer the current category and applicable round, then recent updated rows.
3. Use only enabled entries with nonempty `HR实际说法`; `AI建议话术` alone does not count as HR approval. Read `审核备注` as well: department, job and policy boundaries must match the current job and department knowledge. An internship/general label alone is insufficient. Treat `不建议说` as a hard warning list.
4. Adapt only the tone and structure. Re-check every fact against the current BOSS snapshot and job profile.
5. If no enabled row matches, draft from the base policy and mark the message for human review.

Filter-only query example:

```bash
lark-cli base +record-list \
  --as user \
  --base-token "$BASE_TOKEN" \
  --table-id "$CORPUS_TABLE_ID" \
  --field-id 场景编号 \
  --field-id 场景分类 \
  --field-id 触发情况 \
  --field-id AI建议话术 \
  --field-id HR实际说法 \
  --field-id 可替换内容 \
  --field-id 不建议说 \
  --field-id 使用渠道 \
  --field-id 适用轮次 \
  --field-id AI使用权限 \
  --field-id 审核状态 \
  --field-id 审核备注 \
  --filter-json '{"logic":"and","conditions":[["审核状态","intersects",["启用"]],["岗位类型","intersects",["全职","通用"]]]}' \
  --format json
```

Use `实习,通用` instead of `全职,通用` for an internship. If the query returns no enabled rows, do not invent approved examples. Draft normally and label it as unapproved.

## Feedback loop

After an HR-approved message is actually sent:

1. Identify the scenario and outcome.
2. Store the final natural text in `HR实际说法`, not the original AI draft.
3. Increment `使用次数`, set `最近使用时间`, and add any boundary conditions to `审核备注`.
4. Keep the entry `启用`; turn it into `停用` when it becomes misleading, obsolete, or unsafe.
5. Never store candidate phone numbers, email addresses, private credentials, or full personal histories in the corpus. Generalize the situation.

Do not automatically learn from every sent message. Only HR-reviewed, job-relevant and reusable wording belongs in the corpus.

## Targeted tuning from actual HR replies

When the user authorizes tuning from HR replies, identify concrete scenarios and separate the source from the rewrite:

1. Verify that the source is an actual human HR reply, not an Agent-authored outgoing message. A shared account's outgoing direction alone does not prove human authorship; compare known Agent attempt/message IDs and the observed human handover. If ambiguous, keep the source unresolved.
2. Extract only the reusable answer and remove candidate identity, contact details, private links and full conversation history. Keep source message IDs and attribution evidence locally; put a generalized source date and scope in `审核备注`.
3. Preserve HR wording in `HR实际说法`; put the proposed improvement in `AI建议话术`. Prefer a direct answer, then the necessary boundary and next step. Do not turn “may apply” into approval, or a specific department's support into a company-wide guarantee.
4. Read current fields/options and search existing scenario IDs before writing. For a new department/job variant, add a scoped record rather than overwriting a generic template. Do not add field options or change table structure implicitly.
5. A new rewrite is `待HR确认` and `仅参考` until the final wording is approved. Saving a real HR source does not approve the Agent rewrite. Existing enabled records retain their state unless the user's authorized update changes it; unresolved contradictory policy must not be enabled automatically.
6. Usage counts and last-use times refer to observed actual sends, not generated drafts or candidate outcomes. Do not infer effectiveness from a sent/read receipt alone.
7. Save the write receipt and verify the returned record IDs and relevant fields. If the write outcome is unknown, search the exact scenario IDs before any retry. Report whether the entry is a draft or enabled. Corpus write success does not prove a candidate's talent-record handoff or department knowledge-base publication.
