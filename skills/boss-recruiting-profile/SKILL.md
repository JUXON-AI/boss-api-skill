---
name: boss-recruiting-profile
description: 从候选人原始资料补全飞书人才表年龄、性别、院校和现居地，保留来源及未知。适用于资料字段维护，不改变能力筛选、沟通轮次或触发重复交接推荐。
---

# 人才资料补全

先读[公共契约](../boss-recruiting-followup/references/common-contract.md)及[字段实现映射](../boss-recruiting-followup/references/implementation-map.md)。输入为已有Base行、本人完整来源、当前schema/字段构造器、用户批准的默认和院校评分口径。

| 字段 | 可用依据 | 不可推断 |
| --- | --- | --- |
| 年龄 | 本人资料明确年龄及来源时间；完整生日按批准口径计算并标计算日期 | 仅出生年、届别、照片不能猜精确年龄 |
| 性别 | 本人资料明确字段；数值枚举需源码验证映射 | 姓名/头像/称呼不能猜性别 |
| 院校/评分 | 本人资料的学校/校区；评分仅用用户批准口径并记依据 | 无口径留空，不按院校档次调整能力筛选 |
| 现居地 | 本人明确当前地点优先；用户允许时核实校区所在地并标“学校所在地默认” | 期望工作城市、学校本部不等于已确认居住地址或所在校区 |

核UID+job+姓名、原始资料字段和版本；矛盾保留来源待核，不覆盖成猜测值。学校所在地无法核实则留空，不能因为用户允许默认就任意填城。

真实写表读lark-base skill：核当前用户身份和fresh schema，读取现有行，只构造必要字段patch，dry-run后实际update并逐字段读回，验证其余字段、score/evaluation、轮次、最后联系不变。新增字段仅在已授权且确有需要时按当前schema操作，不新建人才行。

资料补全不重新评分、不重发BOSS交接、不再次群推荐；未完成初筛的新简历出现具体技术证据另交[review](../boss-recruiting-review/SKILL.md)，不能误用“资料维护”跳过复核。输出字段值/来源、默认标记、留空原因及真实readback；未知写入交[audit](../boss-recruiting-audit/SKILL.md)只读核对。
