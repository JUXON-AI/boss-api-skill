# 验证范围

## 平台

| 平台 | 验证状态 |
|---|---|
| macOS / Mac（Apple Silicon，arm64） | 已进行下述限定范围的验证 |
| Windows 11 x64 | 已独立实测部分只读能力；见 [Windows 验证报告](windows-validation.md) |
| Linux | 尚未验证 |

以下原有记录属于 macOS，不能外推到 Windows；Windows 的路径、CIM 进程查询、debug handler 接入和 ACL 已独立适配，逐项证据在单独报告中。

## 2026-10-23 本机只读复核

- 包版本boss-zhipin 1.7.5，主入口 `./main.jsc`；运行Electron 22.3.24。
- ASAR有16,684个文件成员，标记 `bzl-aes-256-gcm-v2`，原始密文不能当源码。
- 新脚本经现有客户端导出package、preload、renderer，三份明文大小和声明SHA256匹配。
- REA分析三份明文：Evidence `ev_59a66aae6e1ce75eed7d0085d9d9b879557960623ef627e30dd02036ae00bee0`；parent `ev_c00be90a99893b08d7690d8e6a067dcd580704c85ec97692ce4232ee6c94d295`。存在静态未知项及预算限制，不代表完整还原应用。
- 新脚本status返回已登录，list返回第一页100人；分页和全量未验证。
- REA只读核对Electron fuses，`EnableNodeCliInspectArguments`处于enabled；Evidence `ev_1bc57ae2c2a415917490d5f4e07e29d0f18dabc4fb4148fc2b4feaf1af96f9bb`。此状态只说明支持相关调试参数，实际运行入口仍以进程核验为准。
- 完成后原主进程仍运行，临时Inspector已关闭。
- 新发送脚本只做离线核验，没有实发。在线摘要、PDF和聊天历史依赖此前成功记录；本轮未为了测试更换候选人或发送。

原始材料保留在首次验证项目的 `outputs/boss-skill-verification/`，不随仓库发布，也不是其他机器运行依赖。可分享skill包不能包含联系人、聊天、简历、session或凭据。

## 此前成功记录（2026-10-22）

项目文档：`BOSS直聘在线简历接口验证.md`、`BOSS直聘批量简历与回复API验证.md`、`BOSS直聘附件简历读取与综合回复.md`。

- 两个样本在线简历HTTP200/code0，WASM摘要getter成功；完整项目描述未证实。
- 一个已授权样本的PDF为396161字节，提取文本与原页核对成功。
- 一名候选人的已审原文经SDK调用后回读到唯一出站新记录；这是此前结果，不是新脚本本次实发或批量稳定性的证明。
- 全部聊天分页、所有候选人简历、外部REST认证、服务端去重和对方已读未得到完整验证。

升级或执行实际业务时重新核对当前对象和权限，不把历史证据说成刚刚执行。
