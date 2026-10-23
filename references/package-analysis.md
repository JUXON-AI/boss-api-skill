# 加密包与 REA 定位

## 确认当前包

默认 `/Applications/BOSS直聘.app`，ASAR 为 `Contents/Resources/app.asar`，主程序为 `Contents/MacOS/BOSS直聘`。位置改变时用实际路径，环境变量 `BOSS_APP_MAIN` 可指定主程序；不要固定旧 PID。

```sh
node <skill>/scripts/asar.mjs /Applications/BOSS直聘.app/Contents/Resources/app.asar inventory > outputs/boss/asar-inventory.json
```

清单包含精确成员名、大小、加密方式、声明明文 SHA256。只选与问题相关的 package、preload、renderer bundle；升级后 bundle 文件名会变化。

本机1.7.5主入口是 `main.jsc`，不是可以直接解析的 JS 源码。preload 为 `preload.js`，本次 renderer 为 `assets/index.d8de00b1.js`。字节码字符串只提供线索，不等于恢复完整源码。

## 导出加密成员

成员含 `encryption: bzl-aes-256-gcm-v2` 和 `encryptedSize`。普通 ASAR 偏移提取得到密文，直接交 REA 曾返回 `artifact_integrity_mismatch`；容忍此错误不会自动解密。使用现有客户端正常的 ASAR 文件读取：

```sh
node <skill>/scripts/boss.mjs extract --member package.json --file outputs/boss/source/package.json --output outputs/boss/package-extract.json
node <skill>/scripts/boss.mjs extract --member preload.js --file outputs/boss/source/preload.js --output outputs/boss/preload-extract.json
node <skill>/scripts/boss.mjs extract --member assets/index.d8de00b1.js --file outputs/boss/source/assets/index.d8de00b1.js --output outputs/boss/renderer-extract.json
```

读取 `/app.asar/<member>` 时，由已安装 Electron 的 ASAR 支持返回明文。大小和声明 SHA256 都匹配后才保存。不加载导出 JS、不提取解密密钥、不改包或签名、不重启客户端。校验失败则停止并检查包版本及来源。

普通未加密 ASAR 才使用 `asar.mjs <archive> extract <exact-member> <new-file>`；该入口拒绝加密成员和不匹配的声明哈希。

## REA 分析

优先使用当前会话实际提供的 `mcp__rea__analyze_javascript_application`，输入导出的源码目录。选择清单中已确认的精确文件；设置预算时保留局部覆盖声明。

```javascript
{
  input_path: '/absolute/path/to/outputs/boss/source',
  format: 'directory',
  source_paths: ['package.json', 'preload.js', 'assets/index.d8de00b1.js'],
  detail: 'summary'
}
```

summary 只缩减返回量。保存 Evidence ID、parent_evidence_id、limitations 和覆盖范围。MCP 不可用时使用已经安装的 REA CLI，无需为了普通 JS 静态分析安装原生反编译引擎：

```sh
rea analyze-javascript-application /absolute/path/to/outputs/boss/source --json > outputs/boss/rea-evidence.json
```

定点搜索 `get-socket-port`、`window.$socket`、`zprelationGetFriendList`、`zpChatHistoryMsg`、`getLoginStatus`、`BossZhipinBridge`、`sendMessage`。压缩代码通常是一整行，输出命中点附近的小片段即可。

已观察链路：renderer → `window.$socket.send` → 本地 Socket.IO `/main` → 主进程代理/SDK → 远端业务。`get-socket-port` 提供临时端口和认证信息；复用正常 renderer 对象，不导出这些凭据。

`iBossRoot.chat.sendMessage` 位于 recruiter webview，外层签名是 `(text, type, target)`；内部可能转换成 `(target, text, type)`，不要混用。

历史 `--remote-debugging-pipe` 控制器退出曾带走客户端，当前流程使用现有进程。`9229` 是默认观察端口，不是业务端口，连接后必须核验进程身份。首次适配或版本升级时，先用 REA `inspect_electron_fuses({path:'/Applications/BOSS直聘.app'})` 确认调试相关 fuses；若无法打开 Inspector，再检查当前入口。不修改 fuses 来执行普通读取。
