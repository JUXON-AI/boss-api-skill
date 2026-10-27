# 逐人流水线、提案校验与只读增量观察

用于已授权持续招聘提速；不降低评分、轮次、身份、暂停或真实操作门禁。先按当前任务入口取得授权、scope和完整本人材料。

## 先完成谁，就先主验谁

用`scripts/review_pipeline.mjs`的`runReviewPipeline`接入现有编排（本引用下`scripts`相对招聘skill）。默认4个离线单人复核；每名仍只拿本人岗位、record、完整history及本人简历。不要等整个批次全部结束才验收首人。

回调依次为review、validate、主代理accept、独占claim、execute。只有review并行；同UID各版本串行，所有validate/accept/execute通过一个主队列。主代理accept明确绑定本提案与事实，不以自动校验取代原始证据验收。execute必须由现有已验收适配器执行原runner、统一sender、Base及后续交接，不能让离线代理操作服务。没有明确成功结果或执行异常时暂停该UID后续动作，不自动重试，其他UID可继续。

生产默认用`pipeline_approval.mjs`封装main acceptance（schemaVersion1、candidate含boss_job_id、原record CAS、岗位/history/proposal/text SHA及真实mainReviewSource字节SHA），并内嵌与原sender兼容的v2 send approval。发送命令必须显式带相同--job-id。不能把原sender approval直接冒充流水线accept，也不以裸approved/binding或裸verified作完成证据。

`pipeline_receipts.mjs`负责实际文件的claim/回执检查：claim按job+UID互斥、按source永久防重，并绑定main acceptance/CAS；执行结果包装原统一sender、独立前后完整history、正式ledgerAfter及CAS回执的路径/字节SHA，重算唯一新增出站与原文。未知执行保留claim，不自动释放或重发。单测/合成调度bench的第二参数是显式测试依赖替身，生产调用不得传入。

完成回执按source留存，不永久锁死本人后续真新回复。第二轮以完整history中最新实际招聘者出站为锚，正式record锚点落后则先接续核对，不拿旧答复发第二轮。发后只允许实际发送元数据及对应流程状态变化；岗位、本人身份、score/evaluation、facts、job_fit、sources和schema必须与已批准nextRecord相同。政策答复保留批准的hold/NMI状态，不能自动重置continue_contact。

review回调由当前主代理的原生JUXON委派提供；库不包含模型鉴权或后台自动群发。主代理用原生wait的“任一完成”语义接续，及时关闭完成代理，按余量补下一人。历史已完结项与精准已审mid在进入流水线前过滤。

## 自动校验与自然回复

`proposal_validation.mjs`只做纯校验：正式record、确定性评分/合法state、身份、真实轮次、当前CAS、岗位及完整history指纹、本人精确引文、暂停/人工接续、HR必须有Base读回。程序从实际UTF8生成正文SHA，不让代理手填哈希。

仓库根CLI：

```
node scripts/recruiting-proposal.mjs validate <packet.json> <proposal.json> <current-record.json> <job-profile.json> <new-validation.json>
```

CLI读取真实岗位文件字节，canonical record SHA与岗位文件字节SHA分别校验；原始材料、校验结果及主验审批分开。无新技术时明确设置packet.reviewPolicy.newTechnologyAppeared=false，保持原score整份。原有runner/sender仍会做新鲜发前校验和独立唯一新增读回/CAS。

旧snapshot若递归去除了嵌套securityId，不能再从其脱敏messages重算原full-client指纹，也不能把新的表示哈希冒充原指纹。优先复用观察器保存的可重算完整表示；没有时由主代理只读取得当前完整表示，在受保护目录分别留原源、实际文件SHA与full/semantic指纹，严格证明本人语义历史不变后重绑提案。语义有新内容先复核，不复用旧审批。平台附件接收/投递仍保留完整history，不把body.type=4平台回执当新的招聘者文本问句或实质轮次；真实较新文本仍须本人新回答，原pending invariant不放宽。

提案nextRecord是发送前decision record：保留原真实round和完整新history，只设置计划next_round；不能预先写awaiting_candidate_reply、hr_review或虚构消息mid。真实SDK、读回和CAS成功后才由原runner推进实际状态。默认保持score；只有主代理确认新技术并显式标记才重评，自动检查不替代独立evaluation及其来源验收。缺少明确record/job文件直接失败，不用旧verifyLedger缺失目录时的空数组作成功证据。

套话、过长或多目的只产生warnings，不能为了通过程序给所有人统一模板、自动改写或补“好的了解了”。顺着本人问题自然答，一次一个主要目的；纯感谢/确认常常无需发。程序提速的是检查，不替代语境判断。主验后正文改变须重绑新审批，旧SHA不能复用。

## 只读连接复用与增量观察

仓库`scripts/readonly-session.mjs`仅暴露contacts/history，复用一个已核Inspector连接和登录检查；没有send、任意bridge或eval入口。连接有时间/请求数上限，失败后不在同连接重放；每次history仍绑定本轮刚核的联系人，并要求完整/唯一mid/双方身份。

`scripts/incremental_observer.mjs`依据正常SDK联系人元数据规划history读取，只读取变化、新招呼或TTL到期对象。metadata不是新回复证明，真正新mid还要完整history核验。checkpoint只存身份/指纹/mid/成功时间；不完整、失败不推进。同job+UID不同姓名冲突不合并，学校/能力不由metadata推断。

handledMids使用SDK原始的正安全整数ID，不把它们转成字符串写配置；非法类型须在任何会话/SDK前拒绝。已核实的body.type=7/dialog.type=2及body.type=4/action.aid卡片只归平台事件，不是条件接受、实质文本或操作按钮的授权；真正接收仍逐请求经过resume planner。未知/畸形结构继续留待人工核实，不推进水位。纯本地格式纠正后可复用已保存且完整、身份/文件SHA/full指纹均通过的原history解析，保留旧失败和独立对账，不重采成功范围或重试sender。

仓库根CLI：

```
node scripts/recruiting-observer.mjs once <private-observer-config.json>
node scripts/recruiting-observer.mjs watch <private-observer-config.json>
```

观察器按配置间隔（默认60秒）只读检查，保存受保护完整快照和events待主审队列。新招呼单独标记，先按既有授权登记身份，不能直接塞旧冻结scope或自动发送。它不是已经验证的服务端推送事件监听，也不替代原4小时全面巡检、旧ack观察、历史范围外覆盖与主动简历接续。

观察低优先级：遇工作流/runner/发送锁让路，短批次后释放Inspector。前台只等待本实现标记且PID仍活跃的有界只读观察连接释放；等待仅发生在锁获取，绝不重试sender/SDK。其他锁仍保留原失败规则，不能删除或猜测清理。

maxMs是两次请求之间的合作租期，不声称能取消远端已开始请求；observer的底层单次CDP请求另强制上限2秒，普通sender超时不改。死PID/未知锁留证待核实归属，不擅自删除。完整history超出当前已验证30条读取范围时不猜分页，登记只读失败且不推进水位；同metadata不自动重读，等待主代理处理或真实新活动。其他UID可在后续预算中继续。

关闭观察器自己开启的Inspector时，cleanup总计使用2秒绝对deadline（关闭命令与全部发现查询共用）；失败如实记cleanup未确认并释放本地拥有的锁，不关闭他人Inspector、不重启BOSS。未知/死PID锁须核命令行、启动时间、用户及归属，留存证据后再人工处理。

队列按单个job+UID+mid独占文件防重；event已落盘但checkpoint未提交时也不能重排旧mid，旧集合事件按其精确mids兼容。原文件与失败回执保留，不把“预算延后/待核范围”称全部读完。

events仅表示待核增量，不表示已回复/已入库。下一主代理轮次先核源文件SHA、scope、正式record及精确已审mid再入流水线。后台观察不直接唤醒一个有写权限的模型，不因60秒采集就声称60秒内必定完成回复；主代理仍按用户的接续/定时设置运行。

## 性能验收

- `performance_benchmark.mjs`比较相同合成review延迟下批末屏障与逐人流水线，分别报告首项/总时长；不能当真实BOSS回复速度。
- 仓库`scripts/recruiting-read-benchmark.mjs`在无其他工作流时对同一联系人页做少量只读对比，交替隔离/复用顺序；只保存聚合计时，不发消息、不读候选history、不写Base。
- 真实端到端回复速度须等待自然新任务，记录发现/完整读取/复核/主验排队/发送及读回/入库各阶段。无自然发送样本就明确未实测，不发无内容测试消息，也不减少原门禁制造指标。
