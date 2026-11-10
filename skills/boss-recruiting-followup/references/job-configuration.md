# 通用招聘：公司 → 部门 → 岗位 → 执行任务

通用skills只规定证据、主验、防重、轮次及真实读回。待遇、业务、技术栈、用工类型、评价标准、人才表和推送群来自当前批准配置，不从历史后端实习任务推导。Harness与Codex共享同一配置机制。

## 最小配置

| 层级 | 内容 | 生效范围 |
| --- | --- | --- |
| 公司 | company_key、公开事实与来源、对外权限 | 同公司明确适用的岗位 |
| 部门 | department_key、业务口径、部门特有政策 | 精确部门，不跨部门继承 |
| 岗位 | boss_job_id、用工类型、职责、薪资单位、工作模式、screening_policy | 精确岗位及政策版本 |
| 任务 | scope/manifest、ledger、授权动作、暂停、HR语料、人才表映射、推送群 | 本任务授权的候选人及动作 |

新增岗位先用boss-recruiting-config准备。示例文件位于项目实现skill的assets：job-profile.design.example.json（设计）、job-profile.hr.example.json（人事招聘）、recruiting-registry.example.json（路由）。全部是未批准草稿，无真实联系授权，不能直接当公司政策。原job-profile.example.json和full-time例保留为历史软件岗兼容样例。

新岗位必须明确screening_policy；字段定义见项目assets/job-screening-policy.schema.json。schema_version=1，id/revision以及company_key/department_key/boss_job_id绑定岗位。approved只能由已授权使用者确认；模板false不允许发送或入库。职责与必需条件不完整时先准备草稿，不能靠自动批准补齐。

## 评分与条件

四个存储键保持兼容，但按岗位设置label/rubric/weight：core_role_skills（岗位核心能力）、project_depth（本人实践与案例深度）、engineering_habits（专业方法和工具习惯，不限工程）、learning_and_collaboration（有证据的学习协作）。权重合计100；没有证据用null，按已知权重归一计算，覆盖单列。非技术岗位不要求后端功能、代码、GitHub或AI编码。

thresholds分别配置ability_base、coverage、signal、job_fit。conditions逐项配置key/label/required；仅required=true参与入库硬门禁，可选偏好未知不阻塞。未配置学校手续、实习时长、Go、AI工具或Claude账号时不追问、不作为加分或拒绝条件。实习才按其实际配置确认学校/周期；全职按其职责、到岗与办公方式等配置，不套“至少3月、学校方便、日薪100–120、西安现场”。合同工、兼职与其他类型仍须明确实际用工条件。

当前通用评分器proof_bonus仅支持none，避免把软件竞赛/GitHub证明加到设计、HR等岗位。要新增岗位专用奖项或业绩加分时，先配置并验收相应确定性适配器，不由模型填一个加分数。Go和Claude偏好文档仅在旧任务已明确启用或新policy相应conditions已配置时加载。AI产品部游戏业务、顺带Go指点和算力支持均为原范围事实，不是通用问答。

通用正式record增加screening_policy原快照及job_fit.conditions，每个confirmed/conflict条件须有来源引用和精确原话；policy_version由role:id:revision标识。新政策影响已评分对象时单独审定迁移，不能重新计算所有历史分数。没有screening_policy的旧record沿原政策、原分、原门禁核验，不因安装新版自动转换。

## 知识口径与执行适配

每条事实保存key、content、company_key、scope(company/department/job)、适用部门/岗位、source、status、external_allowed。只有已确认且允许对外的匹配范围事实可用于回复；resolveKnowledgeFacts只筛范围并显式返回冲突，不自行判谁覆盖谁。实时HR语料也按公司、部门、岗位、用工类型、审核状态和权限筛选；同名部门不跨公司匹配。

实际job profile文件SHA、岗位policy快照、正式record和审批同时绑定。示例条件在离线复核、正式record校验、提案和群推送中使用同一份配置；缺失或不一致阻断阶段。人才表字段随fresh schema与该岗位映射，不把旧15/17字段或同一推送群当全局固定值。

旧私有runner、Base构造器和批次脚本可能绑定原岗位。新增岗位必须有精确scope和已验收适配器，不能只换job_id就执行旧脚本。当前版本验证通用策略与多岗位合成样例，不表示已真实验证所有岗位、所有字段表或所有企业账号。用户未授权的新岗位只建配置草稿；不创建新定时、自动恢复账号或任何候选人暂停。
