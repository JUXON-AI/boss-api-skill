# BOSS API Skill（macOS / Windows）

给 Codex / Agent 使用的 BOSS 直聘桌面端技术 skill。通过 REA 分析安装包，复用本机客户端正常登录态读取聊天和简历，并执行已授权的单人文本回复。

仓库同时包含配套招聘skill、实习/全职沟通流程、HR语料模板和流程图。

**macOS（Apple Silicon / arm64）和 Windows 11 x64 已做限定范围验证；Linux 未验证。** Windows 已实测登录状态、两页联系人、指定会话、在线简历结构化摘要，以及加密成员明文导出。单人文本真实发送及唯一新增历史回读已验证15个对象，其中7人另有第二轮消息确认；其中3人完成两轮至人才库待HR复核及BOSS交接通知。部分逐条UI显示送达/已读，未建立数字状态映射。PDF、完整分页和在线简历全文未验证。详见 [Windows 验证报告](references/windows-validation.md)。

## 平台与前提

| 项目 | 状态 |
|---|---|
| macOS / Apple Silicon | 已做限定范围验证 |
| Windows 11 x64 | 进程、调试、解包、部分只读及单人文本发送回读已实测；逐项边界见报告 |
| Linux | 尚未验证 |
| BOSS 版本 | 本次核对 1.7.5，Electron 22.3.24 |
| Node.js | REA 6.7.0 要求22系列≥22.19、24系列≥24.11，或26+；本机使用 Node 24 |
| 客户端 | 本机已经运行；业务读取需要正常登录和查看权限 |
| REA | 先检查当前机器；缺少源码、运行时或当前Agent集成时按部署指南补齐 |

## 能力与限制

- **REA准备**：检查源码、CLI和当前会话MCP工具；缺少时在对应机器部署，再做实际调用验证。见 [部署指南](references/rea-setup.md)。
- **安装包分析**：列出 ASAR 成员；加密文件经现有客户端导出明文，校验声明哈希后交 REA。不会修改安装包或提取密钥。
- **聊天读取**：读取联系人和单会话历史，核对 UID、姓名及可选岗位。全量联系人分页尚未验证。
- **在线简历**：尝试读取已正常打开、完成初始化的简历结构化摘要；完整正文尚未验证。
- **附件简历**：下载已接收、位于当前历史窗口内的 PDF，不自动“同意接收”或交换资料。
- **文本回复**：必须有当前单人授权、确定原文和会话指纹；顺序发送，发后回读。不完整历史或结果不明时停止，不自动重发。

macOS 使用原有应用路径、`ps` 和 SIGUSR1；Windows 通过 CIM 核对实际主进程和路径，调用 Node 的 Windows debug handler 接入现有客户端，并核对监听端口的 PID 和 loopback 绑定。两种入口都不自动重启客户端。接口运行于客户端上下文，不是已验证的独立外部 REST 服务。

## 招聘流程资料

| 资料 | 内容 |
|---|---|
| [招聘流程说明](docs/recruiting-workflow.md) | 岗位设置、两轮沟通、初筛入库和HR决定 |
| [招聘流程图](docs/recruiting-flowchart.md) | 实习/全职主流程、话术审核与发送，两张图片及Mermaid源码 |
| [HR语料模板](docs/hr-corpus-template.md) | 58个场景：通用25、实习5、全职28；全部为待HR确认草稿 |
| [招聘skill](skills/boss-recruiting-agent/SKILL.md) | 评分证据、确定性候选人账本、多人分工、授权、HR语料检索与飞书交接 |
| [候选人状态账本](skills/boss-recruiting-agent/references/candidate-ledger.md) | 一人一记录、历史/job profile 哈希、确定性重算、乐观锁和批量校验 |
| [飞书部署与扫码登录](skills/boss-recruiting-agent/references/lark-setup.md) | 检查并部署lark-cli与飞书skills，用户扫码授权，核对人才库访问与同步结果 |
| [实习岗位示例](skills/boss-recruiting-agent/assets/job-profile.example.json) / [全职岗位示例](skills/boss-recruiting-agent/assets/job-profile.full-time.example.json) | 输入格式示例，不代表实际待遇或岗位授权 |

## 安装与使用

把仓库作为 `boss-desktop-api` skill 安装在 Codex 的 skills 目录。已安装同名 skill 时，先检查本地修改。对于尚未安装的环境：

```sh
gh repo clone JUXON-AI/boss-api-skill ~/.codex/skills/boss-desktop-api
```

仓库为团队私有仓库，需要具有相应访问权限。安装后调用：

> 用 $boss-desktop-api 读取指定候选人的聊天和已经接收的简历，先生成回复草稿。

命令示例：

```sh
node scripts/boss.mjs doctor
node scripts/boss.mjs status --output outputs/boss/status.json
node scripts/boss.mjs help
node --test scripts/runtime.test.mjs
```

Windows 使用 PowerShell 与本机 Node.js，无需 WSL、`ps` 或 Unix 信号。`BOSS_APP_MAIN` 可显式指定安装的 exe；通常直接使用 CIM 返回的唯一主进程路径。敏感输出在新建子目录中保存：Windows 使用仅当前用户与 SYSTEM 可访问的受保护 ACL，已有目录权限过宽则拒绝写入；macOS 保持 0600 文件模式。全部离线测试：`node --test scripts/*.test.mjs`。

上述安装的是技术skill。招聘流程使用下面的模块化skills包；`skills/boss-recruiting-agent` 保留项目实现、契约、脚本和兼容入口。1.4.0支持Codex与DeepSeek Harness，并按公司、部门、岗位与用工类型配置，不限后端实习。

### 安装招聘skills包

分发清单见 [recruiting-skills.package.json](recruiting-skills.package.json)，Codex入口为 [boss-recruiting-followup](skills/boss-recruiting-followup/SKILL.md)，Harness入口为 [boss-recruiting-deepseek-harness](skills/boss-recruiting-deepseek-harness/SKILL.md)。从仓库执行安装和一致性检查：

```powershell
node scripts/recruiting-skills-install.mjs --host deepseek-harness
node scripts/recruiting-skills-install.mjs --host deepseek-harness --check
# Codex使用 --host codex；--home可指定实际宿主主目录。
```

在DeepSeek Harness中打开实际工作区并加载`boss-recruiting-deepseek-harness`，提供已有私有任务入口即可接续；主验、CLI和原统一sender均由Harness主代理执行，不需要Codex/JUXON工具。参见[Harness宿主适配](skills/boss-recruiting-followup/references/deepseek-harness.md)。安装会备份被覆盖的文件，不修改鉴权、候选人账本或定时任务；新会话应核当前宿主实际加载路径，避免项目旧版覆盖用户安装版。

| Skill | 职责 |
| --- | --- |
| [boss-recruiting-deepseek-harness](skills/boss-recruiting-deepseek-harness/SKILL.md) | Harness全程执行与宿主适配 |
| [boss-recruiting-config](skills/boss-recruiting-config/SKILL.md) | 公司/部门/岗位配置、条件与评分边界 |
| [boss-recruiting-followup](skills/boss-recruiting-followup/SKILL.md) | 持续跟进与按需路由 |
| [boss-recruiting-collect](skills/boss-recruiting-collect/SKILL.md) | 新招呼、新回复、真正漏回的只读采集 |
| [boss-recruiting-review](skills/boss-recruiting-review/SKILL.md) | 单人证据、评分及草稿复核 |
| [boss-recruiting-message](skills/boss-recruiting-message/SKILL.md) | 自然回复、单次发送与独立读回 |
| [boss-recruiting-talent](skills/boss-recruiting-talent/SKILL.md) | 达标入库和HR交接 |
| [boss-recruiting-profile](skills/boss-recruiting-profile/SKILL.md) | 有来源的年龄、性别、院校与现居地 |
| [boss-recruiting-resume](skills/boss-recruiting-resume/SKILL.md) | 主动附件、收件PDF与线上简历归档 |
| [boss-recruiting-push](skills/boss-recruiting-push/SKILL.md) | 飞书机器人人才推荐与防重 |
| [boss-recruiting-audit](skills/boss-recruiting-audit/SKILL.md) | 异常对账、暂停和增量验收 |

使用示例：`请使用 $boss-recruiting-followup，按本项目私有任务入口继续已授权岗位。` 单项维护可直接调用对应模块。包内不含实际岗位配置、候选人资料、凭据或实时任务状态，也不会自动注册工具；实现依赖按 [工作区映射](skills/boss-recruiting-followup/references/implementation-map.md) 从本仓库和已部署CLI取得。

新增部门或非技术岗位先使用boss-recruiting-config，参见[岗位配置](skills/boss-recruiting-followup/references/job-configuration.md)及设计、人事招聘两个未批准样例。岗位单独定义评价rubric、权重、门槛和必需条件，不默认追问Go、AI编程、学校手续或实习周期。公司通用知识只在已确认范围内继承，部门/岗位事实不自动外推。新岗位仍需明确授权、独立状态及已验收执行适配器；模板不是联系授权，历史候选分数和暂停不自动迁移。

部署依赖按实际使用的模块准备：

- 客户端读取和消息操作需要本仓库技术skill、Node.js及已经验证的本地BOSS客户端SDK/桥接；平台支持范围见本文的平台与验证章节，不能把Windows接续经验视为其他平台已验证。
- 评分、账本、流水线和提案检查依赖本仓库 `scripts/` 与 `skills/boss-recruiting-agent/scripts/`，保留仓库布局。业务模块只携带操作规则，不独立实现这些接口。
- 飞书入库、资料和附件维护另需当前用户已授权的lark-cli、对应lark skills、真实表结构及工作区配置；邮箱读取和机器人推送仅在用户启用对应模块后需要。
- 持续轮询需要私有任务入口、当前授权与已验收的collector/runner；缺少实现或接口未验证时停在对应阶段，不能凭安装skills直接发送、建人才行或推群。

若需兼容原招聘入口，将 `skills/boss-recruiting-agent` 也安装到同级skill目录；已有同名skill时先检查本地修改。默认Codex目录下，尚未安装招聘skill时可执行：

```sh
cp -R ~/.codex/skills/boss-desktop-api/skills/boss-recruiting-agent ~/.codex/skills/boss-recruiting-agent
```

Windows PowerShell复制招聘流程文件：

```powershell
Copy-Item -Recurse "$env:USERPROFILE\.codex\skills\boss-desktop-api\skills\boss-recruiting-agent" "$env:USERPROFILE\.codex\skills\boss-recruiting-agent"
```

自定义了Codex目录时按实际skills路径替换。然后可以说：

> 用 $boss-recruiting-agent 按实习或全职岗位，对明确指定的候选人做初筛，先生成待审回复；技术读取使用 $boss-desktop-api。

业务操作前阅读 [SKILL.md](SKILL.md) 及其对应参考文档。所有输出使用新路径；创建或加载 skill 不代表授权发消息。

## 验证范围

macOS 的既有验证记录保持独立，见 [验证记录](references/verification.md)。2026-10-23 Windows 实测及离线发送测试见 [Windows 报告](references/windows-validation.md)。离线测试与业务验证分别记录；实际已对15个授权对象逐人发送正常招聘消息，其中7人有第二轮条件确认，含非提问式收尾共27次SDK发送均确认唯一新增历史记录。新流程冷读40份摘要与招呼成功；三个实习样本已完成两轮初筛、人才库记录创建/逐字段回读、待HR复核和BOSS交接通知，未代替HR面试录用决定。未索要或接受简历、交换联系方式。

仓库只包含 skill、脚本、离线测试和说明，不包含 BOSS 安装包、候选人资料、聊天记录、简历、Cookie、token 或原始验证数据。

招聘初筛、HR话术和人才库规则由仓库内的 `boss-recruiting-agent` skill 负责；接口操作统一复用根目录技术skill。业务skill没有额外的发送实现；授权样例默认未批准。飞书地址与真实岗位配置从使用者的工作区取得，不在仓库中发布。

先批量读取、再本地复核和逐个沟通：见 [批量采集说明](references/batch-reading.md)。已实际完成20人在线结构化摘要采集；全文未验证。采集脚本不发送消息，沟通仍用单人发送入口。
# 招聘性能模块

持续招聘的逐人流水线、自动提案校验及只读增量观察见[性能接续](skills/boss-recruiting-agent/references/performance.md)。默认4名离线单人复核，主代理逐个验收，所有真实操作仍串行且走原统一sender。

只读observer的maxMs为请求之间的合作lease（默认5秒），不声称取消远端已开始的读取；单次CDP另有2秒上限，关闭自建Inspector的cleanup使用总计2秒绝对deadline。前台只等活跃且有明确tag的观察连接，不自动删除未知/死PID锁或重试发送。完整history超出已验证范围则记录待核覆盖缺口，不猜分页。
