# Feishu talent Base integration

Before corpus lookup or talent-pool sync, follow [lark-setup.md](lark-setup.md) to check/deploy the CLI and required Feishu skills on the current machine, configure the app if missing, and complete user QR authorization when needed. Use `--as user`; bot readiness is not user login. Verify the user identity, token and intended Base/table access. Reuse an existing valid session instead of forcing another scan.

Until this prerequisite passes, local drafts may continue, but do not claim HR corpus approval, successful Base sync, or completed HR handoff. A dry-run is not a real write-permission test.

## Admission gate

Create or update a Base record only when the candidate has passed AI screening for the current job. Keep `HR复核状态` at `待复核`; final hiring remains human-owned.

An explicitly authorized descriptive-field backfill of an existing record is a separate maintenance operation. It must not re-evaluate admission, create another record, send another handoff, or change scores, HR status or contact time.

## Required fields

The current Base should contain at least:

- 岗位
- 薪资
- 姓名
- 年龄
- 性别
- 院校
- 学历
- 现居地
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

## Confirmed profile fields

Age, gender and school are descriptive facts, never screening or scoring inputs. Do not infer them from names, photos, graduation year, job titles or school reputation. Use original profile-card fields bound to the exact candidate UID, name and job. Keep source path, actual file-byte SHA-256, message ID, timestamp and raw field evidence in protected outputs. Do not download a resume to fill these fields.

Use `scripts/talent_profile_fields.mjs` at the file-I/O boundary. It verifies actual snapshot bytes and identity before extraction. `buildTalentCreateValues` enriches a new record's values; `buildTalentProfilePatch` builds an existing record's fill-only patch. The pure `profile_fields.mjs` helpers alone do not verify files and must not be the final write boundary.

```js
const enriched = buildTalentCreateValues({
  candidate: {uid, name, jobId}, values,
  source: originalSnapshotPath, sourceSha256: actualSnapshotByteSha256,
  genderMappingFile, aliasesFile, locationPolicyFile, educationPolicyFile,
});
// Save enriched.profile as evidence; use enriched.values in create_records
// BEFORE the real payload SHA, dry-run, write and independent readback.
```

学历与排名遵循[资料模块的来源规则](../../boss-recruiting-profile/references/education-ranking.md)。`educationPolicyFile`引用已核验官方2026排名catalog及原始响应的实际字节SHA；构造器核本人明确学历、精确学校和原始排名响应，写“学历”及“学校（排名）”。无法匹配的学校保留原名，不伪造排名。分类榜保留类别，官方排名区间不改精确名次。新字段增加后按fresh schema逐字段读回，不能继续硬编码15或17个字段。

- Age: only the explicit age field, as a number or numeric string. No birth-year arithmetic or automatic increment of cached age; the saved source date remains part of its provenance.
- Gender: accept explicit labels. Numeric codes require a mapping bound to actual client source bytes and its exact enum expression. Never assume 0/1/2 meanings or treat numeric zero as missing. Mapping paths belong in workspace `profile_fields` config; missing mapping means omit and report, never guess.
- School: explicit school/schoolName or one unambiguous education (`type=2`) institution. Conflicting institutions, identity, timestamps or actual nonempty Base values require review; do not overwrite. A placeholder profile name may be accepted only with a registered exact-source alias and independent same-snapshot contact UID/name/job evidence.
- School rating: preserve existing values. Without a user-approved rubric, omit `院校评分`; a school name alone does not authorize a tier or numerical score.
- Missing or conflicting evidence: omit the field with its reason. Never create a value merely to make the field count complete. Fill Base null/empty cells and gender/school `未知` placeholders; preserve confirmed nonempty values and halt conflicting writes.

### Current residence

Use the text field `现居地` for descriptive metadata only. Prefer an exact candidate-owned current-residence statement, with UID/name/job, original message ID/quote and actual source-byte SHA. The shared create hook calls `talent_location_fields.mjs`; pass the workspace-configured `profile_fields.current_location.policy` path. `currentResidence` evidence can be provided after review, or loaded from that policy's accepted sources. The pure planner `location_fields.mjs` does not verify files.

Only when the user authorizes school fallback, set the policy's `useSchoolDefault=true`. Use a verified school-to-city registry from an official education authority or school source, bound to actual registry and source bytes. Preserve the original school name and any explicitly reviewed alias. Write `城市（资料现居地）` or `城市（学校所在地默认）` so a default never claims actual residence. School location is an institution location, not proof of the candidate's campus or residence. For an institution spanning countries where no applicable campus is established, or an unknown school, leave blank with a reason. Never infer residence from expected job city (`resume.city` in this client), work experience, hometown, IP, phone prefix, or acceptance of on-site work.

An authorized location backfill may add the text column and fill only empty `现居地` cells after a fresh full-table comparison. Resolve exact record IDs; a historical row without UID evidence may use its own stored school, but must not be merged with a BOSS account by name alone. Save a separate maintenance receipt and independently read back all current fields. Check the Base revision as well as values: an immediate read may predate a successful update; reconcile read-only before considering any further write. Preserve scores, HR states, contact times, resume attachments and send receipts. A later explicit residence conflicting with an existing default needs an evidenced, reviewed correction and fresh compare, not an unconditional overwrite.

For a backfill, resolve exact existing record IDs using UID+job+name evidence, freshly read all fields, and produce patches restricted to `年龄`, `性别`, `院校`. Before writing, re-read and compare the full baseline to catch concurrent HR edits. Save the preview and exclusive attempt; execute once, then independently read back every field. Verify planned additions and equality of all unrelated fields. Unknown API results require read-only reconciliation before any further action.

Report actual populated/written fields separately from fields verified during readback. A successful 15-field comparison can include nulls; it does not mean 15 values were supplied. Preserve historical create/handoff receipts and append a separate metadata-backfill receipt.

## Write sequence

1. Check that the workspace configuration points to the intended Base and table.
2. Read fields with `lark-cli base +field-list --as user`.
3. Search existing records before creating one. For identity, combine exact BOSS UID evidence held in the run manifest with role and name; do not rely on name alone.
4. Preview the write with `--dry-run`.
5. Create or update the record.
6. Read the record back and verify every field.

## Evidence handling

主动发送简历的接收、邮箱匹配、无邮件PDF时的线上简历兜底与实际文件上传详见 [resume-attachments.md](resume-attachments.md)。线上摘要须标注非完整正文，资料卡不能冒充简历。文件附件必须使用实际 `attachment` 类型列和 `+record-upload-attachment`；已有链接文本列保留，不用普通记录更新伪造文件附件。字段数量从当前schema读取，历史15字段验证不代表新增列已验证。

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

Check the installed CLI's help before building JSON; versions differ. For CLI 1.0.81 the actual shapes are `{"create_records":[values]}` and `{"update_records":{"record_id":{"年龄":23,"性别":"女"}}}`; `+record-get` accepts `{"record_id_list":[...]}` for bounded readback. Do not silently replace these with another version's patch schema. Use workspace-relative `@JSON`, `--as user`, `--dry-run`; check both native exit status and the returned `ok`/identity/ignored fields. A later PowerShell exit code zero is not write success.

## Permissions

Check `drive +permission-get-setting`. “同租户可读” lets internal HR with the link view the Base and linked resume. Do not broaden to public or external access without an explicit audience decision.
