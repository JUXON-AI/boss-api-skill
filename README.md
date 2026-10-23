# BOSS API Skill（macOS / Windows）

给 Codex / Agent 使用的 BOSS 直聘桌面端技术 skill。通过 REA 分析安装包，复用本机客户端正常登录态读取聊天和简历，并执行已授权的单人文本回复。

仓库同时包含配套招聘skill、实习/全职沟通流程、HR语料模板和流程图。

**macOS（Apple Silicon / arm64）和 Windows 11 x64 已做限定范围验证；Linux 未验证。** Windows 已实测登录状态、两页联系人、一个指定会话、已打开的在线简历结构化摘要，以及加密成员明文导出。单人文本真实发送及唯一新增历史回读已验证一个样本；送达、已读、PDF、完整分页和在线简历全文未验证。详见 [Windows 验证报告](references/windows-validation.md)。

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
| [招聘skill](skills/boss-recruiting-agent/SKILL.md) | 评分证据、多人分工、授权、HR语料检索与飞书交接 |
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

上述安装的是技术skill。若需要招聘流程，将 `skills/boss-recruiting-agent` 也安装到同级skill目录；已有同名skill时先检查本地修改。默认Codex目录下，尚未安装招聘skill时可执行：

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

macOS 的既有验证记录保持独立，见 [验证记录](references/verification.md)。2026-10-23 Windows 实测及离线发送测试见 [Windows 报告](references/windows-validation.md)。离线测试与业务验证分别记录；后续取得用户授权后，已实际发送一条正常招聘消息并确认唯一新增历史记录。尚未收到回复、完成两轮初筛或飞书交接；未索要或接受简历、交换联系方式。

仓库只包含 skill、脚本、离线测试和说明，不包含 BOSS 安装包、候选人资料、聊天记录、简历、Cookie、token 或原始验证数据。

招聘初筛、HR话术和人才库规则由仓库内的 `boss-recruiting-agent` skill 负责；接口操作统一复用根目录技术skill。业务skill没有额外的发送实现；授权样例默认未批准。飞书地址与真实岗位配置从使用者的工作区取得，不在仓库中发布。
