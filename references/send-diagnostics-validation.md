# 发送失败诊断离线验证

## 范围

- 基线：detached `ece0734` 的隔离 worktree。
- 仅修改公开发送链路、共享诊断模块、合成 VM/fake-socket 测试和发送说明。
- 未连接真实 BOSS、Inspector、业务 SDK、MQTT 或外部网络；未发送或重放任何消息。
- 未读取、修改或运行私有 runner/collector 实现。

## 修复前证据

基线公开测试在旧实现上为 61/61 通过，说明现有测试未覆盖以下传输与异常组合。

新增的 6 个 synthetic runtime 场景在旧实现上为 0/6：

1. WS 建立后 close 不终止 pending 请求，子进程等待到外部 3 秒 watchdog。
2. WS 建立后 error 不终止 pending 请求，同样等待到 watchdog。
3. CDP 请求超时只有泛化文本，没有稳定 code、stage、requestId 或受限 elapsed；旧测试等待 20 秒而被 watchdog 截断。
4. 无效 JSON 帧在 WebSocket 回调内形成未处理的 `SyntaxError`，pending 与 lock 不能完成可控清理。
5. 连接错误没有 `ws` stage 和 `WS_CONNECT_ERROR` 稳定 code。
6. callback 主错误后 cleanup CDP 错误覆盖主错误，原 code/message 丢失。

这些复现证明代码缺陷存在；旧版 `internal_error` 若未保存原始错误，不能据此重写历史归因。

## 修复后的可验证行为

- CLI stderr 保持单行 JSON；原有 `error` 字段仍为脱敏字符串，另增结构化 `diagnostic`。
- 共享 `serializeDiagnosticError(error, context={})` 输出 JSON-safe、深度/数组/键数和总节点有界的结构，包含 stage、安全 action、requestId、elapsed/elapsedMs、稳定 code、name、受限 cause/stack/context，并保留不同层级的不同 code。
- 用户名目录、URL、Cookie/token、签名键值、bridge payload、表达式、聊天正文以及安全标识字段均被脱敏；Windows/POSIX 与 plain nested stack 只保留 basename、行列号。
- 冻结 Error、循环 context、共享节点、跨 realm Error cause 和超大 context 可安全序列化。
- WS close/error、CDP timeout、无效帧、连接失败均有稳定 code，并在锁释放前终止 pending。
- 合法无 id 的 CDP notification 被忽略；合法 `undefined` evaluation result 不再被当作协议错误。
- 远端 CDP 错误和 evaluation 描述保留经过统一脱敏的有限原生 name/code/message/stack，不保存 expression、payload 或原始事件。
- callback/cleanup 同时失败时保留主错误，并把 cleanup 作为 secondary diagnostics；ownership 未验证事实不再写裸 stderr 文本。
- 两段 cleanup 失败可合并，日志序列化失败不覆盖主错误，也不会触发重发。
- 发送不回归：单一 SDK invocation、两次完整历史预检、读取前哈希、独占 attempt、未知结果禁止自动重试、lock 释放与 output 独占均保留。

## 离线验证

- `node --test scripts/*.test.mjs`：82/82 通过。
- `node --test skills/boss-recruiting-agent/scripts/candidate_ledger.test.mjs`：8/8 通过。
- 新增诊断序列化与 runtime synthetic 场景：21/21 通过。
- send harness 的 fake SDK 场景继续验证每次流程最多一次合成 invocation，且不访问真实网络。
- 主代理另以相同全 mock VM 对比基线与修复版：断连前后、合法 notification、主异常与 cleanup 同时失败、远端 CDP 原生错误、evaluation 原生错误、合法 undefined 返回，共 7/7 通过。发送后断连场景的 callback 与合成 SDK 均只调用一次；没有真实网络或业务 SDK 调用。

## 边界

- 没有真实客户端、真实 WebSocket、业务 SDK 或网络证据；这些结果只验证离线控制流与序列化契约。
- 旧日志若缺少 stage/request/cause，请求耗时只能支持排查假设，不能作为历史根因确证。
- 修复避免通过提高 timeout 掩盖故障；timeout 仅是带阶段和稳定 code 的显式失败路径，仍禁止业务重试。
