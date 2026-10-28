---
name: boss-recruiting-talent
description: 将正式通过筛选且条件明确的候选人写入飞书人才表，完成逐字段读回、BOSS交接和最后联系核验。用于新增合格人才或接续已授权未完成入库，不以简历归档提前建行。
---

# 人才入库与交接

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)、[实现映射](../boss-recruiting-followup/references/implementation-map.md)，真实飞书操作再读已安装lark-base skill及当前CLI帮助。输入为正式record、通过的独立evaluation、六条件/岗位硬要求本人证据、schema配置、现有Base/交接回执。

## 门禁与防重

- 当前岗位后续新入库还须按[Go转向规则](../boss-recruiting-followup/references/go-transition.md)核本人接受Go开发及从零学习安排；已入库记录不追溯重建或补发通知。

- 当前确定性基础/覆盖/信号门槛及岗位硬要求全部通过，必需现实条件明确，正式record校验为ai_screened_pass才允许新增。阈值/地址/预算从当前批准配置读取；有分数不代表入库通过。
- 已有人才行、hr_review、existing_entry_identity_verified或bossHandoffSent按各自真实证据接续，不重建、不补旧交接。历史既有身份核实不冒称本轮实际入库/发通知。暂停未发项不因已有Base自动恢复。
- 仅补年龄/现居地交[profile](../boss-recruiting-profile/SKILL.md)，仅挂文件交[resume](../boss-recruiting-resume/SKILL.md)；未达标材料留私有队列，不为挂简历提前建行。

## 执行闭环

1. 核配置指定的已授权用户身份，不以机器人身份代替表权限。读取fresh schema，按UID+job与姓名精确查重，冲突先只读核证，不错误绑定。
2. 调当前已验收字段构造器，保留真实初筛依据/未知政策，状态为HR待复核；新入库按[学历字段与颜色](../boss-recruiting-profile/references/education-ranking.md)传入配置的educationPolicyFile，填写本人明确学历并继承单选选项颜色，未知留空记原因，不写旧院校评分。dry-run后真实create_records/update_records，CLI用当前支持参数与工作区相对@JSON。
3. 逐字段读回实际行，字段数随fresh schema，不固化旧15列。必填字段有真实来源，未知保留空及原因，不把“回读全列”当“全列必须猜填”。实际服务ok=false不能当成功。
4. Base核验成功后，按[message](../boss-recruiting-message/SKILL.md)独立发送自然交接，可按语境参考“你的信息已经提交到公司人才库了，后续HR会评估，有消息我会在BOSS上联系你。”不承诺面试或录用。
5. 交接独立唯一新增读回成功后，按真实消息时间更新最后联系并再次逐字段读回，记录bossHandoffSent。没有成功发送不伪造时间/回执；新入站或发送异常停止相应阶段留证。
6. 现有授权覆盖时，继续完成已启用[push群推送](../boss-recruiting-push/SKILL.md)，不要停在Base写完再逐人请示。简历未到不伪造附件，依既有策略独立归档，不改变筛选标准。

输出真实Base recordId、schema/readback、交接状态/时间与后续未完成事项。写入未知交[audit](../boss-recruiting-audit/SKILL.md)对账，不重建或重复交接。
