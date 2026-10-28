---
name: boss-recruiting-collect
description: 只读采集已授权BOSS岗位的新招呼、新回复及真正漏回，核对完整history、跨run去重和失败范围。用于轮询或检查遗漏，不发送、不评分、不写人才表。
---

# BOSS招聘增量采集

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)；实现见[collect映射](../boss-recruiting-followup/references/implementation-map.md)。输入为当前岗位授权、scope/state、正式记录、最近验收及采集入口。

## 选择与覆盖

1. 核锁和活跃进程，主代理串行复用已验收collector/poller。不把本次心跳active当跳过理由，不发消息或改ledger。
2. 旧冻结清单与获准新招呼独立登记，按UID+job跨run去重，不向旧manifest塞新UID或合并疑似重复账号。其他岗位不处理。
3. 覆盖waiting之外仍可读的hold/未完成材料，以及已授权历史联系人活动；终态/暂停依据实际策略处理，暂停不会自动解除。metadata变化是完整读取线索，不是新文本证明；已知null基础但metadata不变的跳读须有已验收规则。
4. 保存联系人分页和history真实来源、完整性及profile/job指纹。短页只说明实际所见页，不夸称整个服务端全量或八百联系人均完成筛选。
5. 当前客户端历史分页复用仓库 `scripts/history-pagination.mjs`：用 `maxMsgId` 推进，必须得到明确 `hasMore=false` 才算完整。默认20条只是一个片段，不能用 `lastMsgId`、`count` 或页码假定已完整。重复边界须核对正文与身份；非末页无进展、冲突或超出页数上限即停。接口版本变化先重新验证，详见仓库 `references/reading.md`。

## 增量分类

已部署只读observer时先复用其完整成功快照/events，核源SHA、当前授权和精确已审mid；只补缺失范围。metadata检查默认60秒不等于主代理每60秒回复，仍保留用户要求的全面巡检，覆盖不足如实报告。

- 按job+UID+mid与验收回执排除已处理文本。communication.no_reply_required、state marker或已审hold回执只能过滤其精确mid，未来新mid不能按UID跳过；新pending与失效marker不得共存，交由正式CAS阶段修正。
- 已问待答、纯感谢/确认及旧交接不是漏回；已读不构成催促理由。平台附件/邀请/撤回事件单列，既不当候选条件接受，也不操作接收/拒绝/下载。
- 只对完整成功的本人快照判断有无新增。部分失败仅补失败和未尝试UID，保留各批historySources并组合验收，不重采本轮已成功范围。
- 旧scope外历史会话先核当前岗位及范围授权，再登记独立恢复来源；不因“不在旧125”直接丢弃，也不自动视为授权。原已收到未读简历交[resume](../boss-recruiting-resume/SKILL.md)，不能只看聊天mid而遗漏正文。

输出覆盖表（成功/失败/未尝试/策略排除）、完整history来源、已过滤精确mid、真正未处理文本和平台事件。存在新待审内容交[review](../boss-recruiting-review/SKILL.md)，新UID在授权范围内建立独立材料包；没有增量不启动代理/重评/催促。

读取故障交[audit](../boss-recruiting-audit/SKILL.md)处理白名单恢复。未读不报无回复，未尝试不当请求失败；本轮成功快照不重复读取。
