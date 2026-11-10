---
name: boss-recruiting-followup
description: BOSS招聘skills包总入口。接续已配置任务或定时轮询，按需协调新招呼采集、单人复核、沟通、人才入库、简历和群推送；只处理其中一项时使用对应模块。
---

# BOSS招聘持续跟进

先读[公共契约](references/common-contract.md)，从用户工作区及私有任务入口读取最新指示、岗位/授权、scope/manifest、main-state及latestHeartbeat.source。只为未完成事项读对应record、回执和CONTINUE段落，不搬运整段批次历史。

## 按当前动作加载

| 当前需要 | 读取的skill | 交付物 |
| --- | --- | --- |
| 新招呼、新回复、真正漏回及覆盖补读 | [boss-recruiting-collect](../boss-recruiting-collect/SKILL.md) | 完整来源及未处理增量清单 |
| 本人证据、评分、条件与离线草稿 | [boss-recruiting-review](../boss-recruiting-review/SKILL.md) | 主代理验收的单人提案 |
| 实质问询、政策答复或真实入库后通知 | [boss-recruiting-message](../boss-recruiting-message/SKILL.md) | 唯一新增出站、独立读回与CAS |
| 通过筛选后写人才表及HR交接闭环 | [boss-recruiting-talent](../boss-recruiting-talent/SKILL.md) | 已回读Base行和真实交接状态 |
| 补年龄、性别、院校及现居地 | [boss-recruiting-profile](../boss-recruiting-profile/SKILL.md) | 有来源的局部字段及读回 |
| 主动附件、收件PDF或线上简历归档 | [boss-recruiting-resume](../boss-recruiting-resume/SKILL.md) | 身份绑定正文与可查看附件 |
| 已授权飞书机器人/Webhook推荐 | [boss-recruiting-push](../boss-recruiting-push/SKILL.md) | 去重后的群消息及独立读回 |
| 失败对账、暂停裁决、状态与增量验收 | [boss-recruiting-audit](../boss-recruiting-audit/SKILL.md) | 可接续回执、账本/索引及覆盖结论 |

这些是同一包内可独立调用的skills，不是要求一次加载全部正文。客户端首次解包和接口适配转到工作区技术skill；实现位置见[实现映射](references/implementation-map.md)。

## 推进顺序

1. 检查已有锁、真实活跃进程和未完成回执；从真实增量接续，不重复委派、重发或入库。只读与发送由主代理串行执行。
   当前客户端历史按collect规则完整分页；有未读页先补齐。每次拟回复前按message规则查实时HR语料，不能只凭旧缓存或机械模板。
2. 有未读主动简历则先经resume取得本人正文；有真正新证据才经review。用户指定时主要委派JUXON单人离线复核，默认最多4人并行；任一人完成就主验并串行处理，不等整批结束，不将多人材料合并给同一代理。
   已到手正文与完整history一次传齐；单人等附件时继续处理其他人，不阻塞整批。优先接续已有答复及可达标事项，再做新招呼。正常轮询复用已验收入口和数据配置，不逐人临时生成一套执行代码；新增结构问题隔离该阶段，其他人继续。
3. review判定需要合法问询才转message；满足门槛且正式校验为ai_screened_pass才转talent。两轮上限约束筛问，不禁止真实入库后的通知。
4. 现有授权覆盖整条链路时，本轮继续完成Base读回、BOSS交接、最后联系再读回及已启用群推送，不停在“已拟方案”或Base写完，不逐人重复请示。新入站、真实失败或暂停仅停止相应阶段留证。
5. 按需补profile/resume，使用audit验收本轮真实增量并更新接续入口。已有HR不因补字段、附件、新政策或措辞变化重新交接、推荐。

工作区已部署性能模块时，按实现映射读取performance引用，接续只读增量队列与自动提案校验。后台观察只产待审材料，不自动联系；主代理主验和写入门禁不变。提速效果分别报告合成调度、实际读取和自然回复端到端计时，不混为同一指标。

## 定时入口

仅用户要求调整定时时，使用可用的定时工具更新匹配的现有任务并保留无关设置。间隔从用户当前要求读取，不写死在skill里。提示词只保留目的、总入口和私有路径，例如：

> 使用 $boss-recruiting-followup，按〈私有任务入口〉接续已授权当前岗位，处理新回复与真正漏回，达标后入库并验收。无可执行变化静默，仅实际进展、完成、失败或确需用户信息时通知。

名单、分数、计数和暂停回执留在任务文件。一次空轮询不表示全部结束；按用户要求及任务完成条件决定停用，不擅自放弃待答或待核验事项。
