---
name: boss-recruiting-review
description: 根据本人完整BOSS历史或身份绑定简历离线复核能力、评分和岗位条件，形成待主验提案。用于新证据或新招呼初筛，不执行真实发送、人才入库或群推荐。
---

# BOSS候选人证据复核

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)和按需[实现映射](../boss-recruiting-followup/references/implementation-map.md)。输入为单人岗位、正式record/CAS、完整history及指纹、本人已绑定正文、已确认公司事实与当前评分策略。

## 单人离线委派

按用户指定主要使用JUXON ccs-juxon/deepseek-flash。每名只拿本人材料，不读别人资料、不操作服务、不改正式record。返回独立review、必要evaluation、原话/疑问、facts变更与自然草稿；主代理核原始字节和证据后验收。不可用时如实说明实际分工，不改用DSH或把未复核当通过。

用有界单人流水线，默认4名离线复核，谁先完成谁先主验；同UID各版本串行。已部署proposal_validation时先自动核结构、身份、实际UTF8哈希及真实轮次，再主验语境。自动通过不是发送审批；空执行结果、未知结果或审批后内容变化不得算成功。

## 事实与条件

- 核本人from.uid、mid、精确引文和对应招聘者问句。直接回答完整条件组的“都能接受”可合并认定；模糊指向留未知，不要求机械逐项复述，也不把职位卡、招聘者问句当接受。
- 实习从岗位配置核薪资、具体现场、出勤、最低周期、学校可行及到岗计划。学校直接方便/允许/已有明确外出安排够用，无课、届别、离校不推许可；不增“offer前全手续完成/证明”门槛。
- 到岗资料卡只沿本人body.resume.applyStatus及mid/job原来源；保留本人面试/offer前提，手续时长不改到岗时长，不添加年份、最晚到岗日或一周期限。待遇/面试询问未设为接受前提则不新增硬门槛。
- 岗位要求AI辅助编码时须本人直接工具/实践自述；Agent/RAG业务不自动证明编码能力。自述不冒称独立验证，不用性别年龄学校档次筛选，不索代码验证。
- 本人使用Claude Code时，按[账号追问与加分规则](../boss-recruiting-followup/references/claude-code-account.md)区分中转站/本人官方账号/组织共享/未知。本人官方账号单列用户偏好正向项并绑定原话，不能当能力已验证或混入竞赛/GitHub分；未配置数值不手填加分，不改变两轮上限。

## 评分与轮次

1. 新增可归因技术证据才支持按锚点评分；现实条件答复、重复文件或补人口资料保持原score/evaluation整份不变。无GitHub核查不当实际贡献为零。
2. 用当前已验收确定性评分器，分开基础、覆盖、证明加分和总信号，不抬分/降门槛。review不是evaluation；score只存评分字段和evaluation指纹，全文另存。
3. 主验本人完整history、文件/文本SHA、canonical与full-client/semantic指纹，合法state、原轮次及重算一致。validateCandidateRecord同步不抛错通过、返回{record,score}，不能按===true误判。正式落盘交主代理CAS并回读。
4. 新实际收到且未审技术正文先一次紧凑复核；基础仍全null才跳过，不深挖补问或发拒绝。离线阅读/评分不依赖R0自动发送许可；评分器缺失留证待评分。
5. 真实R0首轮澄清仅限已授权且验收的发送策略。实质最多两轮，R2仅补缺项；未达R2/入库门槛hold，不伪造round0或抬分绕gate。已有人工面试/接续hold限制自动联系，不妨碍本人新材料离线供HR复核。

输出主验结论：需合法筛问/政策答复、ai_screened_pass候选、仅事实CAS或hold/无需回复；区分模拟提案与已真实完成。需消息交[message](../boss-recruiting-message/SKILL.md)，通过且正式校验后交[talent](../boss-recruiting-talent/SKILL.md)。两轮用尽不能为缺AI工具另问第三轮。
