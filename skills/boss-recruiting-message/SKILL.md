---
name: boss-recruiting-message
description: 执行已授权且主验通过的BOSS筛问、政策答复或入库后通知，核轮次、单次发送、独立读回与CAS。用于确需回复的消息，不因已读未回自动催促，不负责替代入库核验。
---

# BOSS沟通与发送验收

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)；通过[实现映射](../boss-recruiting-followup/references/implementation-map.md)定位统一sender。输入是本人主验草稿、正式record/CAS、原始证据和明确的本条目的；离线review本身不等于发送许可。

## 本条是否可发

- 存在真实未处理问题、合法缺项或已核验入库后交接才发；已问待答、感谢/确认和旧收尾不机械补发。最多两轮实质筛问，R2仅问缺项，不再问已有技术/工具/独立范围。
- R0澄清需真实round0和当前scope已授权验收策略；next_round=0不问新实质问题。政策和HR通知保持原实质轮次，不伪造round0；HR通知不计新增筛问。
- 人工接续、停联、疑似重复暂停及blocked项尊重原状态，不自动恢复。HR通知必须绑定真实Base逐字段读回成功，不能先发“已提交”再写库。
- 自然短句，一条一个主要目的，顺着对方问题回应；不机械“好的了解了”、ok、表情或提前“整理确认”。不索要简历、站外联系方式或验证代码，不承诺面试/offer/福利/转正。未知公司政策如实说未确认，不拿候选技术栈当公司栈。
- 工时只岗位事实，除非用户另有限制，不用作回复窗口。已授权必要步骤直接接续，不逐人请示。

## 每一条的真实执行

自然度校验只提示套话、过长、多目的，不自动改写或要求统一开头；主代理仍按本人上下文定稿，不为提速发送无内容确认。连接优化不删两次严格发前检查或独立新增回读，不另造发送入口。

1. 查锁和对应活跃进程，核runner当前scope/授权/源码SHA及所有未完成attempt。核job+UID+姓名/profile，实际UTF8正文SHA与正式record CAS。
2. 新鲜完整history与已审批证据一致，做双重严格发前校验；出现新入站先停本条重审，不把旧审批套到新事实。
3. 独占attempt，统一scripts/boss.mjs send只调用一次，保存approval/pre-send/SDK/result实际证据。不换入口或循环调用sender。
4. 独立完整回读，验证只有一条符合正文SHA的新增出站、无其他意外出站；CAS登记真实mid、history、轮次/pending并回读。SDK成功、历史写入、送达和已读分别表述。

不同目的确需两条时，各自审批/SHA/attempt/单次SDK/独立回读/CAS。第二条必须第一条确实成功后刷新本人完整history、绑定新CAS；不共用审批，不添无内容消息。入库后交接成功交[talent](../boss-recruiting-talent/SKILL.md)更新最后联系并再读回，才可进入已授权群推送。

结果未知或sender已调用后失败交[audit](../boss-recruiting-audit/SKILL.md)只读对账，不自动再调。输出真实发送/未发送、stage、mid与证据路径；本地拒绝不能冒称真实发送失败或候选人未回复。
