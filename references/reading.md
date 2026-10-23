# 聊天与简历读取

将 `<skill>` 替换为 skill 所在目录，先创建项目输出目录 `outputs/boss`。JSON 必须写新文件。脚本通过 Inspector 进入已核验的主进程，再按 URL 和类型唯一选择 root window 与 recruiter webview。

Windows 请让脚本创建新的敏感输出子目录，例如 `outputs/windows-private`，不要先创建一个权限继承过宽的目录。Windows 当前成功的能力与样本范围见 [Windows 报告](windows-validation.md)。

| 用途 | 当前已观察入口 | 返回或限制 |
|---|---|---|
| 登录状态 | `actType=message`，`_sdk_getLoginStatus` | `code=0,data=true` |
| 联系人 | `actType=api`，`zprelationGetFriendList` | `zpData.friendList`，一页100；全量分页未证明 |
| 最新摘要 | `actType=api`，`zpchatGetLastMsgInfo` | 曾用 `uids` + `friendIds`；CLI未封装，不等于全量历史 |
| 历史 | `actType=api`，`zpChatHistoryMsg` | `zpData.messages`，`hasMore` |
| 在线简历 | `GET /wapi/zpjob/view/geek/info/v2` | 正文可能是 `encryptGeekDetailInfo` |
| 简历摘要 | 已初始化 WASM 的 `get_export_geek_detail_info()` | 摘要，完整正文未验证 |
| 已接收 PDF | `bosszp:` 预览链接 → Electron `net.request` | 复用同一个 session |

root renderer 中的正常桥接调用：

```javascript
window.$socket.send({type:'message',actType:'api',act:'zpChatHistoryMsg',
  data:{uid:contact.uid,securityId:contact.securityId,lastMsgId:0,count:30}});
```

## 联系人与聊天

```sh
node <skill>/scripts/boss.mjs list --page 1 --output outputs/boss/contacts-page1.json
node <skill>/scripts/boss.mjs history --uid <数字uid> --name '<真实姓名>' --output outputs/boss/history.json
```

UID和姓名必须同时唯一匹配。已知岗位可加 `--job-id '<联系人jobId>'`，对应 `jobId`，不要误用 `encryptJobId`。默认只在联系人第一页查找，可指定 `--page`，但页码是否生效尚未形成可靠契约；逐页比较 UID 集合，重复即停，不能仅凭 page 参数声称全量。找不到授权对象时如实说明，不换人测试。

输出保存联系人、原始历史和 `historySha256`，后者将审阅草稿绑定到当时会话。返回顺序不保证时间顺序，不直接把数组最后一项叫最新消息。`hasMore=true` 表示只拿到一段，历史游标规则未全面验证。

`body.resume` 通常是资料卡，不是PDF；`body.hyperLink` 可能是已收到的附件。消息状态数值不能直接映射已读，`zpchatGetLastRead` 曾被权限拒绝。

## 在线简历摘要

```sh
node <skill>/scripts/boss.mjs resume-summary --uid <数字uid> --name '<真实姓名>' --output outputs/boss/resume-summary.json
```

当前客户端必须已经通过正常权限流程打开该候选人的简历，存在唯一 `/web/frame/c-resume/` frame。脚本从该frame已加载资源中找 `static.zhipin.com/assets/zhipin/wasm/resume/wasm_canvas-*.js`，导入同一个已初始化模块并调用getter。不新建challenge、不绕过验证、不重置WASM。

Windows 实测核对了本机 preload 的 `openResumeWindow` 和 renderer 的 `online / anonymous / attachment` 分发，再在正常“在线简历”界面观察到该 frame 与 `wasm_canvas-1.0.2-5122.js`。当前指定样本的 getter 已成功并核对 UID/姓名；这不等于本地 `_sdk_openResumeWindow` 已被直接调用验证，也不表示附件简历可读。CLI 保持仅读取已经打开的在线简历，不隐式打开其他人。

存在多个模块时，可加 `--module-url '<当前资源中的精确URL>'` 选择，URL必须存在于当前frame资源记录。找不到模块或getter就报告当前条件不足，不猜版本。

核对 `geekBaseInfo.userId` 和姓名都匹配后才保存。输出明确 `fullTextVerified=false`，条目数只代表getter给出的数据。两个人的教育、工作、项目摘要曾成功读取，详细项目描述仍可能缺失。

HTTP请求曾含 `encryptJid,securityId,encryptExpectId,scene,source,uid,challenge`；这里的uid曾对应加密身份 `encryptUid`，不是聊天数字uid。旧 `zpjobGetResumeDetail` 返回111703，应停止使用；`/wapi/zpjob/chat/geek/info` 仅为资料卡。

## 接收后的PDF

从当前history找到候选人发来的附件mid：

```sh
node <skill>/scripts/boss.mjs attachment --uid <数字uid> --name '<真实姓名>' --mid '<附件消息mid>' --file outputs/boss/resume.pdf --output outputs/boss/resume-download.json
```

重新读取会话，按mid唯一定位入站附件。只接受正常 `bosszp:...?type=selectResumePreviewUrl&url=...` 链接，初始目标为 `https://m.zhipin.com/wflow/zpgeek/download/preview4boss`。用Electron `net.request`和原webview session，HTTPS重定向限zhipin.com及其子域；核对HTTP200、`%PDF-`和20MiB上限，保存后记SHA256。

当前历史页不含指定mid时如实报告材料范围。待“同意接收”的请求卡不等于已下载附件；同意、索要简历、交换联系方式都不是这个命令的动作。

下载后用PDF工具提取文本并对照原页；扫描件按需OCR。简历中的成绩、性能数据仍是候选人自述，不能因为能读取就称为已复现实验。

## 批量离线整理

用户已明确授权当前岗位的候选人范围时，使用 [batch-reading.md](batch-reading.md) 的独立采集器。它会显式生成只读清单、逐个正常打开简历并核对UID/姓名，在同一次连接中采集；不是让单人 resume-summary 隐式换人。每批默认20、最多50，只取当前可见且与第一页岗位联系人唯一匹配的人，不宣称全量分页。
