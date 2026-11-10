# DeepSeek Harness宿主适配

仅在用户指定Harness为执行宿主时适用。招聘规则、评分、原工作区文件与统一sender全部共享；不复制一套接口实现，不借迁移重置状态。当前Harness主代理承担原“主代理”的全部职责。

## 安装和加载

本机已核对的桌面运行时0.2.1-rc.5使用标准YAML frontmatter的SKILL.md。源码dsh-skill-filesystem的查找顺序为项目.dsh/skills、项目.agents/skills、自定义目录、用户$DSH_HOME/skills、用户$DSH_AGENTS_HOME/skills及内置目录；未配置时用户目录分别为~/.dsh和~/.agents。桌面profiles/desktop不是skills目录。宿主升级或自定义配置时重新核对，不能直接沿用Codex目录。

从仓库执行：

```powershell
node scripts/recruiting-skills-install.mjs --host deepseek-harness
node scripts/recruiting-skills-install.mjs --host deepseek-harness --check
```

用--home指定实际Harness主目录（不是其skills子目录），或由DSH_HOME取得。全部模块及实现资料同级安装，脚本仍在原仓库运行。加载boss-recruiting-deepseek-harness；支持原生skill工具时按当次工具schema加载，不要求$前缀或Codex专用工具。已存在项目级同名skill会优先于用户版，须先核对版本，不能声称用户版安装成功就证明当前会话已用新版。

飞书依赖另从本机实际lark-cli的skills list/read取得同版本lark-shared、lark-base、lark-drive、lark-mail、lark-im，以及需要的lark-doc/wiki/contact/openapi-explorer，连同各自引用安装到同一Harness skills目录。可用skills read <name> --json中的content写入原SKILL.md，避免将CLI提示行写在YAML frontmatter之前。先核lark.cli配置路径及--version，PATH没有命令不等于未安装；不为迁移重装CLI、复制凭据或重新登录。

## 主代理和复核

- 先核当前会话的实际工作目录及用户指定私有入口，读取main-state/latestHeartbeat、scope、锁、服务暂停及未完成回执。不默认使用旧DSH会话ID，不向其他会话投递任务，不编辑压缩会话日志。
- 用Harness已暴露的本地文件和终端能力运行PowerShell、Node及lark-cli。工具名与参数以会话实际schema为准；本机工具源码支持terminal_open/terminal_send/terminal_read等，但不假定所有安装均启用。禁止computer-use、DOM和GUI采集发送。
- 优先使用Harness原生subagent，只传prepare生成的request.message及本人当前语料/资料；子代理不调用工具或服务、不读文件、不写正式账本，只返回JSON。使用不继承多人上下文的spawn后端；仅有继承整段上下文的fork且不能隔离时，由主代理逐人离线复核，不将多人隐私带给子代理。不能把提示“不操作”冒称运行时禁用了工具。
- 本机原生subagent参数包括prompt、description、可选cwd；使用实际公布的工具schema。模型路由仅选宿主公布且用户授权的provider/model组合，不照抄JUXON模型ID，也不把候选人Claude Code账号偏好当宿主模型配置。
- 并发沿现有有界流水线，谁完成谁先主验；工具缺失时主代理逐人执行同样的离线检查，不把缺少JUXON当失败或未经复核通过。完成通知及回收使用当次工具提供的原生方式，不调用Codex的spawn_agent/wait_agent。
- prepare/check仍使用仓库scripts/recruiting-review.mjs，评分与SHA由程序重算。主代理独立核原始证据、完整历史与实时HR语料后转正式提案，自动valid不是发送审批。回复保持本人语境，不因JSON结构统一候选人话术。

## 恢复与实际操作

用户明确迁移到Harness后，旧任务中“禁用DSH/只用JUXON”仅作为原宿主分工历史，不阻止本模式；其他岗位授权、scope、账号异常、候选人明确暂停、未知发送与两轮上限原样保留。迁移不代表用户已处理账号异常，不允许健康探测绕过既有暂停。

所有真实BOSS文本仍经原仓库scripts/boss.mjs send；飞书操作通过配置用户身份的lark-cli，群推送保持独立防重与读回。不通过邮件联系候选人。不复制Codex模型网关、鉴权或会话文件，不因换宿主修改候选分数或重新交接/推群。

读取原工作区.codex/boss-recruiting.json作为现有业务配置不等于依赖Codex服务；保留原路径以兼容已验收runner和receipt，不改名或复制第二份状态。需要lark技能时安装到当前Harness的skills目录；缺少CLI/身份/权限则只暂停相关阶段，不能借迁移登录其他账号。

定时默认不启用。只有用户另行要求且Harness实际提供已验证的调度入口时才配置；不恢复已取消的Codex任务，不用启动无限循环替代调度。最终报告分清离线测试、宿主实际加载、在线读取及真实副作用，未实际执行的阶段不能称完成。
