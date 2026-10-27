---
name: boss-recruiting-push
description: 将已核验入库并完成交接的合格候选人通过获授权飞书机器人或Webhook推荐到指定群，独立防重与读回。用于人才群推荐，不代替BOSS联系或因补资料重复推送。
---

# 人才群推送

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)及[机器人实现映射](../boss-recruiting-followup/references/implementation-map.md)，必要时读lark-im skill。输入为用户明确授权的群/机器人配置、真实Base行、交接与最终联系readback、推荐registry和未完成attempt。

1. 核指定群真实身份、机器人身份/配置及权限；Webhook和签名秘密仅留保护配置，不能写进skill、日志或压缩包。不把“发现一个群”当授权，不自行换群或联系人。
2. 核正式通过、Base逐字段读回、真实交接/最后联系证据。已获授权且启用则按总流程继续，不逐人请示；缺前置不冒称已推荐。
3. 按同群+job+UID+recordId查重，核跨run真实回执。新恢复run必须纳入已授权runSources/evidenceRoots，不能因配置没识别就换事件key规避防重。
4. 内容仅用已核本人能力/条件与Base链接、实际可访问的附件；不包含凭据、原始全聊天或无关个人资料，不承诺录用。用已验收机器人客户端构造卡片/正文。
5. 独占attempt执行一次，保存服务真实结果、机器人身份及message ID，再独立核群内唯一新增消息/链接。服务成功与独立读回状态分别记录；无法读回仍未verified，不报已完成。

既有attempt未知/未verified只读对账，不重发、换事件key或改用用户身份补发。年龄/现居地等资料更新、简历挂表、新政策或措辞优化不再次推荐已有候选人。

输出群身份、去重键、message ID、独立readback及状态。失败交[audit](../boss-recruiting-audit/SKILL.md)接续；不反向给候选人发邮件或重复BOSS交接。
