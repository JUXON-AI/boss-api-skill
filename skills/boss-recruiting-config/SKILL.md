---
name: boss-recruiting-config
description: 为不同公司、部门、岗位和用工类型建立招聘配置，隔离岗位条件、评分、知识口径、人才表与授权；用于新增岗位或迁移配置，不默认沿用后端实习规则或启动联系。
---

# 公司、部门与岗位配置

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)及[通用岗位配置](../boss-recruiting-followup/references/job-configuration.md)。从用户已给材料创建或核对岗位配置，不凭岗位名补薪资、地址、技术栈、学历或招聘名额。

1. 明确company_key、department_key、真实boss_job_id、岗位名称及用工类型。没有明确岗位身份时仅准备草稿，不扫描所有岗位或联系同名岗位候选人。
2. 将职责、能力评分rubric、权重、门槛、必需条件与可选偏好写入当前job profile的screening_policy。未批准的示例保持approved=false；不能把AI拟稿自行批准。
3. 公司公开事实、部门事实、岗位事实分别绑定范围、来源、确认状态和对外权限。同主题冲突留主验，不静默覆盖；不得把某部门口径当全公司事实。
4. 为每个岗位配置独立scope、ledger、attempt/receipt、HR语料范围、人才表字段映射和已授权群。共享人才表仍按UID+job匹配，不能因同一人出现在另一个岗位就自动移转或群发。
5. 运行已验收的job配置校验器和离线样例。真实流程仍经统一sender、CAS和独立读回；未部署对应执行适配器只停该阶段，不临时复用旧岗位runner。

仅配置不授予采集、联系、入库、群推送或定时授权。已存在旧任务不自动迁移评分或重建人才行，更新政策须留版本、原快照和用户授权。配置准备完成后交[持续跟进](../boss-recruiting-followup/SKILL.md)按当前授权接续。
