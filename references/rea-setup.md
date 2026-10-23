# REA 检查与部署

## 先检查当前机器

这一步针对执行任务的机器。Mac已经部署不代表Windows也已部署；只有本skill不代表安装了REA。

分别确认以下内容，不通过全盘扫描寻找：

1. **当前会话工具**：是否实际提供REA的 `analyze_javascript_application` 等工具。工具已连接且正常时直接复用，无需每轮重跑安装。
2. **运行时**：在当前shell中定位 `rea`、Node.js、npm、Git，执行 `rea --version`；找不到命令时先检查已配置MCP的启动路径，避免仅因PATH差异重复安装。
3. **源码**：检查当前工作区或已知工具目录是否有 `https://github.com/morluto/rea` 的checkout，用 `git -C <目录> remote get-url origin` 确认来源。没有源码时补克隆；源码目录存在不等于CLI已经部署。源码与npm发行版不必是同一提交，不声称已从源码构建。
4. **Agent集成**：CLI可用但当前会话没有REA工具时，检查当前客户端的注册，不误判为没安装。Codex用 `--client codex`；其他客户端先查本机CLI帮助，不能一律改Codex配置。

macOS终端：

```sh
command -v rea
command -v node
command -v npm
command -v git
node --version
rea --version
```

Windows PowerShell：

```powershell
Get-Command rea, node, npm.cmd, git -ErrorAction SilentlyContinue
node --version
rea --version
```

有可用CLI时先运行下列诊断，保存结果；不要因为其他机器通过就跳过当前机器检查：

```sh
rea doctor --client codex --format json
```

已知本项目使用 `rea-agents@6.7.0`。它要求Node 22系列≥22.19、24系列≥24.11，或26+。CLI的已安装版本及 `--help` 才是当前参数依据，不能把仓库main文档中的新功能强套给旧发行版。

## 缺少时部署

任务已明确包含“没有REA则在当前机器部署”时，直接完成该授权范围内的安装与集成，不重复请求同一项授权。不升级已有可用环境；缺少Node/npm/Git等基础环境时先说明具体缺口，仅在任务授权的环境准备范围内补齐，不能把安装反编译套件作为JS分析的前提。

以当前项目 `.tools` 为默认工具目录；存在其他合适安装时复用它。缺少源码时：

```sh
git clone https://github.com/morluto/rea.git .tools/rea-src
```

缺少可执行运行时时，可用npm发行包在项目内安装，避免要求管理员权限或改全局目录：

macOS：

```sh
npm install --prefix .tools/rea-runtime --cache .tools/npm-cache --no-audit --no-fund rea-agents@6.7.0
.tools/rea-runtime/node_modules/.bin/rea --version
```

Windows PowerShell：

```powershell
npm.cmd install --prefix .tools/rea-runtime --cache .tools/npm-cache --no-audit --no-fund rea-agents@6.7.0
& '.\.tools\rea-runtime\node_modules\.bin\rea.cmd' --version
```

下文 `rea` 代表实际可执行文件；不在PATH中时用已验证的完整路径。Windows使用PowerShell调用完整路径时加 `&`。不要为了让命令运行而关闭执行策略或安全配置。使用本地 `.cmd` 启动器即可避免误选被阻止的 `.ps1`。

安装npm发行包不会编译源码目录，也不意味着该机器的BOSS接口已可用。

## 配置当前Agent

如果REA工具已正常连接，不重复写配置。若缺少或注册损坏，先生成只读计划：

```sh
rea setup --client codex --dry-run --format json
```

核对计划的配置路径、启动器、备份及REA自带skill变更，确认它们都在本次部署授权范围内；保留其他MCP配置和无关skill。任务已经授权当前客户端REA部署时，在核对后执行：

```sh
rea setup --client codex --yes --format json
```

不要附加 `--all-detected` 或 `--install-hopper`，也不要为Electron/JS分析安装Ghidra、IDA等无关引擎。Windows上的MCP启动方式必须依实际setup计划与诊断确定，不能把Mac绝对路径或未验证的 `.cmd` 启动配置照抄进去。

注册更新后，重新连接REA MCP或按客户端要求重新加载。正在运行的会话不一定立即获得新工具；只重启需要刷新的Agent客户端，不重启BOSS。若本轮不便重新加载，继续使用已验证CLI完成静态分析，明确说明“CLI可用、当前会话MCP尚未加载”。

## 实际验收

至少记录：

- 当前机器、REA源码位置/提交、CLI位置和版本、Node版本。
- `rea doctor --client codex --format json` 的实际诊断。
- 配置了MCP时，`rea mcp doctor --json` 的真实启动和工具列表检查；这仍不能替代当前Agent会话中的实际工具调用。
- 用当前REA实际执行一次小型本地JavaScript静态分析，并检查结果、失败项和覆盖范围。成功退出或非空输出不单独构成分析成功。

可在 `outputs/rea-smoke` 放一个不执行的自建样例 `index.js`，内容为 `module.exports = { readOnlyFixture: true };`。使用其绝对目录执行：

```sh
rea analyze-javascript-application <样例绝对目录> --format json
```

优先通过当前会话的REA MCP工具分析同一个样例；工具未加载时用CLI并明确报告。样例不要用候选人资料，不打开BOSS、不读取账号凭据，也不发送消息。`.tools`、npm缓存和验收输出不提交到团队skill仓库。

REA部署验收通过后，再继续本skill的BOSS安装包分析。**REA能在Windows启动或分析样例，不代表BOSS读取、简历或发送已经通过Windows验证。** Windows部署命令在本次文档更新中仅核对了写法，没有在真实Windows机器验收。
