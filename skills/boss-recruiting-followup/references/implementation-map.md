# 工作区实现映射

从用户工作区与私有入口定位实际仓库，不把本机绝对路径写进skills。常见配置为工作区.codex/boss-recruiting.json。下表是已有项目的定位线索，不是新的执行API；实际schema、参数、源码SHA和验收以当前文件为准。旧批次动作脚本不得直接重跑。

| 模块 | 工作区已有实现/引用 |
| --- | --- |
| 客户端 | 仓库根SKILL.md声明的boss-desktop-api及对应平台验收；scripts/boss.mjs |
| collect | 私有任务入口指定且已验收的collector/poller；项目references/continuous-followup.md |
| review | scripts/scoring.mjs；项目scripts/candidate_ledger.mjs、validate_contracts.mjs；references/scoring-and-messaging.md、candidate-ledger.md |
| message | scripts/boss.mjs send、当前scope runner及源码SHA验收；项目references/scoring-and-messaging.md |
| talent/profile | 项目references/feishu-talent-base.md；scripts/talent_profile_fields.mjs中的buildTalentCreateValues；配置中的Base与当前用户身份 |
| resume | 项目references/resume-attachments.md；scripts/resume_intake.mjs、online_resume_snapshot.mjs及归档registry |
| push | 项目references/talent-group-push.md；scripts/talent_push_client.mjs；配置runSources/evidenceRoots |
| audit | 私有任务验收、初始baseline、accepted deltas、状态/索引构建与校验器 |
| 性能接续 | 项目references/performance.md；项目scripts/review_pipeline.mjs、proposal_validation.mjs、incremental_observer.mjs；仓库scripts/recruiting-proposal.mjs、readonly-session.mjs、recruiting-observer.mjs |

“项目scripts/references”均相对仓库skills/boss-recruiting-agent/，标明仓库根的路径除外。必要时按文件名搜索，不加载所有项目引用。首次解包、版本适配、评分/写入实现缺失是对应技术开发任务，不在持续跟进中临时绕过。

飞书操作读取对应已安装lark-base/lark-mail/lark-drive/lark-im skill和当前CLI帮助，不猜参数。表写权限用已授权用户身份；机器人仅承担已授权群推荐。没有调用外部服务验证的离线测试不得称真实写入成功。
