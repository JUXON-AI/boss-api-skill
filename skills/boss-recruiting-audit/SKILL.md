---
name: boss-recruiting-audit
description: 审核BOSS招聘动作回执、失败和暂停，执行只读对账、派生状态恢复及跨run增量验收。用于异常接续或轮询收尾，不自动重试发送、重建人才行或解除明确暂停。
---

# 招聘审计与接续

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)和[实现映射](../boss-recruiting-followup/references/implementation-map.md)。输入为当前动作原approval/pre-send/attempt/result、真实独立history/Base/群读回、初始baseline、具名delta和正式账本。

## 失败分类

| 已证实情况 | 允许的接续 | 停止条件 |
| --- | --- | --- |
| 纯本地草稿/hash/路径校验失败 | 确认无sender子进程、SDK、正式CAS及其他写入，且无显式暂停；保留原件后新版本修正 | 任一副作用不明或已登记暂停，不能自行再调 |
| sender已调用后失败/结果未知 | 保留原approval/attempt/result，独立只读对账 | SDK未到也不自动再调sender；不删证据、换attempt或入口 |
| blocked或requiresSeparateExplicitDecision | 保留暂停与真实原因，等针对对象/动作的明确裁决 | 普通“继续”、心跳、新范围授权均不解除 |
| 只读传输白名单故障 | 原进程状态核实后，按已验收规则至多一个新连接，仅补失败/未尝试范围并组合验收 | 业务错误不套网络恢复，不重启登录或重采成功范围 |
| Base/附件/群写入未知 | 查实际UID行、文件token或群消息及对比 | 不重建/重传/换事件key重发 |
| 派生状态损坏 | 从不可变回执重建并独立验收 | 不改初始baseline或伪造正式record，正式变更仍CAS |

保存实际stage/action/requestId/elapsed、native code/name/message/stack/cause/cleanup并脱敏，只记录真实可得项。缺失原错误留未知，源码顺序推导标推导，不编造冻结/网络/登录根因。未尝试不当请求失败，本地修稿成功不冒称线上故障修复。

## 本轮验收

提速测试分开标注：合成review调度、真实只读请求/连接、自然候选回复端到端。没有真实发送样本不报已实现端到端倍率，不发测试消息；观察器按源文件/精确mid入待审队列，不把“已发现”报为“已回复”。

- 逐核真实增量：允许变化的UID+job+姓名、合法轮次、无新技术时整份score/evaluation保持、原回执前缀/attempt证据不覆盖，SDK调用及独立唯一新增消息吻合。
- 核正式record CAS前后快照、字节与canonical链、facts/pending/精确已审mid及账本/索引一致。无需回复marker不得与新pending冲突；已审hold/旧非文本卡可保留真实pending，不能清空求通过。
- 冻结历史保持；新增已授权旧scope动作追加独立主验具名delta，不能覆盖初始baseline或假称所有原记录未变。校验器不支持的合法动作需据真实证据另审实现，不能伪造hold绕门禁。
- 区分所见联系人页、授权scope、正式record、实际独立收件人、消息条数、Base总行/本轮新增/已关联行、真实HR交接、群推荐和附件阶段。waiting或单run计数不代表全部沟通过的人，Base存在不等于HR通知成功。
- 历史existing身份核实不计本轮新入库/新交接；明确未发项保留bossHandoffSent=false及真实联系时间，不“补齐统计”重建或发送。

更新相应sent/handoffs/pendingFollowups、必要索引、main-state/CONTINUE和latestHeartbeat.source，记录覆盖限制与未完成事项。只更新有变化的派生文件，不每轮重写全账本。状态使用Node JSON且processedReplyUids唯一，逐native核真实输出。

无可执行变化静默；仅实际回复/入库等有意义进展、全部完成、失败或确需用户信息时通知，不说“整个BOSS无新消息/无需你处理”。待答/待核验/暂停状态如实留存；空轮询不是全部完成，不自动停用定时任务。
