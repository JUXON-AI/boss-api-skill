# BOSS API Skill（Mac）

给 Codex / Agent 使用的 BOSS 直聘桌面端技术 skill。通过 REA 分析安装包，复用本机客户端正常登录态读取聊天和简历，并执行已授权的单人文本回复。

**目前仅在 macOS（Mac，Apple Silicon / arm64）验证。Windows 尚未验证，当前脚本不声明兼容；Linux 也未验证。** macOS 验证仅覆盖下述具体能力，不代表所有功能均已实测通过。

## 平台与前提

| 项目 | 状态 |
|---|---|
| macOS / Apple Silicon | 已做限定范围验证 |
| Windows | 尚未验证，需要单独适配进程、路径和调试入口 |
| Linux | 尚未验证 |
| BOSS 版本 | 本次核对 1.7.5，Electron 22.3.24 |
| Node.js | 22+ 且支持全局 fetch / WebSocket；本机使用 Node 24 |
| 客户端 | 本机已经运行；业务读取需要正常登录和查看权限 |
| REA | 包分析时使用已安装的 REA MCP 或 CLI |

## 能力与限制

- **安装包分析**：列出 ASAR 成员；加密文件经现有客户端导出明文，校验声明哈希后交 REA。不会修改安装包或提取密钥。
- **聊天读取**：读取联系人和单会话历史，核对 UID、姓名及可选岗位。全量联系人分页尚未验证。
- **在线简历**：尝试读取已正常打开、完成初始化的简历结构化摘要；完整正文尚未验证。
- **附件简历**：下载已接收、位于当前历史窗口内的 PDF，不自动“同意接收”或交换资料。
- **文本回复**：必须有当前单人授权、确定原文和会话指纹；顺序发送，发后回读。不完整历史或结果不明时停止，不自动重发。

本机依赖 macOS 应用路径、`ps` 和 SIGUSR1 Inspector 入口；Windows 不能直接照搬。接口运行于客户端上下文，不是已验证的独立外部 REST 服务。

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

业务操作前阅读 [SKILL.md](SKILL.md) 及其对应参考文档。所有输出使用新路径；创建或加载 skill 不代表授权发消息。

## 验证范围

本次实际验证了登录状态、100条联系人读取、3份加密成员明文导出与哈希校验、REA 所选源码分析、Electron fuses，以及8项离线测试。聊天历史、在线摘要、PDF和单人发送入口有此前成功记录；新脚本没有为发布进行真实发送，部分新命令尚未完整重测。详见 [验证记录](references/verification.md)。

仓库只包含 skill、脚本、离线测试和说明，不包含 BOSS 安装包、候选人资料、聊天记录、简历、Cookie、token 或原始验证数据。

招聘初筛、HR话术和人才库规则由另一个 `boss-recruiting-agent` skill 负责；使用本技术 skill 不必同时执行招聘流程。
