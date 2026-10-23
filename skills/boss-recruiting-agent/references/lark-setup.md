# 飞书部署、扫码登录与人才库连接

在新的用户机器上读取HR语料或同步人才库前执行；不能假设另一台机器已有的CLI、skill或登录态会自动同步。任务已要求缺少就部署时，在该范围内直接补齐，无需反复确认同一项安装授权。飞书扫码和授权确认必须由用户本人完成。

## 1. 检查CLI和飞书skills

macOS用 `command -v lark-cli`，Windows PowerShell用 `Get-Command lark-cli -ErrorAction SilentlyContinue`。也检查工作区配置的 `lark.cli` 完整路径；PATH缺失不等于没部署。执行实际启动器的 `--version` 和 `--help`，不能只看源码目录或npm包目录存在。

检查当前Agent的skill目录是否有：

- `lark-shared`：应用配置、用户/机器人身份、扫码授权、scope、输出规则。
- `lark-base`：多维表格人才库及HR语料表。
- `lark-drive`：需要上传简历、生成持久附件链接和检查文件权限时使用。

还要核对本机CLI自带的同版本内容：

```sh
lark-cli skills list
lark-cli skills read lark-shared
lark-cli skills read lark-base
lark-cli skills read lark-drive
```

CLI可运行不代表Agent已安装飞书skill；只有skill也不代表CLI已部署。执行认证前读 `lark-shared` 的 `references/lark-shared-identity-and-permissions.md`；首次应用配置前读 `references/lark-shared-config-init.md`。用 `lark-cli skills read <skill> <relative-path>` 读取，避免本地skill与二进制版本漂移。

## 2. 缺少时部署

官方项目为 `https://github.com/larksuite/cli`，本项目本机核对CLI版本为1.0.98。已有正常版本则复用；新安装可固定已核对的发行包，后续升级按实际帮助验证。优先用npm预编译包，无需为了这个任务安装Go构建链。

macOS项目内安装：

```sh
npm install --prefix .tools/lark-cli-runtime --cache .tools/npm-cache --no-audit --no-fund @larksuite/cli@1.0.98
.tools/lark-cli-runtime/node_modules/.bin/lark-cli --version
```

Windows PowerShell：

```powershell
npm.cmd install --prefix .tools/lark-cli-runtime --cache .tools/npm-cache --no-audit --no-fund @larksuite/cli@1.0.98
& '.\.tools\lark-cli-runtime\node_modules\.bin\lark-cli.cmd' --version
```

将实际启动路径写入当前工作区的 `lark.cli`；不要照抄Mac路径到Windows。下文 `lark-cli` 代表该实际启动器，PowerShell执行带路径命令时用 `&`。不要为安装或运行关闭执行策略；Windows优先使用 `.cmd` 启动器。

缺飞书skills时，从官方源码取得对应目录，并只安装当前缺失的skill，保留已有改动：

```sh
git clone https://github.com/larksuite/cli.git .tools/lark-cli-src
```

将 `.tools/lark-cli-src/skills/lark-shared`、`lark-base`、`lark-drive` 连同各自references/resources复制到当前Agent的实际skills目录。默认Codex目录为macOS `~/.codex/skills`、Windows `$env:USERPROFILE\.codex\skills`；自定义Codex目录或其他Agent时使用其实际目录。克隆完成不等于skill已经安装。核对三个 `SKILL.md` 可读；CLI嵌入指引与源码main不一致时，以已安装CLI对应的帮助和嵌入skill为准，不盲用新参数。

官方一体化安装向导是 `npx @larksuite/cli@1.0.98 install`；当前已有可用CLI时不重复执行整套向导。缺少基础Node/npm/Git时，仅按本次环境部署授权补齐，不改无关系统配置。

## 3. 应用配置与用户登录是两步

先运行：

```sh
lark-cli auth status --json --verify
```

查看实际 `identities.user`、token有效性和scope；不能仅凭 `ok=true`、当前默认身份或bot ready就宣布用户已登录。已有有效或可正常刷新的用户授权时复用，不强制重新扫码。

如果没有应用配置，先读配置reference并使用CLI正常初始化/绑定流程。已有团队应用时优先复用，不覆盖已有profile，也不从另一台机器复制appSecret、token或登录缓存。需要新应用且任务授权包含初始化时，可后台启动：

```sh
lark-cli config init --new
```

此命令等待用户操作；取得配置URL后原样展示，并用 `auth qrcode` 生成PNG二维码展示。完成应用配置后仍需用户OAuth登录，不能把应用创建完成当作用户登录成功。Agent工作区要求绑定时依本机 `config bind --help` 执行，不擅加 `--force-init`。

## 4. 未登录或授权失效：展示飞书二维码

需要人才库/附件的基本业务域为base、drive；已有用户授权缺什么就按错误的 `missing_scopes` 补什么。不要不带范围启动登录，也不要默认请求邮箱、消息等无关权限。需要读简历邮箱时才另加mail。

**第一轮：由Agent发起并展示。**

```sh
lark-cli auth login --domain base --domain drive --no-wait --json
lark-cli auth qrcode '<本次输出的verification_url原文>' --output outputs/lark-auth/feishu-login.png
```

二维码命令的URL必须取自这次真实响应，不能编造、改写或重复使用过期链接。先创建相对输出目录。向用户先展示原始授权URL，再内联展示PNG二维码，并明确：“请用你本人飞书扫码确认授权，完成后回复‘已授权’。”不能只生成文件而不把图片显示出来。

例如可使用 `![飞书扫码授权](<二维码文件绝对路径>)` 显示刚生成的本地图片。CLI参数用工作区相对路径；展示图片时使用所在Agent支持的本地图片方式。URL需保持原样，不编码/解码或重新拼查询参数。

展示后将控制权交给用户，不在同一轮里立即阻塞轮询。当前流程的device_code仅保留到该次授权结束，不输出给用户、不提交仓库，不跨新的授权流程复用。不索要密码、Cookie、token或appSecret。

**用户确认后：由Agent继续完成，不把命令丢给用户。**

```sh
lark-cli auth login --device-code '<当前流程device_code>'
lark-cli auth status --json --verify
```

“用户说扫完”只是继续轮询的信号，不代表登录已成功。检查真实结果、用户身份和所需授权。过期时保留原业务范围重新生成链接及二维码，不短超时反复重建流程。取消则停止，不能绕过扫码或假定获批。

## 5. 连接当前人才库并验证同步

从当前工作区配置取得目标Base和人才库表/语料表坐标；没有目标时请用户提供或按明确授权创建，不能写进其他默认表。示例结构见 `assets/workspace-config.example.json`；Base token在这里是资源ID，不是OAuth登录凭据，不能互换。

用当前用户身份先验证目标与字段：

```sh
lark-cli base +field-list --as user --base-token '<当前Base资源ID>' --table-id '<当前人才库表ID>' --format json
```

读取HR语料时也要使用配置的语料表ID，并只查启用且实际说法非空的记录。新账号/租户只有登录成功仍可能无目标表ACL或写权限；按原用户身份修复，不静默改成bot、不扩大公开分享范围。

预览写入只证明请求可构造，**不证明写权限或已经入库**。不为了测试权限给正式人才库写虚构候选人。仅当已有实际 `ai_screened_pass` 候选人且本次授权包含同步时，去重、dry-run、实际写入并统一核对返回和最终字段，HR保持待复核。

成功需依实际JSON契约判断；普通业务命令成功常为 `ok=true`，不能用BOSS的 `code=0` 判断飞书成功。用户登录响应需按auth命令自身契约检查。

飞书登录/权限未完成时，可以继续本地整理资料和待审草稿，但不能声称查到了已批准语料、已同步人才库或“已交HR”。对外发送仍遵循BOSS单人授权流程。

## 验收记录

记录当前机器的CLI版本/路径、三个skill的实际位置、用户身份与授权检查结果、目标表访问以及真实同步结果。用户姓名/授权链接/二维码/device_code只属于当前本机流程，不放入GitHub。Windows命令需要在对应机器验收；飞书可登录不代表BOSS的Windows适配已经完成。
