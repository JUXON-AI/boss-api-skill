---
name: boss-recruiting-deepseek-harness
description: 在DeepSeek Harness内全程接续BOSS招聘，使用本机SDK与飞书CLI完成已授权采集、离线复核、自然沟通、达标入库和验收；不依赖Codex或JUXON编排工具。
---

# DeepSeek Harness招聘入口

用户选择全程在DeepSeek Harness工作时使用本入口。先读[Harness宿主适配](../boss-recruiting-followup/references/deepseek-harness.md)，再读[持续跟进总入口](../boss-recruiting-followup/SKILL.md)，按需加载同包模块。

由当前Harness主代理负责证据、主验与串行服务操作；隔离的Harness子代理只做本人材料的离线复核。宿主规则替换仅限Codex/JUXON工具名与历史“禁用DSH”分工限制，不解除账号异常、候选人暂停、发送防重或其他业务门禁。

从用户指定的原工作区和私有任务入口接续，保留现有账本、完整历史、审批、attempt和真实回执。安装或迁移不等于继续发送，不创建新任务、定时或观察器；线上不可用时只做可核验的离线工作。
