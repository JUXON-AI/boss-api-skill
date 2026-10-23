# Feishu talent Base integration

Before corpus lookup or talent-pool sync, follow [lark-setup.md](lark-setup.md) to check/deploy the CLI and required Feishu skills on the current machine, configure the app if missing, and complete user QR authorization when needed. Use `--as user`; bot readiness is not user login. Verify the user identity, token and intended Base/table access. Reuse an existing valid session instead of forcing another scan.

Until this prerequisite passes, local drafts may continue, but do not claim HR corpus approval, successful Base sync, or completed HR handoff. A dry-run is not a real write-permission test.

## Admission gate

Create or update a Base record only when the candidate has passed AI screening for the current job. Keep `HR复核状态` at `待复核`; final hiring remains human-owned.

## Required fields

The current Base should contain at least:

- 岗位
- 薪资
- 姓名
- 年龄
- 性别
- 院校
- 院校评分
- 能力评分
- 岗位适应评分
- 最终联系时间
- 最快到岗时间
- 附件
- AI初筛结论
- 初筛依据
- HR复核状态

The Base URL, token, table ID, and field names belong in the workspace configuration file, not in the skill.

## Write sequence

1. Check that the workspace configuration points to the intended Base and table.
2. Read fields with `lark-cli base +field-list --as user`.
3. Search existing records before creating one. For identity, combine exact BOSS UID evidence held in the run manifest with role and name; do not rely on name alone.
4. Preview the write with `--dry-run`.
5. Create or update the record.
6. Read the record back and verify every field.

## Evidence handling

- Store a durable file link. Feishu Mail attachment download links are temporary signed URLs and must not be stored as long-term links.
- Record the source message date and BOSS sender in `初筛依据`.
- Preserve self-reported performance metrics as self-reported; never upgrade them to verified facts.
- Do not include phone, email, or attachment tokens unless HR needs them and access is appropriate.

## lark-cli shape

```bash
lark-cli base +record-batch-create \
  --as user \
  --base-token "$BASE_TOKEN" \
  --table-id "$TABLE_ID" \
  --json @record.json \
  --format json
```

For updates, use `+record-batch-update` keyed by the exact `record_id`, then read back with `+record-list`.

## Permissions

Check `drive +permission-get-setting`. “同租户可读” lets internal HR with the link view the Base and linked resume. Do not broaden to public or external access without an explicit audience decision.
