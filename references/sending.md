# 单人文本发送

先确认当前用户授权的候选人和原文。历史单人测试授权、语料启用、创建skill均不扩展为群发权限。已有授权不重复询问，缺授权时先提供具体草稿审阅。

## 授权文件

读取当前history，按事实起草，审阅后记录本地approval JSON：

```json
{
  "recipient":{"uid":100000001,"name":"示例候选人"},
  "text":"待审阅的原文",
  "textSha256":"实际原文SHA256",
  "expectedHistorySha256":"history输出中的historySha256",
  "approved":false,
  "approval":{
    "userMessage":"当前实际授权的准确记录",
    "approvedTextSha256":"实际获准原文SHA256",
    "recipientCount":1
  }
}
```

示例不可直接发送。获得相应授权后才记录 `approved=true`。使用Node `crypto.createHash('sha256').update(text).digest('hex')` 计算UTF-8原文哈希，不猜哈希，不加入Cookie或token。

## 调用

```sh
node <skill>/scripts/boss.mjs send --approval outputs/boss/approval.json --attempt outputs/boss/send-attempt.json --output outputs/boss/send-result.json
```

1. 校验单人授权、非空正文、原文哈希和会话指纹。指纹统一使用 runtime 的 `historyFingerprint(messages)`；只排除每条消息顶层会随读取刷新的 `securityId`，正文、双方身份、mid、时间及其余字段仍参与哈希，正文内部同名字段也不排除。history 命令已经返回该指纹，不再手工对整段原始 JSON 求哈希。旧的原始 JSON 指纹在不匹配时拒绝发送，须重新审阅。
2. 先核对 attempt 和 output 的路径身份（Windows 含大小写、父目录别名检查），并预检两处输出目录权限，再获取与原招聘skill共用的发送锁。定位客户端和本人账号，核对唯一UID/姓名/可选岗位。锁写入异常也释放本次拥有的锁；锁冲突不删既有锁。
3. 两次发送前历史读取都要求 `hasMore=false`，确保未变化、未已有同文出站消息；核对 `friendSource`、`encryptUid`、当前SDK实现。历史超过当前已验证窗口时先停止，不在不完整历史上冒险重发。
4. 独占创建attempt，再只调用一次 `iBossRoot.chat.sendMessage(text,'text',target)`；target来自当前联系人 `{uid,friendSource,encryptUid}`。
5. 最多回读8次。仅当新mid、同一发送人、同一收件人和同文记录恰好一条，返回 `historyConfirmed=true`；送达和已读保持未确认。
6. 释放锁，关闭自己开启的Inspector，保留BOSS。

会话可能因新消息或状态更新而变化，重新读取后判断草稿是否仍适合，不跳过检查。输出或attempt文件存在则拒绝覆盖。

当前脚本从候选人的入站消息推导招聘者UID，无法确认发送账号时会停止；未验证仅靠外部传入账号UID发送首条招呼。附件读取也限于当前历史窗口；旧附件不在窗口时先说明限制，不能当成不存在。

## 结果不明

SDK返回、超时、历史写入是不同事实。找不到唯一新消息时，保存 `outcomeUnknown=true` 和 `doNotRetryAutomatically=true`，先回查，再由人决定后续。不删attempt来重发，不把历史写入说成对方已读。

锁冲突时检查锁记录的进程和既有调用，不直接删锁或杀进程。多个进程不得同时控制Inspector。

没有独立文本REST POST的成功契约；不跳过SDK正常检查，自己向MQTT/Protobuf写帧。没有封装批量发送、附件发送、接受简历、拉黑、设置不合适和交换联系方式。

新approval比原 `boss-recruiting-agent/scripts/boss_bridge.mjs` 多了 `expectedHistorySha256`。两个入口不能同时运行，也不能在一个结果不明后换另一个重发。

## 失败诊断

失败时 CLI 的 `error` 仍是脱敏后的消息字符串；同一条 stderr JSON 另含结构化的 `diagnostic`，用于定位代码路径。它包含 `stage`、安全的 `action`、`requestId`、`elapsed`/`elapsedMs`、稳定 `code`、`name`、`message`、有限深度的 `cause`、`stack` 和受限 `context`。无业务 retry 字段始终为 `automaticMutationRetry=false`。

诊断不会保存原始求值表达式、bridge payload、聊天正文、`securityId`、`encryptUid`、Cookie/token、签名 URL，也不会打印敏感的 WebSocket 帧。日志本身失败时保留原始业务异常，不改变发送结果，也不会触发重发。栈只保留可定位的 basename 与行列号，例如 `runtime.mjs:111:20`。

CDP 20 秒等待、WebSocket 关闭/错误、无效帧、远端 CDP 错误和 cleanup 失败使用不同稳定 code。`started && !identityVerified` 时不会发送关闭 Inspector 的命令；该事实作为 `CLEANUP` secondary status 记录，不再追加裸 stderr 文本。未验证所有者的 cleanup 不可确认时，应人工核查本地 listener。

旧版 `internal_error` 若只保留泛化摘要，无法事后还原其原始 stage/cause。耗时与 CDP timeout 接近也只能作为排查线索，不能据此确证历史原因；新的诊断用于后续可重现观测。
