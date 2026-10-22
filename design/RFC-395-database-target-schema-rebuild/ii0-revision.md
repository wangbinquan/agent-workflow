# RFC-395 II-0 设计修订依据（附录）

- **性质**：接手会话 2026-10-21 的只读研究产出，逐项给出事实、方案与推荐。全部 20 项已按推荐裁决，结论写回 [design](./design.md)、[migration](./migration.md)、[table-mapping](./table-mapping.md) 与 [plan](./plan.md)；用户决定见 plan §6.6。
- **保留原因**：本附录保存写回正文时未逐字转录的实施细节，例如「当前选中运行」77 处计算点的 12 组迁移分组、各项事实表与复现步骤。正文与本附录冲突时以正文为准。
- 下文是研究原稿，原标题与「供裁决」等措辞保持原样；行号基线为 HEAD `865944979`。

---


- **性质**：只读研究产出的修订提案，供接手会话裁决后写回 `design.md / migration.md / table-mapping.md / plan.md`。本文件不改仓库、不跑测试；只做功能 / 架构分析。
- **基线**：HEAD `865944979`（代码与 `2a6b366f9` 相同，其后只有文档提交）。工作树含 RFC-396 未提交改动（`db/schema.ts`、`collaboration/infrastructure/review.ts`、`task-execution/composition/digitalEmployeeExecution.ts` 等），下文行号以 HEAD 为准，工作树里个别文件偏移 +1～+18 行。路径省略前缀 `packages/backend/src/`（`shared/…`、`frontend/…` 指 `packages/shared/src`、`packages/frontend/src`，`tests/…` 指 `packages/backend/tests`）。
- **每节结构**：① 事实（file:line）② 方案与后果 ③ 推荐与理由 ④ 设计文档修改（可直接粘贴）⑤ 是否需用户决定。
- **依据**：research-2/3/4 与 r4-sub 子报告；关键事实已回源码复核（本文引用的行号均为本次复核结果）。

## 0. 总览

### 0.1 逐项裁决

| # | 项 | 推荐裁决（一句话） | 用户决定 |
| --- | --- | --- | --- |
| 1 | 宿主 workflow | 4 个宿主全部退出 catalog；`subject_kind` 五值（workflow / agent / workgroup / digital-employee / code-round）；`definitionAnchorId()` 领域常量映射只在边界投影旧 `workflowId/workflowName`，并作为调用闭包键与记忆 workflow 作用域键的稳定命名空间；读时排版改由冻结的 `definition_origin` 决定 | Q1（非 workflow 任务的 workflow 记忆作用域）；Q2 可选 |
| 2 | 持久化 JSON 内嵌旧行形状 | 纠正风险判断：人工门续跑围栏摘要在决定事务内算、内比，提交后不再重算，不是切换风险。真正风险是会回插新表的「在途回放载荷」（澄清 / 评审开门清单、未接纳的准备回执）→ 冻结前收敛、目标运行时只处理 v2；由旧字段派生的身份与幂等键按值搬运、不重算；自含载荷与对外协议保持字节与 v1 schema；`*_repos_json` 等列内 map 作为表重构转换；归档版本号升级 | 否 |
| 3 | 选中运行 | 先在现有 schema 上立 `RunSelection` 端口（domain 槽位键 + 唯一排序合同 + application 端口），77 处按 12 组迁入，再换表实现；`node_run_selections` 主键改为 `(task_id, slot_key)`，代次作为属性 | 否 |
| 4 | 多表 CAS | 把与生命周期 CAS 绑定的可变列（工作区根、prune 三列、终止 fence / effect_rev）留在 `tasks`；`task_definitions` 修订走「先锁聚合根」协议；NodeRun 走「根行 CAS 先行、从属表同事务后写」，`merge_state` 与 iso 根、wrapper 进度同表 | 否 |
| 5 | 子任务树删除 | 树结构列（`parent_task_id` 自引用 CASCADE、`root_task_id`、`invocation_depth`、`branch_started_at`）留在 `tasks`；启动来源字段进 `task_launch_contexts`；纠正 `branch_started_at` 被误归工作区 | 否 |
| 6 | 主仓投影例外 | 显式 `requested_source` + `task_branch`（`task_workspaces`，冻结）+ `tasks.workspace_root_ref` 可空（NULL=未绑定）+ 单一投影函数；无挂载时按请求合成 `repos[0]`，`repoCount=max(1,n)`；写者总落最小目录树 | 否 |
| 7 | D 清单补项 | D3 补 pre-snapshot 无生产者事实与 retry 模式删除；D4/D12 补启动期 seq / frame 回填；D12 补其余启动期旧数据升级步骤的分类义务 | 否 |
| 8 | `envelope_nonce` | 归 `node_runs` 身份列（铸行即生成、不可变），`node_run_runtime_states` 保持按需建行 | 否 |
| 9 | design 内部待定 8 点 | 逐点裁决（见 §9）：merge_state 归运行态表；去掉 checkpoint 的 `isolation_root_ref`；map 键经 `worktree_dir_name→repo_key` 映射；三态字段 + 行存在性；问题集只增 + `questions_revision`；消费边按（源节点, shard）粒度；`review_iteration` 是 CAS 可变属性；两代轴独立 | 否 |
| 10 | 前端严格解析 | 现有 zod 合同即投影验收标准；逐字段投影规则入 design；增「新旧二进制 DTO 对拍」测试 | Q2 可选 |
| 11 | 迁移机制待决 | 见 M1～M8（M6 已决） | 见 M3、M4 |
| 12 | 疑似缺陷 | **属实（代码阅读）**：单个非根成员的仓库组任务 `iso_node_tree` 落 NULL、恢复时 base 键错配；给出复现用例；单独修复；转换器识别已受影响行 | Q5 |
| 13 | 先删死代码 | 先行独立提交删除 `startTask` 族、`getTaskNodeRuns`、GC 库函数、intent `converge`、`services/bundle/provider.ts` 死合同段；**保留** `decideIntentApplyConverge` 给 T10 收编 | 否 |
| M1 | 新 epoch 后的演进机制 | 两 provider 统一的「合同历史 + 类型化边」机制；SQLite 增加重建表边；drizzle-kit 不再生成迁移 | 否 |
| M2 | 行处置粒度与存放 | 同键可推导转换用 chunk 级证明，例外行级记录；存目标库元数据表（与行同事务），完成后写一次性文件导出 | 否 |
| M3 | SQLite 目标文件与 pointer v2 | 代次目录文件 `databases/<generationId>/db.sqlite` + pointer v2 显式指向；源文件 `completed` 后改名移入操作根；目标库内置哨兵收据 | Q3 |
| M4 | provider 差异裁决 | 7 触发器：3 删除（不变量进领域）、2 改原生 CHECK、2 组「不可改写」规则改为两侧原生的类型化规则；8 FK 两侧采用（`added_by` 规范为 NO ACTION）；`tasks.name` 两侧 NOT NULL；部分 / 全量唯一按显式部分唯一 | Q4 |
| M5 | 种子行 | contribution 新增 `seeds`（新装执行、转换器保留源值）；3 张表 4+1+1 行；`employee_os_writer_state` 退役进回执 | 否 |
| M6 | 跨 epoch 备份恢复 | 已决（经转换器恢复）；本文只补实现约束 | — |
| M7 | `migrationRole` 退役 | 角色归 generation（`installed / converted / restored`）与迁移 run 的 provider 对；约 20 处同一提交改齐 | 否 |
| M8 | T2a 等价标准 | 已决（逐字节为目标、规范化兜底）；补「规范化只作用于 SQL 表达式文本」的边界 | 否 |

### 0.2 需用户决定的问题

| 编号 | 问题 | 推荐答案 |
| --- | --- | --- |
| Q1 | Agent / 工作组 / 数字员工任务今天共用以宿主 id 为键的「workflow 记忆作用域」（同类任务互相注入）。宿主删除后是否保留这一行为？ | **保留**：作用域键改由领域常量提供，现有记忆原样迁移，注入与蒸馏结果不变；如要改为「无 workflow 作用域」，另立 RFC 并给出既有记忆的去向 |
| Q2（可选） | 非 workflow 任务在首页任务行、评审列表里今天显示宿主名（如 `__agent_host__`）。RFC-395 是否顺带改为显示真实主体名？ | **不改**（RFC-395 只做等价投影）；如需改，另立小 RFC 同步改 shared 合同与前端 |
| Q3 | 切换后 SQLite 业务库文件从 `~/.agent-workflow/db.sqlite` 改为 `~/.agent-workflow/databases/<generationId>/db.sqlite`，由 pointer v2 指定；旧文件在切换完成后移入迁移操作目录保留。是否接受这一文件布局变化？ | **接受**：切换只需原子替换 pointer，崩溃语义最简单；运维文档同步更新 |
| Q4 | PostgreSQL 部署上删除一条记忆后，其他记忆里指向它的 `supersedes_id / superseded_by_id` 今天保持悬空（SQLite 会自动置空）。目标两侧统一为「置空」，转换时把 PG 存量悬空指针置空并留证据。是否接受？ | **接受**（与 SQLite 现行为一致） |
| Q5 | 第 12 项缺陷的单独修复，是按「缺陷修复 + 回归用例」直接提交，还是先立小 RFC？ | 按缺陷修复直接提交（不改产品行为，只让崩溃恢复按原设计工作）；若认为属非平凡重构，则立小 RFC |

---

## 1. 宿主 workflow（§6.4-1）

### 1.1 事实

**四个宿主 ID**（均无迁移播种，只在运行时懒播种或已无写者；`tests/rfc199-workflow-writer-inventory.test.ts:17-41` 计数三个播种 INSERT）：

| 常量 / 名称 | 定义 | 播种 | 写入任务行 | 现状 |
| --- | --- | --- | --- | --- |
| `00000000000000AGENTHOST00` / `__agent_host__` | `services/agentLaunch.ts:24-25`；重复 `modules/task-execution/infrastructure/agentLaunchResourceOperations.ts:22-23` | `hostWorkflowRow` `agentLaunchResourceOperations.ts:25-40`、`ensureHostWorkflow` `:80-85`；调用 `taskRouteLaunchOperations.ts:1095` | `taskRouteLaunchOperations.ts:1128, 1164` | 在用 |
| `00000000000000WORKGROUP00` / `__workgroup_host__` | `modules/resource-catalog/infrastructure/legacy/workgroup/constants.ts:15-16`；重复 `taskRouteLaunchOperations.ts:108-109`、`childExecutionLaunchOperations.ts:62` | `ensureWorkgroupHostWorkflow` `legacy/workgroup/launch.ts:151-169`；调用 `taskRouteLaunchOperations.ts:1293`、`childExecutionLaunchOperations.ts:290` | `taskRouteLaunchOperations.ts:1268, 1302`；子任务 `childExecutionLaunchOperations.ts:303, 314` | 在用（含 call-workgroup 子任务） |
| `00000000000000DIGEMPHOST0` / `__digital_employee_host__` | `modules/task-execution/domain/digitalEmployeeHost.ts:14-15` | `ensureDigitalEmployeeHostWorkflow` `composition/actionExecutionRunners.ts:181-200`（`onConflictDoNothing`）；装配 `digitalEmployeeExecution.ts:869`，调用 `:626` | `actionExecutionEnvironment.ts:112, 124-125`；`digitalEmployeeExecution.ts:500, 610-611` | **在用，D1 未列** |
| `00000000000000CODEROUND00` / `__code_round_host__` | `services/codeRoundContract.ts:20-21` | 无生产写者（`StartTaskDeps.codeRoundLaunch` 只在测试路径，`services/task.ts:713, 2499`） | 历史行 | 历史数据 |

- 数字员工有两种实现：`implementation.kind === 'workflow'` 时启动**真实工作流**主体（`digitalEmployeeExecution.ts:523-540`），agent / program 实现才合成宿主图（`:541-612`）。两种情况都写 `digital_employee_round_id / case_id`（`taskRouteLaunchOperations.ts:918-919`）——它是**启动来源事实**，不是主体。
- 主体判别 `taskExecutionKind()`（`shared/schemas/task.ts:710-725`）：code-round > workgroup > agent（按 `sourceAgentName` 名称）> workflow。数字员工宿主任务落成 `workflow`。
- 宿主节点 id（`__wg_leader__ / __wg_member__ / __wg_clarify__`、`__agent_*__`、`__de_*__`、`__code_round__`）是线上冻结值（`legacy/workgroup/constants.ts:10-12` 注释），历史 `node_runs` / `clarify_rounds` 以它们为身份。
- RFC-396 在制的 `resource-catalog/composition/builtinWorkflowCatalog.ts` 播种的是**真实内建工作流**（有定义、按内容校验），不是宿主。

**宿主行的隐性依赖**（删行后各自的行为）：

| 依赖 | 位置 | 删行后不改代码的后果 |
| --- | --- | --- |
| 评审列表 / 角标 / 详情 join `workflows` | `collaboration/infrastructure/review.ts:1849-1856`（`if (wf === undefined) continue` 在 `:1885-1886`）、`:1997`、`:2032-2042`；组装 `:1755-1771` | 非 workflow 任务的评审从列表消失、详情 `review-not-found`（DE-28 事故原型，`digitalEmployeeExecution.ts:617-626` 注释） |
| 手动执行守卫 | `taskRouteOperations.ts:1445-1465`（`builtinCandidateWorkflow` → `assertNotBuiltin`） | 轮次引擎工作组与数字员工任务的返回从 403 `builtin-readonly` 变成「工作流不存在」类错误（错误码变化） |
| 读时排版 | `taskRouteOperations.ts:357-383`（`workflowIdentities`）、`:405-428`；`services/task.ts:1714-1716` | Agent / 工作组 / 数字员工画布不再自动排版 |
| `workflowName` | `taskRouteOperations.ts:629`；`taskListPage/query.ts:69, 389, 662`；`filters.ts:243`；`taskLifecycleWsProjection.ts:20-23` | 变 null |
| 记忆 workflow 作用域 | 注入 `memoryInjectionReadStore.ts:51-68` → `injection/injectMemory.ts:195-198`；蒸馏 `memoryDistillWorkStore.ts:43-75` → `distill/schedule.ts:368`；作用域按资源行解析（`memoryCatalogOperations.ts:244-262`） | 同类任务共享的「workflow 作用域」记忆无法解析资源（变为不可见 / 不可管理） |
| 闭包冻结源 id | `taskRouteLaunchOperations.ts:742-747`；调用时 v2 闭包按 `(tasks.workflow_id, node.id)` 取 `nodeMechanics.ts:1296-1299`，且经松散转换 `task as unknown as { workflowId? }` 读取（`nodeMechanics.ts:1274-1281`） | 若改换 id 或调度器任务对象不再带 `workflowId`，v2 查找静默回落到名称键并以 `workflow-call-ref-missing` 失败，编译器发现不了 |
| 启动 intent 身份 | `requestHash` / `payloadJson {v:1, workflowId}`：`taskRouteLaunchOperations.ts:953-963` | 只写不读（后台枚举未发现解码或重算者），不构成连续性约束 |
| 子任务锚行存在性 | `childExecutionLaunchOperations.ts:452-466` | call-workgroup 子任务启动失败 |
| 线上合同 | `TaskSchema.workflowId: z.string()`（`shared/schemas/task.ts:444`）；`ReviewSummary.workflowId/workflowName` 必填（`shared/schemas/review.ts:548-549`）；`StartTaskSchema.workflowId.min(1)`（`shared/schemas/task.ts:741`）；目录主体标签 `taskExecutionCatalogSources.ts:41-52` | 后端 `.parse` 失败或空串 |
| 前端 | `frontend/components/TaskSubjectLink.tsx:66-139`：workflow 种类链接 `/workflows/$id`（数字员工任务属此类，今天链接到宿主空定义页）；code-round 种类渲染无链接文本；首页行 `components/home/task-row.tsx:48`、评审列表 `routes/reviews.tsx:89-167` 显示 `workflowName` | 显示与链接变化 |

### 1.2 方案

| 方案 | 内容 | 功能 / API / 前端 | 迁移 / 测试 |
| --- | --- | --- | --- |
| A 保留宿主行 | 现状 | 不满足 D1 / AC-2 | — |
| **B 主体模型 + 边界常量投影** | `subject_kind` 五值；领域常量映射 `definitionAnchorId()`；所有隐性依赖改读主体；线上字段由投影产出 | 线上与前端零改动；数字员工任务的主体链接目标从「宿主空定义页」变为「工作流不存在」页（与已删工作流任务同形） | 转换器删除 4 类占位行（证据）；任务主体按判别规则转换；18+6+2+1 个钉住测试改指 |
| C 主体模型 + 线上改形 | `workflowId` 可空、新增 `subject` 对象，`workflowName` 显示真实主体 | 前端约 10 文件、shared 合同同步改 | 超出 RFC-395「兼容由边界投影承担」的范围 |

### 1.3 推荐：B

理由：G3「功能保留、API 兼容由边界投影承担」；D1 只要求「停止创建 / 查询宿主数据行」，不要求改线上合同。已冻结的调用闭包键与记忆作用域键都以宿主 id 持久化——保持常量值即保持这些持久化身份连续，不需要改写历史载荷（与 §2 的「身份键保值」原则一致）。常量只是**执行定义命名空间**，不写入任何 catalog 表、不建 FK。

要点：

1. `subject_kind ∈ {workflow, agent, workgroup, digital-employee, code-round}`。判别规则（转换器与新写入一致）：`code_round_id` 非空 → code-round；`workgroup_id` 非空 → workgroup；`source_agent_name` 非空 → agent；`workflow_id = DIGEMPHOST0` → digital-employee；否则 workflow。
2. `source_id`：workflow → 工作流 id；agent → agent id（RFC-175 之前的历史行可空，保留 `source_name`）；workgroup → 工作组 id；code-round → code round id（**从 `task_launch_contexts` 移入**，单一权威）；digital-employee → NULL（主体由启动来源 `digital_employee_round_id` 标识，避免同值双写）。
3. `definitionAnchorId(subject)`（`modules/task-execution/domain/taskSubject.ts`）：workflow → `source_id`；其余 → 对应常量。只用于：线上 `workflowId`、闭包冻结源与调用取闭包、记忆 workflow 作用域键；启动 intent 的 `requestHash/payloadJson` 沿用同一值只为保持同形。`runCallWorkflowNode` 改为显式读取 `definitionAnchorId`，删除 `as unknown as { workflowId? }` 松散转换，并加「workgroup 宿主任务内 call 节点按 v2 闭包取到定义」的用例。
4. 线上 `workflowName`：workflow → 实时 `workflows.name`（已删为 null）；其余 → 常量宿主名（与宿主行存在时 join 的结果一致）。`workflowVersion` 投影冻结的 `source_revision`（宿主为 1）。
5. `definition_origin ∈ {authored, platform}`（启动时冻结）：宿主合成定义与内建工作流为 `platform`；读时排版条件由 `workflows.builtin` 改为 `definition_origin = 'platform'`（`layoutBuiltinWorkflowSnapshot` 对已规范化的快照是同一结果，新行写时已规范化）。
6. 手动执行 / 同步守卫：digital-employee、轮次引擎工作组、`definition_origin='platform'` 的 workflow → 403 `builtin-readonly`（同今天错误码）；agent、code-round 放行（同今天）；authored workflow 走原有的工作流启动路径。
7. 评审子系统不再 join `workflows`，改用 task-execution 公开查询 `taskSubjectProjection(taskIds)` 取 `{workflowId, workflowName}`。今天「authored 工作流被删后其评审从列表消失 / 详情 404」的行为原样保留（`workflowName` 为 null 时同样跳过），列入另立修复候选，不在本 RFC 改变。
8. 记忆：workflow 作用域键 = `definitionAnchorId`；记忆作用域的资源解析对 4 个常量返回「内建公共 workflow 作用域」结果（与宿主内建行今天的可见 / 管理结果一致）。见 Q1。
9. 子任务锚行检查：call-workgroup 不再要求 catalog 行；call-workflow 维持「被调用工作流须存在」的今日行为。
10. 内部启动类型按主体分型：非 workflow 臂不再构造带宿主 id 的 `StartTask`；HTTP `StartTaskSchema` 不变（只服务 workflow 启动）。

### 1.4 设计文档修改

**design.md §3.1 表中 `task_definitions` 行替换为：**

> | `task_definitions` | PK/FK `task_id`；`subject_kind`、`source_id`、`source_name`、`source_revision`、`definition_origin`、`engine_kind`、`definition_revision`、冻结执行定义、资源闭包、inputs、预算 | 正常任务恰好一个定义。`subject_kind ∈ {workflow, agent, workgroup, digital-employee, code-round}`；`source_id` 不 FK 到可变资源；digital-employee 的 `source_id` 为 NULL（由 `task_launch_contexts.digital_employee_round_id` 标识）；`definition_origin ∈ {authored, platform}` 启动时冻结；定义可在生命周期 CAS 内修订（见 §3.3） |

**design.md §3.1 表后第二段（「Agent / Workgroup 允许由引擎编译出内部图…」）替换为：**

> Agent / Workgroup / 数字员工 / code-round 允许由引擎编译出内部图，它是执行定义，不是 resource-catalog 的隐藏 Workflow。停止创建、查询四个宿主数据行（`00000000000000AGENTHOST00`、`00000000000000WORKGROUP00`、`00000000000000DIGEMPHOST0`、`00000000000000CODEROUND00`）。
>
> `definitionAnchorId(subject)`（task-execution domain）为非 workflow 主体返回上述常量、为 workflow 主体返回 `source_id`。它是执行定义命名空间，只用于：线上 `Task.workflowId` 与 `ReviewSummary.workflowId` 投影、调用闭包的冻结源与取用键、记忆 workflow 作用域键（启动 intent 的请求哈希与载荷沿用同值）。它不写入任何 catalog 表，不建 FK，不得被解析为工作流行。线上 `workflowName` 对非 workflow 主体投影常量宿主名，对 workflow 主体投影实时名称（已删为 null）。读时排版由冻结的 `definition_origin='platform'` 决定，不再读 `workflows.builtin`。手动执行与同步守卫按主体判定，错误码与今天一致。

**design.md §3.2 表修改：** `task_definitions` 行追加「`code_round_id`（subject=code-round 时成为 `source_id`）」；`task_launch_contexts` 行删除 `code_round_id`。

**design.md §10 D1 行替换为：**

> | D1 | 四个宿主 workflow 的播种（`ensureWorkgroupHostWorkflow`、Agent `ensureHostWorkflow`、`ensureDigitalEmployeeHostWorkflow`）、三个 `ensureHostWorkflow` 端口方法、六处重复常量；评审 / 手动执行 / 读时排版 / `workflowName` / 记忆作用域对宿主行的 join 或存在性依赖；子任务锚行检查对宿主行的要求 | 五类主体都能启动与恢复；评审列表与详情可见；画布排版不变；记忆注入与蒸馏结果不变；已冻结调用闭包连续可取；宿主节点 id 保持线上冻结值 |

**migration.md §4.1 追加第 5～7 条：**

> 5. 主体按固定判别顺序转换：`code_round_id` → code-round；`workgroup_id` → workgroup；非空 `source_agent_name` → agent；`workflow_id = 00000000000000DIGEMPHOST0` → digital-employee；其余 → workflow。`workflow_id` 为宿主常量但判别字段不一致的行（例如宿主为 Agent 而 `source_agent_name` 为空）记逐行证据；可执行任务阻塞。
> 6. `workflows` 中 id 属四个常量、`builtin = 1` 且定义为空骨架的行判为系统占位并删除，删除前的原行进入证据包；同 id 而定义非空骨架的行阻塞。对应 `resource_grants`、依赖索引若存在，随同处置并记证据。
> 7. `memories` 中 `scope_type = 'workflow'` 且 `scope_id` 为常量的行原样保留（键语义改由领域常量提供，见 design §3.1）。

**table-mapping.md §2 `workflows` 行「目标与理由」末尾追加：** 「转换时删除四个宿主占位行（证据入包），目标库不再存在宿主行。」

**plan.md §3「Task 主体」行追加：**
- 正向：「五类主体（含数字员工两种实现、历史 code-round）启动 / 恢复 / 详情 / 评审列表；切换前冻结的 v2 调用闭包在目标上仍按边键取到定义（含 workgroup 宿主任务内的 call 节点）；读时排版对 platform 定义生效、对 authored 不生效」。
- 反例：「任何代码路径插入或查询四个宿主 id 的 `workflows` 行；`workflowId` 投影为空串；数字员工任务被判为 agent / workgroup」。

### 1.5 用户决定

- **Q1**（见 §0.2）：推荐保留共享记忆作用域。
- **Q2**（可选）：推荐不改显示。

---

## 2. 旧行形状写进持久化 JSON（§6.4-2）

### 2.1 事实（全量枚举 + 关键点复核）

**先更正 plan §6.4-2 的风险判断**：人工门续跑载荷 `HumanGateContinuationPayload`（`task_execution_intents.payload_json`，`modules/task-execution/domain/humanGateContinuation.ts:82-92`）中的 `expectedNodeProjection` 由决定事务**在当下**从行算出（`collaboration/infrastructure/review.ts:3883`、`clarifyDecision.ts:330`、`taskQuestionDispatch.ts:1487`），并在同一事务里重算比较（`task-execution/infrastructure/taskDecisionParticipant.ts:67-103`）；提交后摘要不再被重算，续跑只用 `gate.kind`、lineage 与 `planDigest`（`gateContinuationEffectPersistence.ts:58, 92`）。因此「切换前等待人工、切换后才决定」的任务，摘要在目标库上算、在目标库上比，**不会**被围栏拒绝。

真正的风险分五类：

| 类 | 载荷（存放位置） | 嵌入 / 派生的旧字段 | 运行时怎么用 |
| --- | --- | --- | --- |
| R1 在途回放、会回插被重塑表 | `collaboration_gate_operations.manifest_json` 的 clarify-open（`collaboration/domain/clarifyGateOpen.ts:7-80`，摘要 `:271-306`） | `clarify_rounds` 整行（4 个答案列须为 null）；node_runs 的 id / parent / container / shard / iteration / rerun_cause；源快照摘要进幂等键（`clarify/service.ts:344-361, 382`） | park 时校验 `sha256(manifest_json)`（`humanGateOpenParticipant.ts:636-645`），解码时重算节点投影摘要（`clarifyGateOpen.ts:300-306`），`insert(clarifyRounds).values(manifest.round)` 原样回插（`humanGateOpenParticipant.ts:392`），按投影铸行或 CAS 复用行 |
| R1 | 同列 review-open（`collaboration/domain/reviewGateOpen.ts:7-62`，摘要 `:198-212`） | node_runs 的 iteration / review_iteration / container / started_at 与 `consumed_upstream_runs_json`（当前与前次，原字符串）；doc_versions 整行 | 重启后以重算清单再 begin，哈希须等于已存 `request_hash`（`humanGateOperationJournal.ts:356-362`）；park 时**逐字节**比较复用行的 consumed JSON（`humanGateOpenParticipant.ts:171-184`）并回写、插入 doc_versions |
| R1 | 仓库 / 工作区准备回执：`sc_preparation_operations.receipt_json / diagnostics_json`、`task_workspace_preparations.artifact_json`、`hosted_workspace_commands.request_json` | `MaterializedSpace`（`source-control/application/workspaceMaterialization.ts:18-76`）：task 的 space_kind / worktree_path / branch / base_commit 与 task_repos 全形状（含 `repo_index`、`worktree_dir_name`） | 接纳时未经校验强转（`source-control/composition/repositoryPreparation.ts:281-299`），写成 `tasks` + `task_repos` 行（`taskRouteWorkspaceParticipant.ts:86-110` → `repoInsertRows`；延后回填 `taskExecutionEffectPersistence.ts:124-158`） |
| R2 由旧字段派生、跨行比较的身份 | effect 账本 `request_hash / operation_key / operation_family_key / slot_path_json / slot_path_digest`（`localEffectObserver.ts:99-153`、`processEffectObserver.ts:55-103`、`taskExecutionEffectPersistence.ts:214-273`）；lineage 记录（`:753-818`、`effectQuiescence.ts:280-346`） | `continuation_slot_key`、`lineage_slot_path_json`（回落 `${nodeId}:${iteration}:${shard}:${retry}` + workflow_version）、pre-snapshot map、`worktree_dir_name` 与 worktree_path 摘要、iso base、forced paths、分支 | 同代重开时 CAS 比较（`taskExecutionEffectPersistence.ts:384-397`）；同代摘要相等（`:767-774`、`effectQuiescence.ts:302-308`）；前缀匹配（`taskContinuationAdmission.ts:247-258`） |
| R2 | `node_runs.continuation_slot_key / lineage_slot_path_json` 及子任务、intent 中的副本（`buildNodeRunMintRecord.ts:13-21, 156-180`；`childExecutionLaunchOperations.ts:478-491`）；commit 行 node id `__commit_push__:<agent>:<worktreeDirName>`（`services/scheduler.ts:179-180`）；进程 spawn 回执 `{v:1,pid,spawnBinaryPath,launchNonce}`（`taskExecutionEffectPersistence.ts:935-941`）；fence 键 `workspace:sha256(worktreePath)`（`isolatedAgentRun.ts:114-116`、`services/nodeRollback.ts:230, 290`） | node_id / iteration / shard_key / workflow_version；`worktree_dir_name`；pid / binary / nonce；worktree 路径 | 重启后 spawn 回执须与行相等才判 applied（`effectQuiescence.ts:133-170`）；fence 键须与实时计算相等 |
| R3 自含载荷 | 评审决定清单中的 `ValidatedWorkspaceRollbackPlan`（`collaboration/domain/workspaceRollbackPlan.ts:5-86`）；澄清决定清单（`domain/clarifyDecision.ts:10-16`）；人工门续跑载荷 v1；删除清理计划 v1/v2（`taskDeleteRecovery.ts:41-110`）；调用闭包 v1/v2（`legacyCallClosure.ts:112-200`）；`wrapper_progress_json`（`domain/wrapperProgress.ts:42-118`，键为 mount_path）；`node_run_outputs.archive_json` v1（`application/portArtifacts.ts:57-105`，路径前缀为 worktreeDirName）；`commit_push_json`（只展示） | 路径、快照、答案等**值** | 重启后按自身内容执行（回滚计划由 `services/humanGateContinuationEffects.ts:37-54` 解码，要求 `plan.digest` 等于 effect 的 `request_hash`）；不与被重塑表的行形状比较 |
| R4 对外协议 | `hosted_execution_bindings.request_json` 的 `HostedAgentContext`（`version: 1`、`.strict()`，`crewstation/agentContext.ts:5-56`） | node_runs 的 id / nodeId / iteration / retryIndex / containerRunId / parentNodeRunId / shardKey / envelopeNonce / preSnapshot | 领养时严格重解析，并与重建的 JSON 逐字节比较（`crewstation/executionStore.ts:64-91, 175-185`） |
| R5 归档与备份 | 任务归档 `<archiveDir>/<root>/db/<table>.jsonl` + manifest（`taskArchiveContentCoordinator.ts`，`ARCHIVE_SCHEMA_VERSION = 2`）；逻辑备份工件 | 四张表原始整行；全部列 | 归档在应用内无读者；逻辑恢复要求 `schemaDigest` 等于当前合同（`logicalDatabaseRestore.ts:184, 216, 261, 498`） |

**不构成问题**（只带 id、只写或只展示）：任务与协作 committed 事件（`task.created.v1` 不带 TaskSummary）、启动 intent 载荷与哈希、resume / retry 载荷、问题派发与手动问题清单、恢复与审计快照、`memory_distill_jobs.scope_resolved_json`、`workgroup_task_state.dw_state_json`、`scheduled_tasks.launch_payload`、webhook 终止绑定（只作为对 `tasks.source_termination_*` 的谓词）。

**实现陷阱**：drizzle 0.45.2 只按表自身的列构造 INSERT（`node_modules/drizzle-orm/sqlite-core/dialect.js:346-363`），`insert(clarifyRounds).values(manifest.round)`、`update(tasks).set(projection.task)` 这类把非字面量对象直接写入的地方，拆表后**静默丢掉**已移走的字段，类型检查也不报错。

### 2.2 方案

| 方案 | 内容 | 后果 |
| --- | --- | --- |
| A 全部保留 v1 解码器 + 适配新表 | 运行时长期双形状 | 违背「无永久回退」；回插路径逐个改造 |
| B 迁移时统一重编码为 v2 并重算钉住摘要 | 改写 manifest、回滚计划、effect 哈希 | 摘要互相引用（manifest ↔ request_hash ↔ effect），对外协议也被改，幂等身份断裂 |
| **C 按类分治** | R1 冻结前收敛；R2 按值搬运；R3 / R4 原字节 + 原 schema；R5 升版本 | 目标运行时只处理新形状，旧解码器只在迁移 / 历史模块 |

### 2.3 推荐：C

1. **R1 冻结前收敛**：quiesce 阶段由源上的既有恢复流程把 preparing / prepared 的开门操作、未接纳的准备操作、在途托管工作区命令推进到终态（committed / aborted / stopped）；转换器预检发现剩余项即阻塞。切换后新操作写 v2 清单（clarify round 投影为新 round 形状 + 空的答案 / 草稿集合；review 开门的 consumed 为消费边列表），v1 解码器只在迁移 / 历史模块，已提交的 v1 清单原字节保留。
2. **R2 按值搬运**：所有派生身份与幂等键原值进入目标，不重算；新写入沿用同一公式，公式输入中的 `worktree_dir_name` 以等值的 `mount_path` 代替（转换器断言二者逐行相等）。
3. **R3 自含载荷**：原字节、原 schema、原解码器；其中引用的路径与快照值在目标库中逐字节可得（`workspace_root_ref`、挂载路径、checkpoint 值）。
4. **R4 对外协议**：`HostedAgentContext` 保持 v1 线格式，由目标表重建时与存储值逐字节相等。
5. **R5**：任务归档格式升到 v3（列入新表）；逻辑备份与旧 epoch 备份经转换器恢复（M6）。
6. **结构守卫**：被重塑表的 insert / update 只接受对象字面量或精确类型的构造器，禁止直接传入外部载荷对象。

### 2.4 设计文档修改

**migration.md 新增 §4.6「持久化载荷」：**

> 1. 在途回放载荷（`collaboration_gate_operations` 中 preparing / prepared 的 clarify-open、review-open 清单；未被任务接纳的仓库 / 工作区准备回执；在途托管工作区命令）在冻结前由源上的既有恢复流程推进到终态；预检发现剩余项即阻塞。目标运行时只写、只读 v2 形状；v1 解码器只在迁移 / 历史模块；已提交的 v1 清单原字节保留。
> 2. 由旧字段派生的身份与幂等键（effect 的 `request_hash / operation_key / operation_family_key / slot_path_json / slot_path_digest`、lineage 记录、`continuation_slot_key`、`lineage_slot_path_json`、commit 行 node id、进程 spawn 回执、`workspace:` fence 键）按值搬运，不重算。新写入沿用同一公式，`worktree_dir_name` 输入以等值的 `mount_path` 代替；转换器断言二者逐行相等。
> 3. 自含载荷（人工门续跑载荷 v1、评审决定的工作区回滚计划、澄清决定清单、删除清理计划 v1/v2、调用闭包 v1/v2、wrapper 进度、`archive_json`、`commit_push_json`）原字节保留，运行时解码器不变；其中引用的路径与快照值在目标库中逐字节可得。
> 4. 对外协议载荷（托管执行的 `HostedAgentContext` v1）保持线格式；由目标表重建时须与存储值逐字节相等。
> 5. 任务归档格式升到 v3；逻辑备份与旧 epoch 备份走 §2 支持矩阵的转换路径。

**design.md §7 末尾（或新增 §7.3「载荷版本」）追加：**

> 持久化载荷的 schema 版本独立于表结构。改动表结构不得改写既有载荷字节；需要回插被重塑表的在途载荷在切换前收敛，切换后只产生新版本。被重塑表的写入只接受对象字面量或精确类型构造器（drizzle 对非字面量对象中多余字段静默丢弃）。

**design.md §10 新增 D13 行：**

> | D13 | 正常运行时对被重塑表的 v1 在途回放载荷（clarify-open / review-open 清单、强转为 `MaterializedSpace` 的准备回执）的解码与回插；把非字面量载荷对象直接传给被重塑表的 insert / update | 冻结前收敛 + 新操作写 v2；已提交清单作为历史可读；结构守卫 |

**plan.md §6.4 第 2 条替换为：**

> 旧行形状写进持久化 JSON：人工门续跑围栏在决定事务内计算与比较，提交后不再重算，不是切换风险。需处理的是：会回插被重塑表的在途清单与准备回执（冻结前收敛、目标只处理 v2）、由旧字段派生的身份与幂等键（按值搬运）、自含载荷与托管协议（原字节）、归档版本（升 v3）。规则见 migration §4.6。

**plan.md §3 新增一行：**

> | 持久化载荷 | 切换前已决定、尚未驱动的续跑（含工作区回滚计划）在目标上执行；切换前等待人工、切换后决定；托管领养重建请求逐字节相等；同代 effect 重开 CAS 命中 | 预检放过 prepared 的开门清单；非字面量对象写入被重塑表静默丢列；派生键被重算 |

### 2.5 用户决定

否。

---

## 3. 「当前选中哪次运行」（§6.4-3）

### 3.1 事实

- **没有选中运行端口**：`modules/task-execution/application/ports/taskRunSelection.ts` 选的是运行族实现，与 `node_run_selections` 无关。所有执行端口（`NodeExecutionPersistence.list`、`WrapperRunPersistence`、`SchedulerCompletionPersistence` 等）返回原始行列表，选择留给调用方（r4-sub T6a §6）。
- **77 处选择计算**（T6a §3.A；61 处只服务新执行、6 处混用、8 处历史 / UI、1 处只服务迁移）+ 22 条 SQL 级选择 / 排序（§3.B）。共享比较器 `compareNodeRunMintOrder`（`shared/nodeRunOrder.ts:8-13`：seq、NULL 在前、ID 兜底）被直接调用 71 处；`services/freshness.ts` 的 picker 被调用 35 处；15 条 SQL 用 `ascNullsFirst/descNullsLast(seq)` + `id` 兜底，其中 2 条把 `desc(retryIndex)` 放在 seq 前（`services/task.ts:1306-1311`、`repositoryPreparationRetryCommand.ts:187-193`）。
- **至少 9 种槽位键、5 种排序**：节点 / 节点+迭代 / 节点+帧 / 节点+迭代+shard / +reviewIteration / 节点+shard / 帧+shard 集合 / 全任务…；seq+ID、startedAt 优先（`nodeMechanics.ts:1335`）、retryIndex 优先、最高迭代优先（`application/branchTrace.ts:57-60`）、running 优先（`workgroupRoomProjection.ts:149-162`）。
- **fanout shard 集合**：无 shard 的新行取代全部 shard（`domain/nodeRunSupersession.ts:45`）；shard 复用刻意跨 wrapper 代、值哈希 NULL 视为匹配、要求 `reusable.id === freshest.id`（`composition/wrapperMechanics.ts:547-645`、`services/freshness.ts:316-333`）；聚合重放要求比**每个**参与 shard 都新（`wrapperMechanics.ts:1198-1204`）。纯函数与 SQL 两份 supersession（`domain/nodeRunSupersession.ts:37-58`、`infrastructure/nodeRunSupersession.ts:42-87`，后者 `:55-57` 仍有 ID 分支）。
- **容器**：wrapper 行以顶层铸造，容器角色只由子行的 `container_run_id` 隐含（`composition/wrapperRunLifecycle.ts:160-172`）；代复用 `findResumable` 用 `seq DESC NULLS LAST, id DESC LIMIT 1`（`infrastructure/wrapperRunPersistence.ts:16-45`）。
- **评审**：评审运行行在 reject / iterate 时**原地重置**——`review_iteration + 1` 且状态回 pending（`collaboration/infrastructure/review.ts:3561, 3860, 3870`），同时它是评审决策的乐观并发令牌（`review.ts:3127`）。
- **子任务续接**：call 前奏按 startedAt 排序后收养最新带 `childTaskId` 的行（`nodeMechanics.ts:1328-1400`）。
- **不含帧的新执行选择**：`nodeMechanics.ts:5335-5486`、`review.ts:509-518, 812-823, 4196-4212`、`taskQuestionDispatch.ts:2373-2395`、`schedulerCompletionPersistence.ts:26-43`、`memory/application/injection/injectMemory.ts:280-305`、`memoryInjectionReadStore.ts:110-130`、`clarify/queue.ts:136-158`。
- **跨上下文直读**：collaboration、memory 直接用 drizzle 查 `node_runs`；工作组轮次引擎经 `task-execution/public/commands.ts:150-195` 的行合同自己选择。
- **前端**：6 个不基于 seq 的「最新运行」选择器 + 约 12 处重算，依赖 node-runs 列表顺序 `startedAt NULLS FIRST, seq NULLS FIRST, id`（`taskRouteOperations.ts:946-951`）。

### 3.2 方案

| 方案 | 内容 | 后果 |
| --- | --- | --- |
| A 先建表再改 77 处 | 直接对 `node_run_selections` 改写 | 没有旧口径 oracle 对照，行为漂移只能靠零散测试发现；一次性改动面最大 |
| **B 先立端口再换实现** | 先定义领域槽位模型与排序合同、application 端口；第一实现是「oracle 适配器」（包装现有 picker、跑在现有 schema 上），77 处按组迁到端口；再写表实现，双实现对拍后 oracle 适配器移入迁移模块，只给转换器用 | 每处调用迁移都是行为保持的；对拍测试即 AC-3 证据；转换器天然得到 oracle |
| C 只把 seq 改非空、保留各自 picker | 改动最小 | 不满足 D4「各自 selected 判定」退出 |

### 3.3 推荐：B

**领域（`modules/task-execution/domain/runSelection/`，纯函数、无 provider）**

| 槽位种类 | 结构（版本化规范编码 `rs1`） | 「当前选中」含义 | 唯一写者（同事务） |
| --- | --- | --- | --- |
| `node` | `nodeId` + 帧 `(containerRunId \| null, iteration)` | 该帧该节点的当前顶层 attempt | 调度铸行与收养、retry、resume、sync、评审重跑、澄清重跑、修复 |
| `container` | wrapper `nodeId` + 帧 | 当前 wrapper 代行 | `WrapperRunLedgerPort.openGeneration / settle` |
| `shard` | 内部 `nodeId` + `iteration` + `shardKey`（与今天复用候选同键：**不含**容器代行 id，也不含外层帧，T6a §7-3） | 该 shard 当前选中运行，可来自更早 wrapper 代（跨代复用显式化） | fanout 派发（复用 / 原地重跑 / 新铸） |
| `aggregator` | 聚合 `nodeId` + `iteration`（子行、无 shard，与今天同键） | 当前聚合运行；其实际消费的 shard 运行记在 `node_run_inputs` | fanout 聚合 |
| `synthetic` | owner（task 或所属 attempt）+ 合成种类（repo-prep / commit-push / commit-session / merge-resolve / dw-gate / wg-gate…）+ 判别值 | 该合成槽当前运行 | 对应 runner |
| `workgroup-host` | host `nodeId` + `shardKey`（assignment / `msg:*` / batch） | 当前 host 运行；`wg_round` 作为属性维度保留 | 工作组轮次引擎经 task-execution participant |

- **排序合同**：任务内唯一全序是 `seq`（非空、唯一，历史可为负）。`retry_index` 是槽内 attempt 编号，不是排序键。业务选择不得按 id / startedAt / retryIndex 排序。
- **选择变更规则**（领域函数，由 owner 在同事务调用）：新 attempt 成为槽位选中（revision + 1）；选中一个无 shard 的 `node` 运行时，同节点、同迭代的全部 `shard` 选中一并清空（保留「无 shard 新行取代全部 shard」）；父容器被取代时其子槽位随之失效（保留「直接子行随父」）。被取代 = 不再是任何槽位的选中，不另存标记。
- **聚合可重放判据**：聚合运行在 `node_run_inputs` 中记录的 shard 运行集合等于当前各 shard 选中集合。等价于今天「比每个参与 shard 都新」；双实现对拍覆盖。
- **子任务续接**：call 节点槽位的选中运行携带 `child_task_id`，续接只读选中运行；收养在子任务启动事务内由 owner 写入。

**端口（`modules/task-execution/application/ports/runSelection.ts`）**

```ts
interface RunSelectionReader {
  current(taskId: string, slot: RunSlot): Promise<SelectedRun | null>
  currentInFrame(taskId: string, frame: Frame): Promise<ReadonlyMap<string, SelectedRun>> // frontier
  shardSet(taskId: string, wrapper: WrapperSlotRef): Promise<ShardSetView> // shards + aggregator + aggregator 输入
  slotHistory(taskId: string, slot: RunSlot, filter?: HistoryFilter): Promise<readonly RunRef[]> // seq 序
  familyHistory(taskId: string, family: FamilyRef, filter?: HistoryFilter): Promise<readonly RunRef[]> // 显式跨帧
  consumed(runId: string): Promise<readonly ConsumedEdge[]>
}
interface RunSelectionParticipantInTx<Tx> {
  apply(tx: Tx, changes: readonly SelectionChange[]): Promise<readonly SelectionRevision[]> // CAS on revision
}
```

shard / aggregator 槽位刻意沿用今天不含外层帧的键：若改为含帧，fanout 位于嵌套 loop 内时复用结果会变化，属于行为变更，只登记进口径差异账本。

读者经 `task-execution/public/queries.ts` 暴露、participant 经 `public/participants.ts` 暴露，替换 collaboration / memory / resource-catalog 对 `node_runs` 的直读。`familyHistory` 用于今天「不含帧」的选择口径，**原样保留**这些口径（G3），不在 RFC-395 内改为含帧；它们登记进「选择口径差异账本」，留待后续功能评审。

**持久化**：`node_runs.slot_key`（铸行时由适配器计算，不可变）+ 索引 `(task_id, slot_key, seq)`；`node_run_selections` 主键改为 `(task_id, slot_key)`，列 `selected_run_id, revision, generation_seq, cause, selected_at`。理由：热路径（每个调度 tick 的 frontier）要的是「每槽位当前选中」，按 `(task, generation, slot)` 存需要「每槽位取最大代」的分组查询；attempt 历史已由 `node_runs` 按槽位与 seq 给出，不需要每代一份选择行。

**77 处迁移分组**（编号为 T6a §3.A 的 #1-#77 与 §3.B 的 S1-S22；每个编号恰好落在一组）：

| 组 | 站点 | 改读 |
| --- | --- | --- |
| G1 槽位 / 帧内当前选中（25） | #3-5, 7, 8（按调用方）, 11, 15, 16, 19, 21, 23-25, 39-42, 44, 45, 47-49, 52, 54, 55；S2, S3, S8, S13 | `current` / `currentInFrame`；「最近已结算」用 `slotHistory` + 状态类过滤 |
| G2 fanout（8） | #6, 31-37 | `shardSet` + `consumed` |
| G3 选择变更写者（5） | #12, 13, 17, 59, 61；S16 | owner 调 `apply`；读者不再计算 supersession（#59、#61 的读取部分走 `familyHistory`） |
| G4 槽位 / 族历史，含今天不含帧的口径（15） | #10, 26-29, 57, 60, 62-64, 66-69, 76；S14, S21 | `slotHistory` / `familyHistory`，各自保持是否含帧 |
| G5 工作组（4） | #70-73；S11, S12 | `workgroup-host` 槽位 + `wg_round` 属性，经 public query |
| G6 合成行与容器成员（5） | #38, 43, 50, 51, 77；S6, S7 | `synthetic` 槽位；显式 role / container 列（与 D5 一起） |
| G7 只排序（6） | #1, 2, 46, 56, 74, 75；S1, S4, S9, S10, S15 | 纯 `seq` 序（DTO 保持 `startedAt NULLS FIRST, seq`），无选择 |
| G8 attempt 编号（2） | #14, 53 及 T6a §3.C 的其余分配规则 | 保留各规则的取值（线上 `retryIndex` 语义不变），收拢为一个领域函数 |
| G9 只服务迁移（1） | #18；S17-S20 | 移入转换器 |
| G10 消费新鲜度（4） | #9, 20, 22, 58 | `consumed` 对比 `current` |
| G11 子任务续接（1） | #30 | 读 call 槽位选中运行的 `child_task_id`；收养写入在子任务启动事务内 |
| G12 不涉及 `node_runs` 选择（1） | #65（按 `clarify_rounds` 创建时间） | 保持，归 collaboration |
| 删除 | S5（随 `getTaskNodeRuns` 删除，§13）；S22 拆入 G4 / G8 | — |

前端 6 个本地选择器在 seq 唯一后结果确定，RFC-395 不改；改为服务端给出「每节点选中运行」作为后续可选优化。

### 3.4 设计文档修改

**design.md §5.1 表 `node_runs` 行「键与内容」追加：** 「`slot_key`（版本化槽位编码，铸行时确定，不可变）、`envelope_nonce`（见 §5.6）」。

**design.md §5.1 表 `node_run_selections` 行替换为：**

> | `node_run_selections` | PK `(task_id, slot_key)`；`selected_run_id, revision, generation_seq, cause, selected_at` | 每槽位一行「当前选中」；所选 run 属于同任务且其 `slot_key` 等于本行；变更只经 `RunSelectionParticipantInTx.apply` 以 revision CAS 在 owner 事务内提交；attempt 历史由 `node_runs(task_id, slot_key, seq)` 给出，不另存选择历史 |

**design.md §5.2 第三段（「selected-run 变更由现有操作 owner…」）替换为：**

> selected-run 变更由现有操作 owner 同事务提交。槽位种类为 `node / container / shard / aggregator / synthetic / workgroup-host`（§5.4）。规则保留今天的结构语义：选中无 shard 的 node 运行时清空同节点、同迭代的 shard 选中；父容器被取代时子槽位失效；shard 选中可来自更早 wrapper 代；聚合可重放当且仅当其 `node_run_inputs` 记录的 shard 运行集合等于当前 shard 选中集合；call 节点续接只读选中运行的 `child_task_id`。任务内唯一排序是 seq；`retry_index` 是 attempt 编号。迁移器用现有 picker 组成的 oracle 适配器一次性写出选择；正常读者全部经 `RunSelectionReader` 消费，不再各自计算 SQL / JSON / ID 顺序。今天不含帧的选择口径由 `familyHistory` 原样保留并登记口径差异账本，不在本 RFC 改变。

**design.md §5 新增 §5.4「选中运行端口」**：粘贴 §3.3 的槽位表、端口签名与持久化段落。

**design.md §10 D4 行「必须删除…」列追加：** 「`compareNodeRunMintOrder` 的 NULL / ID 兜底与 `nodeRunOrderAnchor`；`services/freshness.ts` picker 与 `resolveSchedulerRunRow` / `resumeRollbackTargets` / `dagFrontier` / `wrapperMechanics` / collaboration / memory / 工作组中服务新执行的各自选择（T6a §3.A NX 组），只作为迁移 oracle 存在于迁移模块；supersession 的 SQL 孪生与 ID 分支」。

**plan.md §6.2 表 II 行「内容」追加：** 「T6 的开发顺序固定为：先立选择端口与 oracle 适配器并迁移全部调用点，再写表实现与双实现对拍，最后把 oracle 适配器移入迁移模块」。

**plan.md §3「NodeRun」行追加：**
- 正向：「每种槽位（node / container / shard / aggregator / synthetic / workgroup-host）的 oracle 与表实现在随机任务历史上逐槽位相等（参照 `tests/rfc369-node-run-supersession.test.ts:192` 的对拍形式）；跨 wrapper 代 shard 复用；聚合输入集合判据与旧『比每个 shard 都新』判据等价；评审原地重置后选中不变；call 续接收养」。
- 反例：「业务模块直接查询 `node_runs` 做选择（结构守卫）；按 id / startedAt 排序做业务选择；选择写入不在 owner 事务内」。

### 3.5 用户决定

否。

---

## 4. 拆表后的多表 CAS（§6.4-4）

### 4.1 事实

- **任务生命周期 CAS** `modules/task-execution/infrastructure/taskLifecycleWriteSequence.ts:73-118`：一条 UPDATE 同时写 `status / running_*`、可选 `extra`（含定义列 `workflow_snapshot / workflow_version / ref_closure_json / workgroup_config_json` 与 `source_termination_fence / effect_rev`，`:20-34`）、prune 认领（`:87`），并以 `status = from`、`lifecycle_event_revision`、`worktree_path = expected`（`:97-99`）、复活谓词（`deleted_at / source_termination_fence / workspace_pruning_at / workspace_pruned_at IS NULL`，`:100-107`）、prune 谓词（`:108-114`）为 WHERE 守卫。另有 7 个写者重复其部分逻辑（T4b §4）。
- **prune 认领 / 自愈写者**在 source-control 直接 `UPDATE tasks`：`modules/source-control/infrastructure/workspaceMaintenanceSqlStore.ts:231-261`（谓词含 `status`、`deleted_at`、`worktree_path`、`lifecycle_event_revision`）。
- **NodeRun 状态 CAS**：`modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts:81-133` 先读当前行（join `tasks.source_termination_fence`，`:60-70`），再 `UPDATE node_runs SET status, ...extra WHERE id AND status = from`；`extra` 白名单 `platform/persistence/nodeRunLifecycleCore.ts:55-78` 混入 tokens、`superseded_by_review`、`rolled_back`、`pre_snapshot`、`consumed_upstream_runs_json`、session id、pid、`review_iteration`。
- **merge-state CAS**：`infrastructure/mergeStateLifecyclePersistence.ts:37-80` 唯一写手，`.set({ mergeState: to, ...extra })`（`:65`），extra = iso 路径、wrapper 进度、iso 快照列（`application/ports/mergeStateLifecyclePersistence.ts:9-18`）；被取代时收成 abandoned **不带** extra（`:63-65`）；拒绝在外层事务内执行（`:32-36`）。
- **会话租约 CAS** 谓词 `status = 'running' AND opencode_session_id IS NULL`，在 serializable 事务中执行（`runtimeSessionLeaseOperations.ts:62-113` 等，T6b §2.2）。
- 平台已有「READ COMMITTED + 聚合根 `FOR UPDATE`」原语：`platform/persistence/capabilities.ts:118-129`（PG `select … for update`，`:482-484`；SQLite 在 `BEGIN IMMEDIATE` 下为 no-op，`:367-369`），`databaseTransaction.ts:138-145` 注释记录了它优于 SERIALIZABLE 的实测。

### 4.2 方案

| 方案 | 内容 | 后果 |
| --- | --- | --- |
| A 照 design 原拆分 + 每处改多表 CAS | prune、根路径、fence 拆到 `task_workspaces` / `task_source_termination_states`，所有守卫改跨表 | PG READ COMMITTED 下跨表谓词没有 EvalPlanQual 重检，必须全部改成锁根；source-control 写者需跨上下文锁 task-execution 的行；8 个生命周期写者全部改造 |
| **B 按写入耦合重新划线 + 锁根协议兜底** | 与生命周期 CAS 同句读写的可变列留在 `tasks`（工作区根引用、prune 三列、终止 fence / effect_rev）；只把冻结事实拆出；仍需跨表的少数写（定义修订）走「先锁聚合根」协议 | 生命周期 CAS 保持单语句、单行；没有新的跨表谓词；符合 design §5.1 自己的「按写入频率、适用角色与冻结边界拆分」原则 |
| C 全部改 SERIALIZABLE | 跨表谓词由 SSI 兜底 | 仓库实测高冲突率（`databaseTransaction.ts:138-145`），否决 |

### 4.3 推荐：B

**Task 侧**

1. `tasks` 除 design §3.2 已列的生命周期列外，还保留与生命周期 CAS 同句读写的可变列：**`workspace_root_ref`**（原 `worktree_path`，NULL = 未绑定，见 §6）、**`workspace_pruning_at / workspace_prune_cause / workspace_pruned_at`**、**`source_termination_fence / source_termination_effect_rev`**、树结构列（§5）。
2. `task_source_termination_states` 不再单独成表：`source_termination_binding / launch_rev` 是启动时冻结事实（T4b §3），并入 `task_launch_contexts`（webhook MR 终止目标查询 `infrastructure/sourceTerminationTargets.ts:7-20` 按 binding + launch_rev 过滤、按 `invocation_depth` 排序，改为 join，`task_launch_contexts` 上建 `(source_termination_binding, source_termination_launch_rev)` 索引）；fence / effect_rev 留 `tasks`（它们只经两条路径以 `lifecycle_event_revision` 为键推进，`sourceTerminationTarget.ts:71-92, 264-288`）。
3. `task_workspaces` 只放冻结事实：`space_kind`、repo group 快照、git 身份、`auto_commit_push`、`working_branch`、`requested_source`、`task_branch`（§6）。唯一的后写是延后准备结算时重盖 `space_kind`（T4b §3），走第 4 条协议。
4. **聚合根写协议**：任何同时写 `tasks` 与 `task_definitions` / `task_workspaces` 的事务，第一步 `lockAggregateRoot(tasks, taskId)`，再读从属行、在领域函数里判定、写从属行，最后对 `tasks` 做带原谓词的 CAS。适用：`syncWorkflow`（`taskRouteOperations.ts:1902-1920`，定义修订 + 状态迁移）、动态工作流批准（`workgroupTaskRoomTaskParticipant.ts:246-283`，DAG 换入定义）、延后准备回填。这些写入与生命周期迁移合入单一 `TaskAggregateWriteProgram`（替换 `taskLifecycleWriteSequence` 与 7 个重复写者）。工作组房间运行中改配置（`workgroupTaskRoomTaskParticipant.ts:182-207`）按 design §3.1「运行中调整归运行表」改写 `workgroup_task_state` 的运行期配置（新增 `runtime_config_json + config_revision`，以 revision CAS），不修订 `task_definitions`；约 15 个读者按 T4a §7-2 的划分读「冻结配置」或「冻结 ⊕ 运行期配置」。
5. source-control 的 prune 认领 / 自愈改为调用 task-execution 的 `TaskWorkspaceRetentionParticipantInTx`（谓词不变、仍是对 `tasks` 的单行 CAS），消除跨上下文直写。
6. `lifecycle_event_revision` 语义不变：只由生命周期迁移推进，prune 认领不推进（同今天）。

**NodeRun 侧**

7. **根行 CAS 先行、从属表后写、同事务**：状态 CAS 仍是 `UPDATE node_runs … WHERE id AND status = from`；成功（返回 1 行）后再写 `node_run_results`（tokens、`superseded_by_review`、`rolled_back`）、`node_run_runtime_states`（session、pid）、`node_run_repo_checkpoints`、`node_run_inputs`；未命中则抛出并整体回滚（保证「CAS 未命中不留 tokens」）。从属表除自身 revision 外不承担 CAS 守卫。
8. **merge-state CAS 归运行态表**：`merge_state` 与 iso 根引用、`wrapper_progress_json` 同在 `node_run_runtime_states`（§9-a），CAS 与这两项伴随写仍是单行单语句；per-repo 快照随后在同事务写 `node_run_repo_checkpoints`；被取代收成 abandoned 时不写任何伴随项（保留 `:63-65` 语义）。
9. **跨表谓词**：会话租约（status + session）保持在 serializable 事务中执行（今天如此，PG 由 SSI 覆盖、SQLite 独占）；读取 fence 的 `currentRow` 读 `tasks`（fence 留在 `tasks`，join 不变）。
10. 结构守卫：从属表的 UPDATE 只允许出现在对应写协议文件内（沿用 rfc053 / rfc097 / rfc144 的白名单守卫形式）。

### 4.4 设计文档修改

**design.md §3.1 表：** `tasks` 行「不变量」替换为：

> 热生命周期与聚合树的唯一写入口。除生命周期列外，含与生命周期 CAS 同句读写的可变状态：`workspace_root_ref`（NULL = 未绑定）、`workspace_pruning_at / workspace_prune_cause / workspace_pruned_at`、`source_termination_fence / source_termination_effect_rev`，以及树结构列（§3.4）。不含工作流必填、主仓镜像或执行定义。

删除 `task_source_termination_states` 行；`task_launch_contexts` 行追加「`source_termination_binding / source_termination_launch_rev`（冻结）」；`task_workspaces` 行替换为：

> | `task_workspaces` | PK/FK `task_id`；`space_kind`、repo group 快照、git 身份、`auto_commit_push`、`working_branch`、`requested_source`、`task_branch` | 冻结的工作区来源与 Git 执行策略；`space_kind` 只在延后准备结算时按聚合根写协议重盖一次；内部工作区不伪装为外部仓库 |

**design.md 新增 §3.3「Task 聚合写协议」：**

> 只写 `tasks` 的生命周期迁移与 prune 认领是单行 CAS，谓词与今天相同。同时写 `tasks` 与 `task_definitions` / `task_workspaces` 的事务（同步工作流、动态工作流批准、延后准备结算）先调用 `lockAggregateRoot(tasks, taskId)`，再读从属行、由领域函数判定、写从属行、最后以原谓词 CAS `tasks`。全部生命周期写入收敛到 task-execution 的单一写程序；其他上下文（source-control 的 prune 认领与自愈）经 task-execution participant 写入，不直写 `tasks`。工作组房间运行中改配置写 `workgroup_task_state` 的运行期配置（revision CAS），`task_definitions` 只保存启动时冻结的工作组配置。

**design.md 新增 §5.5「NodeRun 写协议」：**

> 状态与 `review_iteration` 的 CAS 在 `node_runs` 上单行执行；`merge_state` 的 CAS 在 `node_run_runtime_states` 上单行执行，iso 根引用与 wrapper 进度为同行伴随列。CAS 命中后，同一事务再写 results / runtime_states / checkpoints / inputs；未命中整体回滚。被取代收为 abandoned 时不写伴随项。会话租约这类谓词跨 `node_runs.status` 与运行态的写入保持在 serializable 事务中。

**design.md §3.2 表：** `task_source_termination_states` 行改为「`task_launch_contexts`：`source_termination_binding, source_termination_launch_rev`；`tasks`：`source_termination_fence, source_termination_effect_rev`」；`task_workspaces` 行移出 `worktree_path, workspace_pruning_at, workspace_prune_cause, workspace_pruned_at, branch_started_at`（前四个进 `tasks`，`branch_started_at` 见 §5）。

**table-mapping.md §3「Task 分层」行**：目标表改为「`task_definitions`、`task_launch_contexts`、`task_workspaces`」。§2 `tasks` 行目标改为「`tasks + task_definitions + task_launch_contexts + task_workspaces + task_repository_mounts`」。

**table-mapping.md §2 `workgroup_task_state` 行「目标与理由」追加：** 「新增运行期配置 `runtime_config_json, config_revision`，承接 `tasks.workgroup_config_json` 中运行中可编辑的部分；`task_definitions` 只保存启动时不变的部分（mode、workgroup id / name、goal、leader）」。

**migration.md §4.1 追加：** 「`tasks.workgroup_config_json` 的当前值整体写入 `workgroup_task_state.runtime_config_json`（初始 revision 1）；其中运行中不可改的字段（mode、workgroup id / name、goal、leader）写入 `task_definitions`。被房间改过的成员等字段的原始启动值无从证明，不补造。」

**plan.md §3** 新增一行：

> | 聚合写协议 | 双 provider 并发：生命周期迁移 vs prune 认领 vs 复活；同步工作流 vs 取消；runner 结算 CAS vs 评审取代；merge-state CAS vs 取代收尾；会话租约竞争 | CAS 未命中却留下 tokens / 快照；从属表 UPDATE 出现在协议文件外；source-control 直写 `tasks` |

### 4.5 用户决定

否（与已批准 design 的偏离是表划分，不改变功能；需在 design 中记录理由）。

---

## 5. 子任务树删除（§6.4-5）

### 5.1 事实

- `tasks.parent_task_id` 自引用 FK `ON DELETE CASCADE`（`db/schema.ts:1322-1324`），两 provider 都有（不在 8 条仅 SQLite FK 之列）。
- 删除只删根：`services/taskDelete.ts:288-326`（递归 CTE 冻结受众后 `tx.delete(tasks).where(eq(tasks.id, taskId))`）；恢复路径同形 `modules/task-execution/infrastructure/taskDeleteRecovery.ts:240-250`；删除后沿父链重算 `branch_started_at`（`taskDelete.ts:327-` 起、`taskDeleteRecovery.ts:252-`）。
- `branch_started_at` 是「子树 `max(started_at)`」的物化值（RFC-311），供任务列表 keyset 排序，并作为终态维护的 `topologyRevision` 存入 `task_execution_maintenance_members`（T4b §4）。design §3.2 把它归入 `task_workspaces`——这是名称误读（branch 指任务树分支，不是 Git 分支）。
- 列表快路径按 `root_task_id` 分组、沿 `parent_task_id` 递归，4 个复合索引混合这些列（`db/schema.ts:1398-1435`）。

### 5.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 树结构列留在 `tasks`** | 级联语义、受众 CTE、列表索引全部不变 |
| B 移到 `task_launch_contexts` 并改为显式递归删除 | 删除与恢复路径重写；级联只删子任务的启动行，漏删即孤儿任务 |
| C 独立树边表 + 显式删除 | 同 B，且多一张表 |

### 5.3 推荐：A

树结构是聚合关系，不是启动来源事实。`tasks` 保留 `parent_task_id`（自引用 CASCADE）、`root_task_id`、`invocation_depth`、`branch_started_at`；`parent_node_run_id`、lineage、launch origin、触发上下文等启动事实进 `task_launch_contexts`。所有 Task 从属表 FK 到 `tasks(id) ON DELETE CASCADE`，删除根 → 级联删子任务 → 级联删各自从属行，与今天一致。

### 5.4 设计文档修改

**design.md 新增 §3.4「任务树」：**

> `tasks` 保留树结构列：`parent_task_id`（自引用 FK，`ON DELETE CASCADE`）、`root_task_id`、`invocation_depth`、`branch_started_at`（子树 `max(started_at)` 的物化值，任务列表 keyset 排序与终态维护的 topology revision）。删除只删根行，子树与各任务的从属行（定义、启动来源、工作区、挂载、运行等）全部经 FK 级联删除，语义与今天相同。`task_launch_contexts` 只放启动来源事实（`parent_node_run_id`、lineage、launch origin、触发上下文、调度 / webhook / 事件来源、数字员工来源、平台输入路径、终止绑定），不再承载父子关系。

**design.md §3.2 表：** `task_launch_contexts` 行删去 `parent_task_id, invocation_depth, root_task_id`；`tasks` 生命周期行追加 `parent_task_id, root_task_id, invocation_depth, branch_started_at`；`task_workspaces` 行删去 `branch_started_at`。

**design.md §9 第三段末尾追加：** 「Task 的全部从属表对 `tasks(id)` 级联；任务树由 `tasks.parent_task_id` 自引用级联维持。」

**plan.md §3「Task 主体」行反例追加：** 「删除根任务后留下任何后代任务或后代的从属行（两 provider）；删除后父链 `branch_started_at` 未重算」。

### 5.5 用户决定

否。

---

## 6. 「主仓 = ordinal 0 投影」的例外（§6.4-6）

### 6.1 事实

- **延后准备占位任务零挂载**：占位工作区 `repositories: []`、`nodePaths: []`、`worktreePath: ''`、`branch: ''`（`modules/task-execution/infrastructure/taskRouteWorkspaceParticipant.ts:166-192`）；请求来源只存在于镜像列：`repoUrl` 原文（落行时脱敏）、`cachedRepoId`（封存身份，`:150-160`）、请求 ref 落 `baseBranch`（`:179`）；`repo_count = max(1, 0)`（`taskRouteLaunchOperations.ts:891`）。读回者：准备描述符、重试命令、引用计数、过期制品回收（T5 HC1）。
- **`tasks.worktree_path` 是任务根而非 repo-0 镜像**：组任务为组根目录（`workspaceMaterializer.ts:786`）；`''` 是「未绑定」哨兵（`durableRepositoryPreparation.ts:126-131`；`shared/lifecycle.ts:427-436` `taskWorkspacePhase`），并出现在 CAS 谓词中（`taskLifecycleWriteSequence.ts:97-99`、`workspaceMaintenanceSqlStore.ts:261`、`repositoryPreparationRetryCommand.ts:240`）。
- **顶层分支**：落行 `branch = preparedWorkspace.branch === '' ? (workingBranch ?? 'agent-workflow/{taskId}') : preparedWorkspace.branch`（`taskRouteLaunchOperations.ts:844-847`）；组空间 `branch / baseCommit` 取 `repos[0]`（`workspaceMaterializer.ts:779-789`）。本机样本 227 行差异是内部工作区「repo 分支为空、任务分支为默认值」（migration §4.2）。
- **`repos[]` 永不为空**：无 `task_repos` 行时由镜像合成一条（`taskRouteOperations.ts:307-327, 412`、`services/task.ts:4273-4281, 4837-4865`）；**目录树回落是正常路径**：所有非组任务零 `task_space_nodes` 行，由 `minimalNodePaths` 推导 `['']`，重新启动依赖它命中 `onlyRootRepo`（`workspaceMaterializer.ts:1016-1021`）。
- 线上：`TaskSchema.repoCount` 为 `positive()`（`shared/schemas/task.ts:529, 643`）；`worktreePath / repoPath / baseBranch / branch` 为非空类型字符串；前端以 `worktreePath === ''` 判可恢复（`frontend/routes/tasks.detail.tsx:2162-2181`）。

### 6.2 方案

| 方案 | 内容 | 后果 |
| --- | --- | --- |
| A 占位挂载行 | 为占位任务建 `requested` 状态的 ordinal 0 挂载 | 挂载表混入「请求」与「物化」两种生命周期；组请求无法预知挂载集合 |
| **B 显式请求事实 + 统一投影函数** | `task_workspaces.requested_source`（冻结）+ `task_branch`；`tasks.workspace_root_ref` 可空；领域投影函数产出全部顶层字段与 `repos[]` | 请求只有一处权威；线上值逐一可还原 |
| C 保留镜像列给占位任务 | 违反 D2 | — |

### 6.3 推荐：B

1. `task_workspaces.requested_source`（codec `requestedSource@v1`，冻结）：按今天 StartTask 的来源字段记录请求——来源种类（URL / cached repo / 仓库组 / scratch / 内部 / 继承）与 `cachedRepoId`、脱敏 URL、请求 ref、`repoGroupId / repoGroupName`。所有任务都写（不只占位任务），准备描述符、重试、引用计数、过期制品回收只读它。
2. `task_workspaces.task_branch`：任务级工作分支（`workingBranch ?? 'agent-workflow/{taskId}'`），与挂载的实际分支状态分开。
3. `tasks.workspace_root_ref`：NULL = 未绑定（替代 `''` 哨兵）；CAS 谓词 `worktree_path = ''` 改为 `IS NULL`。`taskWorkspacePhase` 判据不变（未绑定 + 有 `__repo_prep__` 行 = preparing）。
4. **投影函数** `projectTaskRepositorySurface(workspace, rootRef, mounts)`（`modules/task-execution/domain/`）：
   - `worktreePath = rootRef ?? ''`；
   - 有挂载：`repoPath / repoUrl / cachedRepoId / baseBranch / baseCommit` 取 ordinal 0；`branch = mount0 分支名非空 ? 该值 : task_branch`；
   - 无挂载：`repoPath = ''`，`repoUrl / cachedRepoId / baseBranch` 取 `requested_source`，`baseCommit = null`，`branch = task_branch`；
   - `repoCount = max(1, 挂载数)`；`repos[]` = 挂载按 ordinal，无挂载时按上面的值合成一条（`repoIndex 0`、`mountPath ''`、`worktreeDirName ''`），与今天 `fallbackRepo` 一致。
5. 写者总是落最小目录树（至少 `''`），6 个写 `nodePaths: []` 的写者同步改（T5 HC8 列表），读路径不再推导；转换器为历史任务按祖先闭包规则物化（migration §4.2 末行已有）。
6. 转换器对每个任务验证「旧镜像列 = 投影函数(新事实)」；不等的字段按 migration §4.2 冲突规则处理（两值入证据，可执行任务阻塞）。

### 6.4 设计文档修改

**design.md §4 第一段后追加「主仓字段投影」：**

> 线上主仓字段不是持久镜像，由 `projectTaskRepositorySurface` 产出：`worktreePath` 取 `tasks.workspace_root_ref`（NULL 投影为 `''`）；有挂载时其余字段取 ordinal 0，`branch` 在挂载分支名为空时取 `task_workspaces.task_branch`；无挂载（延后准备占位、物化失败）时取 `task_workspaces.requested_source` 与 `task_branch`，并合成一条 `repos[0]`；`repoCount = max(1, 挂载数)`。请求来源对所有任务冻结在 `requested_source`，准备描述符、重试、引用计数与过期制品回收只读它。工作区写者总是落最小目录树，正常读取不推导目录节点。

**design.md §3.2 表：** `task_workspaces` 行改为本节第 1～2 条字段；新增一行「`tasks.workspace_root_ref` ← `worktree_path`」；`task_repository_mounts` 行注明「占位任务零挂载」。

**design.md §10 D2 行「保留的真实能力 / 验收反例」追加：** 「延后准备占位与物化失败任务的详情 / 列表 / 重试 / 引用计数；单仓重新启动仍按根仓物化」。

**migration.md §4.2 表追加两行：**

> | 延后准备占位 / 物化失败（零 `task_repos`） | 镜像列的请求值写入 `requested_source`；`worktree_path = ''` → `workspace_root_ref = NULL`；验证投影函数还原旧镜像值 |
> | `tasks.branch` 与挂载分支 | 写 `task_branch`；验证 `旧 branch = (挂载 0 分支名非空 ? 该值 : task_branch)`；不成立按「未解释冲突」处理 |

**plan.md §3「工作区」行追加：** 正向「延后准备占位与物化失败任务的 GET / 列表 / 重试 / 引用计数投影与旧二进制逐字段相等；单仓任务重新启动仍走根仓物化」；反例「`repoCount` 投影为 0；`repos[]` 为空；未绑定用空串而非 NULL」。

### 6.5 用户决定

否。

---

## 7. D 清单补项（§6.4-7）

### 7.1 事实

- **pre-snapshot 已无生产者**：`modules/task-execution/composition/nodeMechanics.ts:4131-4136` 注释说明 RFC-130 起不再写；`util/git.ts:2434` `gitStashSnapshot` 无生产调用方。`pre_snapshot` 只被铸行继承复制（`application/buildNodeRunMintRecord.ts:45-46`，以及 `resolveSchedulerRunRow.ts:192`、`taskRouteOperations.ts:2363`、`collaboration/infrastructure/review.ts:3836` 的继承来源）；`pre_snapshot_repos_json` 零写者，只有读者（`domain/humanGateContinuation.ts:57`、`services/nodeRollback.ts:47`、`services/structuralDiff/refSelect.ts:58`、`code-capability/infrastructure/codeWorkspaceRead.ts:21`、`childTaskLifecycleParticipant.ts:584`）。`services/nodeRollback.ts:93-120` 的 retry 模式（`resetOnEmptySnapshot: true`）无生产调用方。
- **启动期 seq 回填**：`application/bootExecutionRecovery.ts:13-15` → `application/nodeRunSeqBackfill.ts:7-33`、`domain/nodeRunSeqBackfill.ts:15-27`、`infrastructure/nodeRunSeqBackfillStore.ts:14-110`（`ROW_NUMBER() OVER (ORDER BY id)` 生成非正 seq，`:43-53`）。
- **启动期 frame 回填**：`bootstrap/daemonLifecycleProgram.ts:62`（`frame-backfill`，execution-recovery，best-effort）→ `bootstrap/daemonApplication.ts:806-817`→ `composition/frameBackfill.ts`；离线入口 `cli/frameBackfill.ts`。
- **其他每次启动都跑、且理解旧形状的步骤**（需逐项分类）：`scheduled-payload-heal`（`daemonLifecycleProgram.ts:54`；`daemonApplication.ts:818-824` → `services/scheduledTasks.ts:995` 把旧 `repoPath` 载荷转换或禁用）；`resource-reverify` 中的 `backfillLegacyVersions`（`daemonApplication.ts:915`）；`skill-identity-barrier` 的 `migratedSkills`（`:749-754`，同时做在途操作恢复）；`fusion-provenance` 修复（`:755-762`）。

### 7.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 显式补入 D 清单并给出去向** | AC-8「新库不运行旧 writer drain / 正常进程不加载源 schema reader」可逐项销账 |
| B 不写，留给实现发现 | 正常启动继续理解旧形状，AC-8 无法判定 |

### 7.3 推荐：A

- pre-snapshot：目标模型里 `node_run_repo_checkpoints.pre_snapshot` 只承载迁移来的值（「历史可恢复能力」，不设计新写协议）；铸行继承改为复制被继承运行的 checkpoint 行（单仓与今天等值；多仓历史行由「继承时丢失」变为「保留」，只影响 RFC-130 之前的行）；删除 `gitStashSnapshot` 与 retry 模式分支；pre-snapshot 回滚只对存在该字段的行生效。
- seq / frame 回填：一次性进入转换器，标 `legacy-derived`；目标启动序列删除这两步与 CLI 入口。
- 其余启动步骤：T1 必须逐项输出「旧数据升级（→ 转换器）」或「在途操作恢复（保留）」的分类与依据；`scheduled-payload-heal` 的转换依赖文件系统探测，进入转换器时把探测结果记入行处置证据。

### 7.4 设计文档修改

**design.md §10 表：**

- D3 行「必须删除…」列追加：「`gitStashSnapshot`；`rollbackNodeRunWorktrees` 的 retry 模式（`resetOnEmptySnapshot: true`）；`pre_snapshot` 的新写入可能性——它在目标模型只是迁移写入的只读 checkpoint 字段，铸行继承复制 checkpoint 行」。
- D4 行「必须删除…」列追加：「启动期 seq 回填（`bootExecutionRecovery` → `nodeRunSeqBackfill*`），改为转换器一次性回填并标 `legacy-derived`」。
- D5 行「必须删除…」列追加：「启动期 frame 回填（`frame-backfill` 启动步骤、`composition/frameBackfill`、`cli/frameBackfill` 与 doctor 入口），改为转换器一次性物化」。
- D12 行「必须删除…」列追加：「所有启动期旧数据升级步骤；T1 输出逐项分类（旧数据升级 / 在途恢复），前者进入转换器」。

**plan.md §2 T1 行「完整交付」追加：** 「启动序列逐步分类表（旧数据升级 / 在途恢复）」。

**plan.md §3「NodeRun」行反例追加：** 「目标启动序列仍含 seq / frame 回填步骤（`tests/rfc379-daemon-lifecycle.test.ts` 的步骤清单改指）」。

### 7.5 用户决定

否。

---

## 8. `envelope_nonce`（§6.4-8）

### 8.1 事实

- 每次铸行、每种角色都生成：`application/buildNodeRunMintRecord.ts:24-26`（`generateNodeRunEnvelopeNonce`）、`:107`；整行插入 `infrastructure/nodeRunMintParticipant.ts:85-92`。之后不再更新；同会话续跑铸新行时复制（`nodeMechanics.ts:4027-4047`，只复制非空值）。
- 读者：runner 提示与解析（`application/taskAgentRun.ts:186-189`）、`nodeRunLifecyclePersistence.ts:209-216`（`?? ''`）、`nodeMechanics.ts:397-406` 等、聚合前次输出（`wrapperMechanics.ts:1291-1308`）、工作组 host 账本经公开合同回传（`public/commands.ts:152-162, 216-220`）、托管提交（`crewstation/agentContext.ts:5-35`）、脚本环境变量。
- NULL → `''` → 无 nonce 的 envelope 协议变体（`tests/rfc200-envelope-nonce.test.ts:84`）。
- design §5.3 把它放进 `node_run_runtime_states`，与「运行态只给有进程 / wrapper 状态的角色建行」冲突。

### 8.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 归 `node_runs` 身份列** | 铸行时与身份同写、不可变；运行态表保持按需建行 |
| B 归 `node_run_configs`，configs 每行必建 | configs 也变成每角色必建，偏离「按适用角色拆分」 |
| C 留运行态表，每行必建 | 与 design 原则正面冲突 |

### 8.3 推荐：A

nonce 是在铸行时与身份一起确定、此后不变的运行级协议参数，归身份表最符合其生命周期；它对所有角色生成的今日行为保持（工作组 host 账本等跨上下文消费者依赖它）。可执行行必须非空；迁移来的 RFC-200 之前的行为 NULL，读取时按 envelope 协议的无 nonce 变体处理——这是协议版本，不是 schema 回退。

### 8.4 设计文档修改

**design.md §5.3 表：** `node_run_runtime_states` 行删去 `envelope_nonce`；「身份 / 生命周期」行追加 `envelope_nonce`。

**design.md §5 新增 §5.6「envelope nonce」：**

> `node_runs.envelope_nonce` 在铸行时生成并与身份一起写入，此后不可变；同会话续跑铸新行时复制前一行的非空值。`record_mode = executable` 的行必须非空（CHECK）；迁移来的 RFC-200 之前的行允许为 NULL，读取时使用 envelope 协议的无 nonce 变体，仅用于解释历史输出。`node_run_runtime_states` 只为有进程、会话、隔离或 wrapper 状态的运行建行。

**plan.md §3「NodeRun」行正向追加：** 「wrapper / io / review / clarify / commit 行铸行即有 nonce 且无运行态行；历史无 nonce 行的输出解析与提示渲染与今天一致」。

### 8.5 用户决定

否。

---

## 9. design 内部待定（§6.4-9）

### 9.1 事实与推荐（逐点）

| 点 | 事实 | 推荐 |
| --- | --- | --- |
| a `merge_state` 归属 | 每个运行一个状态机，唯一写手是 merge CAS（`infrastructure/mergeStateLifecyclePersistence.ts:37-80`），伴随写 iso 路径、wrapper 进度与快照；不存在「某仓已合并、另一仓未合并」的持久态；frontier 每 tick 读它（`composition/dagFrontier.ts:170, 421`）；NULL = 从未隔离 = 已结算（`shared/lifecycle.ts:517-518, 546-550`） | 归 `node_run_runtime_states`，与 `isolation_root_ref`、`wrapper_progress_json` 同行，CAS 保持单行（§4）。运行态行缺失 ≡ NULL ≡ 从未隔离。从 design §4 与 §5.3 的 results 中删去 |
| b `isolation_root_ref` 与 `iso_worktree_path` | iso 物理路径 `{appHome}/iso/{taskId}/{isoKey}/{worktreeDirName}`（`platform/workspace/local/isolationReferences.ts:24-32`），容器路径是运行级；所有写者令 `worktree_dir_name == mount_path`（`workspaceMaterializer.ts:751-752`） | checkpoint 不存 `isolation_root_ref`；运行级 `isolation_root_ref`（← `iso_worktree_path`）在运行态表；每仓 iso 目录由 `(appHome, taskId, isoKey, mount_path)` 推导，与今天同值。转换器断言每行 `worktree_dir_name == mount_path`，不等时在途 iso 任务阻塞、终态记证据 |
| c per-repo map 的键 | map 键是 `worktree_dir_name`（`services/nodeRollback.ts:109`、`platform/workspace/local/isolation.ts:590-623, 678`）；单仓写在 `''` 键（`wrapperMechanics.ts:618-620`） | 转换器按 `(task_id, worktree_dir_name) → task_repos.repo_index → repo_key` 映射；`''` 键 → `mount_path = ''` 的挂载；`repo_count = 1` 时的单值列 → 唯一挂载（不论其 mount_path，覆盖 §12 形状）；无法映射的键记证据，可执行任务阻塞 |
| d 快照四态 | map 缺失 / map 中缺该仓 / `''`（干净树）/ sha（`services/nodeRollback.ts:93-120`） | checkpoint 字段三态（NULL 未记录、`''` 干净树标记、sha）+ 行存在性：「map 缺失」= 该运行无任何仓记录该字段；「缺该仓」= 只有别的仓有行。旧代码「多仓 + 无 map → 在容器根上走单仓回滚」的回落不带入目标；转换器遇到多仓任务的单值 `pre_snapshot` 记证据，可执行任务阻塞 |
| e 问题快照对脑图可变 | follow-up 追加在 Task 锁下整段重写 `questions_json`，但只追加不改既有题（`collaboration/infrastructure/clarifyFollowupStore.ts:103-141`）；封口按 `questionSetKey` 校验（`clarify/seal.ts:302-308`） | 问题集为「只增」版本化快照：`clarify_rounds.questions_json` + `questions_revision`（追加时 CAS 推进）；既有题不可改写；答案 / 草稿写入时校验题目存在于当前题集；封口冻结 `sealed_question_set_key` |
| f 消费记录粒度 | `consumed_upstream_runs_json` 只到源节点（`nodeMechanics.ts:5109-5111, 5159`），聚合输入从未记录；所有读者都在源节点粒度判断（新鲜度、frontier、fanout 代门、评审 coversSource、开门 CAS）；NULL 视为新鲜 | `node_run_inputs` 改为 PK `(consumer_run_id, ordinal)`，唯一 `(consumer_run_id, input_kind, producer_node_id, producer_shard_slot)`；列 `producer_run_id, input_kind ∈ {frame-input, wrapper-parameter, aggregator-shard, review-source, gate-open}`；不设端口列（无读者、历史不可证）。新增聚合输入（`aggregator-shard`）记录。`node_runs.inputs_recorded`：新铸行为 true；迁移来且 JSON 为 NULL 的行为 false，读者对 false 保持今天「NULL 视为新鲜」的语义 |
| g `review_iteration` | 评审运行原地重置时自增（`review.ts:3561, 3860, 3870`），是决策并发令牌（`review.ts:3127`、`routes/reviews.ts:340`） | `node_runs` 上的 CAS 可变生命周期属性（与 status 同 CAS），不进槽位键；评审槽位 = node 槽位；按轮历史在 `doc_versions`；线上语义不变 |
| h 两条代轴 | `operation_generation` 在任何带 `inheritFrom` 的铸行 +1、其余为 0（`buildNodeRunMintRecord.ts:56-58`），被子任务启动、人工门围栏、续跑准入消费 | `operation_generation` 原样保留（铸行时确定、不可变、效果谱系轴）。`generation_seq` 只由封闭列表的显式操作推进：retry 级联、resume、同步工作流、评审重跑、澄清重跑、运维修复、动态工作流批准；每次操作写一行 `task_execution_generations(task_id, generation_seq, cause, previous_generation_seq, operation_ref, created_at)`，并盖在该操作改动的选择行与新铸运行上。历史一律 `generation_seq = 0`、质量 `legacy-derived`；绝不从 `operation_generation` 推导。今天没有读者依赖 `generation_seq`，它只作选择变更的 provenance |

### 9.2 设计文档修改

**design.md §4 表第 4 行**（`readonly, readonly_dirty_count…`）不变；**§4 第二段**（`node_run_repo_checkpoints`）替换为：

> `node_run_repo_checkpoints`：PK `(node_run_id, repo_key)`，FK 到同任务挂载；保存 `pre_snapshot, isolation_base, node_tree, submodules`。每个字段三态：NULL（未记录）、`''`（干净树标记）、提交 / 树 id。行存在性区分「该运行没有记录任何仓」与「只记录了部分仓」。一仓一行、多仓多行；`merge_state` 与运行级 `isolation_root_ref` 不在本表（见 §5.1）。每仓 iso 目录由 `(appHome, taskId, isoKey, mount_path)` 推导。

**design.md §5.1 表：**
- `node_run_runtime_states` 行替换为：「PK/FK `node_run_id`；pid / launch nonce / session、启动验证、`merge_state`、`isolation_root_ref`、`wrapper_progress_json` | 只为有进程、会话、隔离或 wrapper 状态的运行建行；行缺失等价于 `merge_state` 为 NULL（从未隔离）；`merge_state` 的 CAS 与 iso 根、wrapper 进度同行」。
- `node_run_results` 行：删去「merge」。
- `node_run_inputs` 行替换为：「PK `(consumer_run_id, ordinal)`，唯一 `(consumer_run_id, input_kind, producer_node_id, producer_shard_slot)`；`producer_run_id, input_kind` | 记录实际消费到源节点（及 shard）粒度，含聚合输入；不从当前最新 producer 倒推；`node_runs.inputs_recorded = false` 的迁移行保持『未记录视为新鲜』」。
- `node_runs` 行追加：「`inputs_recorded`；`review_iteration` 为 CAS 可变属性」。

**design.md §5.2 第二段替换为：**

> `generation_seq` 只由显式操作推进：retry 级联、resume、同步工作流、评审重跑、澄清重跑、运维修复、动态工作流批准；每次写一行 `task_execution_generations`，并盖在该操作改动的选择与新铸运行上。`attempt_index` 是同一槽位的 retry 编号；`operation_generation` 与既有 lineage operation fencing 原样保留（铸行时确定，带继承的铸行 +1），两轴独立填充，历史 `generation_seq` 统一为 0（legacy-derived），不从 `operation_generation` 推导。`runtime.generationId` / daemon ownership 是第三条轴，不复用其值。

**design.md §5.3 表：** `merge_state` 从 `node_run_results` 行移到 `node_run_runtime_states` 行；`iso_worktree_path` 注明「→ `isolation_root_ref`」。

**design.md §6.1 第一段「冻结问题快照」改为「只增的版本化问题集（`questions_revision`）」，并在「questions snapshot 内 question ID 唯一…」一句后追加：**

> 脑图 follow-up 只在当前题集末尾追加，以 `questions_revision` CAS 推进；既有题目不可改写或删除。答案与草稿写入时校验题目存在于当前题集；封口冻结 `sealed_question_set_key`。

**migration.md §4.3 追加：**

> - per-repo JSON map 按 `(task_id, worktree_dir_name) → repo_index → repo_key` 映射；`''` 键映射到 `mount_path = ''` 的挂载；`repo_count = 1` 的单值列映射到唯一挂载。无法映射的键记证据，可执行任务阻塞。断言 `worktree_dir_name == mount_path`。
> - `consumed_upstream_runs_json` 转为 `node_run_inputs`（`input_kind = frame-input`，质量 `legacy-derived`）；JSON 为 NULL 的行 `inputs_recorded = false`。聚合运行的输入由 oracle 计算当时参与的 shard 运行写入，质量 `legacy-derived`。
> - 历史运行 `generation_seq = 0`。

**plan.md §3「协作」行追加：** 正向「follow-up 追加与同轮草稿保存并发；封口时题集已变」；反例「改写既有题目；封口后追加」。**「NodeRun」行追加：** 正向「多仓 checkpoint 三态与部分仓记录；iso 目录推导与 `worktree_dir_name` 等值」。

### 9.3 用户决定

否。

---

## 10. 前端严格解析与兼容投影（§6.4-10）

### 10.1 事实

- 后端响应前严格 `parse`：`TaskSchema`（`taskRouteOperations.ts:421`、`taskRouteLaunchOperations.ts:581`）、`TaskSummarySchema`（`:514`）、`TaskListItemSchema`（`:755`）、`NodeRunSchema`（`:1013`）；前端 `.strict()` 解析任务目录（`frontend/hooks/useTaskOperationsPage.ts:40`、`shared/taskCatalog.ts:16-61`），多一个键整页失败。
- 前端不对 Task / NodeRun / ClarifyRound 做 zod 解析，但值语义被约 75 个生产文件消费（r4-sub FE §1、§6 R1-R23）。
- 关键语义：`workflowId` 非空；`sourceAgentName` 是 agent 判别输入；`parentNodeRunId` 是「历史 parent」（loop 内为 null 而 `containerRunId` 非空），9 处前端以 `=== null` 判顶层；`seq` 今天可空，前端排序 `compareNodeRunMintOrder` NULL 在前、ULID 兜底；`worktreeDirName` 是必填字段但前端不消费；`repoCount` 正整数；草稿保存逐题 LWW 无令牌，提交令牌是轮 `iteration`；仓库线上键是 `mountPath`。

### 10.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 现有 zod 合同即验收标准，逐字段写死投影规则** | 前端零改动；shared schema 只有 `NodeRunSchema.seq` 一处收紧 |
| B 借机放宽 / 重塑合同 | 前端与 shared 同步改，超出 G3 |

### 10.3 推荐：A

| 字段 | 投影规则 |
| --- | --- |
| `Task.workflowId / workflowName / workflowVersion / workflowSnapshot` | §1.3 第 3～5 条 |
| `codeRoundId / workgroupId / sourceAgentName / sourceAgentId` | 由 `subject_kind / source_id / source_name` 还原，保证 `taskExecutionKind` 优先级不变；agent 主体 `sourceAgentName` 必非空 |
| 主仓字段、`repos[]`、`repoCount`、`spaceNodes` | §6.3 投影函数 |
| `TaskRepo.worktreeDirName` | 投影为 `mountPath`（所有写者两值相等）；`mountPath` 逐字节保留 |
| `failureCode` | 失败节点当前选中运行（顶层），两份实现合一 |
| `NodeRun.parentNodeRunId` | `node_runs.historical_parent_id`，由各铸行点照今天的写法给出（shard → wrapper 运行、commit-push 容器 → 触发运行、commit 会话 → 容器、自澄清 park 行 → 提问者的 parent、loop 内为 null），**不**由 container / role 推导 |
| `NodeRun.seq` | 非空；`NodeRunSchema.seq` 收紧为 `z.number().int()`（前端不解析，仅类型变化）；历史回填复刻「NULL 在前、ULID 兜底」全序 |
| node-runs 列表顺序 | `startedAt NULLS FIRST, seq ASC`（seq 唯一后去掉 id 兜底，结果与今天相同） |
| `NodeRun.retryIndex / reviewIteration / opencodeSessionId / commitPush / supersededByReview / rolledBack` | 原值；新的 `attempt_index / generation_seq` 不上线 |
| Clarify `answers / draftAnswers / answerAttributions` | 由逐题表投影为今天的 map / 数组；部分封口时 `answers` 含已封子集、归属仍为草稿编辑者；草稿保存仍逐题 LWW、不新增客户端令牌 |
| Agent `skills / dependsOn / mcp / plugins` | 关系表按 ordinal 原样回放，含 kind、仅名称的项目技能、悬空 id |
| `TaskCatalogListItem` | 键集合不变（strict） |

### 10.4 设计文档修改

**design.md §8 末尾新增「API 兼容投影合同」**：粘贴 §10.3 表，并加一句：

> 现有 shared zod 合同（`TaskSchema`、`TaskSummarySchema`、`TaskListItemSchema`、`NodeRunSchema`、`TaskCatalogListItemSchema`）是投影的验收标准；除 `NodeRunSchema.seq` 收紧为非空外不改合同。投影函数位于 task-execution（Task / NodeRun）与 collaboration（Clarify）的 domain，DTO 映射器只调用它们。

**plan.md §3** 新增一行：

> | API 投影对拍 | 同一迁移 fixture：旧二进制在源库上的 `GET /api/tasks/:id`、`/node-runs`、任务目录、评审列表、澄清详情，与新二进制在目标库上的响应逐字节相等（只允许 design 登记的差异） | 投影多键使 strict 解析失败；`parentNodeRunId` 被替换为 container；`repoCount` 为 0；agent 任务被判为 workflow |

**plan.md §2 T15 行「完整交付」追加：** 「DTO 对拍夹具与测试」。

### 10.5 用户决定

Q2（可选）。

---

## 11. 迁移机制待决（§6.4-11）

本项拆为 M1～M8 七个子项（M6 已决），见本文 M 节。§6.4-11 所列「跨 epoch 备份恢复」已由用户 2026-10-21 确认（proposal §4、migration §2），M6 只补实现约束。

---

## 12. 疑似现存缺陷：单个非根成员仓库组的 iso checkpoint（§6.4-12）

### 12.1 结论：**属实**（代码阅读确认，未运行）

触发形状：仓库组展平后**恰好一个成员、挂载点非根**（例如 `mount_path = 'svc'`）。此时不走单仓分支（`modules/source-control/infrastructure/workspaceMaterializer.ts:1014-1022` 的 `onlyRootRepo` 要求 `mountPath === ''`），而走组物化：`worktreeDirName = mountPath = 'svc'`（`:751-752`），`tasks.worktree_path` = 组根（普通目录，`:786`），`repo_count = max(1, 1) = 1`（`taskRouteLaunchOperations.ts:891`）。

缺陷链：

1. 节点终态快照按 `worktreeDirName` 为键：`platform/workspace/local/isolation.ts:678`（`out[r.worktreeDirName] = …`），经 `modules/source-control/infrastructure/local/localIsolationWorkspace.ts:215-219` 返回 → `nodeTrees = { svc: <tree> }`。
2. `persistIsoNodeTree` 用镜像 `repoCount === 1` 判单仓，写 `isoNodeTree: nodeTrees[''] ?? null`（`modules/task-execution/infrastructure/isolatedAgentRun.ts:243-262`，取值在 `:260`）→ **落 NULL**，同时 `isoNodeTreeReposJson` 也写 NULL。
3. `persistIsoBase` 同样按 `repoCount === 1` 写单值列（`:170-180`），值本身正确，但恢复时以 `''` 为键（见下）。
4. 实时合并不受影响（`mergeBackAndSettle` 用内存中的 `nodeTrees`，`:287-349`）。**受影响的是所有从持久列重建的路径**：
   - 崩溃重放：`composition/executionMergeRecovery.ts:122-134` 单仓分支取 `nodeTrees['']`，为空即抛 `pending-merge replay: node_tree missing for run …` → 任务失败而不是重放；
   - call 节点重启后收养：`nodeMechanics.ts:1853-1866` 以 `{'': base}` 重建；
   - wrapper iso 重建：`wrapperMechanics.ts:1729-1757`；
   - fanout 原地重跑的前次增量撤销：`wrapperMechanics.ts:609-628`（前次 node tree 为 NULL → 不撤销）；
   - 重建句柄时 `rebuildIsoHandle` 以 `worktreeDirName` 查表：`baseSnapshot: opts.baseSnapshots[r.worktreeDirName] ?? ''`、子模块拓扑同理（`isolation.ts:608-623`）→ 以 `''` 为键存的 base 与子模块拓扑全部丢失。

### 12.2 复现用例（建议，单独修复时先写）

文件：`packages/backend/tests/iso-single-nonroot-member-replay.test.ts`，顶注写明锁定的回归与本节编号。

1. **夹具**：建仓库组 G，只含一个成员仓 R，挂载 `svc`；用生产启动内核启动任务（可复用 `tests/rfc248-materialize-group.test.ts` 的组夹具）。断言 `task.repoCount === 1`、`task.repos[0].mountPath === 'svc'`、`worktreeDirName === 'svc'`、`worktreePath` 是组根且不是 git 仓。
2. **持久化断言**（快、无进程）：对一个隔离运行调用 `persistIsoNodeTree(binding, runId, task.repoCount, { svc: '<tree>' }, handle)`，读回 `node_runs`：期望 `iso_node_tree` 或 `iso_node_tree_repos_json` 能取回 `svc` 的树；**今天两列都为 NULL**。
3. **端到端崩溃重放**（参照 `tests/rfc130-crash-replay.test.ts`）：假 runtime 在 `svc/a.txt` 写文件；在 `mark-pending-merge` 之后、merge-back 之前注入崩溃；重启执行恢复。期望 `svc/a.txt` 进入 canonical、节点 done；**今天任务失败，错误含 `pending-merge replay: node_tree missing`**。
4. **收养 / wrapper 重建**：同夹具下，重启后重建句柄的 `repos[0].baseSnapshot` 应等于持久化的 base；今天为 `''`。

修复方向（单独提交，不在本研究内实施）：3 个写函数与 7 个解码点（`isolatedAgentRun.ts:170, 253-260, 443`；`nodeMechanics.ts:1035-1039, 1855`；`executionMergeRecovery.ts:124, 213, 351`；`wrapperMechanics.ts:618, 1729`）不再以 `repoCount === 1` 代替 `''` 键，改以「唯一挂载且挂在根」为单值判据；RFC-395 的 per-repo checkpoint 从结构上消除此类错配。

### 12.3 RFC-395 转换器处理

- `repo_count = 1` 且唯一挂载 `mount_path ≠ ''` 的任务：单值列（base / submodules）映射到该挂载（§9-c）。
- `merge_state ∈ {isolating, pending-merge}` 且 `iso_node_tree` 为 NULL：节点树已丢失，无法重放 → 可执行任务阻塞，列出 run id；终态任务记证据 `node-tree-lost-by-known-defect`。
- `merge_state = merged` 且 `iso_node_tree` 为 NULL：只影响 fanout 撤销，记证据。

### 12.4 设计文档修改

**migration.md §4.2 表追加：**

> | 单个非根成员仓库组（`repo_count = 1`、`mount_path ≠ ''`） | 单值 checkpoint 列映射到唯一挂载；已知缺陷导致的 `iso_node_tree` NULL：在途（isolating / pending-merge）阻塞并列出 run，终态与 merged 行记证据，不伪造节点树 |

**plan.md §3「工作区」行追加：** 正向「单个非根成员仓库组的隔离运行崩溃重放、收养与 wrapper 重建」；反例「以 `repoCount === 1` 代替根挂载判据」。

**plan.md §6.4 第 12 条改为：** 「已确认属实（代码阅读，见 II-0 §12），单独修复并带回归用例；RFC-395 转换器按 migration §4.2 处理已受影响的行」。

### 12.5 用户决定

Q5（修复是否另立 RFC）。

---

## 13. 先删 test-only 与死代码（§6.4-13）

### 13.1 事实（逐项复核）

| 候选 | 事实 | 结论 |
| --- | --- | --- |
| `startTask` / `startTaskWithLocalRepo` | `services/task.ts:1647-1653` 注明「RFC-387: test-only legacy admission … removed in W4」；`startTaskWithLocalRepo` 定义在 `:1566`；42 个测试文件使用两者之一；code-round 写槽 `StartTaskDeps.codeRoundLaunch`（`:713, 2499`）只在此路径 | 可删，测试改走生产启动内核 |
| `getTaskNodeRuns` | `services/task.ts:4378-4610`，生产无调用（仅注释提及：`review.ts:2058`、`taskRouteOperations.ts:1057`）；8 个测试文件使用 | 可删，测试改用 `taskNodeRunsProjection` |
| `systemWorkspaceGc` 库函数 | 生产只经 `services/gc.ts:2` 引用内存集合 `materializingSpaces`（7 个生产文件）；`runWorktreeGc / runIsoWorktreeGc / runScratchOrphanGc / recoverInterruptedWorkspaceGc` 等无生产调用（9 个测试文件） | 库函数可删，`materializingSpaces` 迁到其使用方所在模块 |
| intent 引擎 `converge` | `modules/intent/infrastructure/intentApplyEngine.ts:553-645`，只经测试 facade 可达（生产收敛是 `intentApplyArtifactLifecycle.ts:395-489`） | 可删 |
| `services/bundle/provider.ts` | **不是整文件死代码**：`opSlug / planBundleOps / resourceTypeOfOp` 被生产使用（`platform/persistence/postgresqlResourcePackageAtomicApply.ts:47`、`services/resourcePackage/{parse,preview,executionAdapter}.ts`）；只有 RFC-271 旧 BundleApply 合同段（`:15-127, 241-283`）无调用方 | 只删死合同段 |
| `decideIntentApplyConverge` | `modules/intent/application/journalConvergence.ts:46-62`，0 调用方；它正是 T10 要收编的纯收敛判据 | **不先删**，T10 移入 `platform/atomic-apply` 后接线 |

### 13.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 阶段 II 之前单独提交删除（测试改走生产路径）** | T4～T6、T10 改动面缩小；改走生产启动内核 / 应用图的测试与 schema 无关，II 中无需二次改写 |
| B 在阶段 II 第一步删除 | 与 II 的其他改动混在一起，审阅面更大 |
| C 不删、随 II 迁移 | 为将被删除的代码写目标模型适配，浪费 |

### 13.3 推荐：A

作为死代码删除 + 测试改接线的独立提交（不改产品行为）；完成全部删除与测试改接线后集中验证一次。`decideIntentApplyConverge` 留给 T10。其余疑似死代码（如 `services/agentDeps.ts:237-255`）由 T1 逐项确认后再列入，不在本次凭印象扩大。

### 13.4 设计文档修改

**plan.md §6.4 第 13 条替换为：**

> 阶段 II 之前单独提交删除：`startTask` / `startTaskWithLocalRepo` 与 `codeRoundLaunch` 写槽（42 个测试改走生产启动内核）、`getTaskNodeRuns`（8 个测试改用 `taskNodeRunsProjection`）、`systemWorkspaceGc` 的库函数（9 个测试，`materializingSpaces` 迁至使用方模块）、intent 引擎内 `converge`、`services/bundle/provider.ts` 中 RFC-271 旧合同段（`opSlug / planBundleOps / resourceTypeOfOp` 有生产使用，保留）。`decideIntentApplyConverge` 不删，由 T10 收编。

**plan.md §6.2 表**在 II-0 与 II 之间插入一行：

> | II-pre | §6.4-13 的死代码删除与测试改接线 | 独立提交；不改产品行为；完成后集中验证一次 |

### 13.5 用户决定

否。

---

## M1. 新 epoch 之后的 schema 演进机制（research-3 §6-1）

### M1.1 事实

- SQLite：drizzle-kit 从 `src/db/schema.ts` 生成 `db/migrations/*.sql`（`packages/backend/drizzle.config.ts`），`migrateSqlite` 整链一个事务应用（`platform/persistence/sqliteMigrator.ts:97-135`），`openDb` 自动迁移后把实库与「整链在 `:memory:` 重放」的物理结构比对（`db/client.ts:346-393`、`db/schemaAdmission.ts:313-351, 457-519`）。
- PostgreSQL：DDL 由合同生成，不可变历史 + 类型化边 V1 索引 / V2 新表 / V3 替换 CHECK / V4 退役整表 / V5 时钟 / V6 owner 元数据 / V8 追加列（`platform/persistence/postgresqlMigrationSequence.ts:124-167`），advisory 锁下补边（`postgresqlMigrator.ts:381-563`）；托管允许旧 release 服务「只扩展」后继（`expandOnlySuccessorOf`，`:326`）。
- 两条来源已经漂移出 7 个触发器、8 条 FK、`tasks.name` 可空性、42 张表列序的差异（research-3 §2.4），既有对账守卫不覆盖 FK / 可空性 / 列序。
- 阶段 II 开发期间主线仍在演进（工作树中 RFC-396 正新增 `db/migrations/0261_rfc396_graph_development.sql`）。

### M1.2 方案

| 方案 | 内容 | 后果 |
| --- | --- | --- |
| A SQLite 重开 drizzle-kit 链 + PG 保留类型化边 | 两个生成器从新 baseline 继续 | 正是今天漂移的来源；对账守卫要继续维护三本账 |
| **B 两 provider 统一的「合同历史 + 类型化边」** | 头合同 = registry 编译结果；历史 = 不可变的合同版本链；每条边按类型编译出两侧原生 DDL；准入 = 物理结构等于头合同编译 plan | 一份声明、一套演进；SQLite 需要「重建表」边 |
| C 每次结构变化都走新 epoch 转换 | 复用转换器 | 常规加列也要维护窗口，不可接受 |

### M1.3 推荐：B

- 机制在 `platform/persistence/schema/history/`；工件在 `db/schema-history/epoch2/NNNN_<slug>.{contract,sqlite-plan,postgresql-plan}.json`，内嵌进二进制；由 `scripts/schema-history.ts --append <edgeKind>` 从 contribution 差异生成；CI 守卫「头合同 digest = registry 编译 digest」（沿用今天 `verifyPostgresqlMigrationHistory` 的形式）。
- 边类型（封闭列表）：add-table、add-column（可空或类型化默认值）、add-index（含部分索引）、replace-check、add-fk、retire-table、rebuild-table（SQLite 走官方重建步骤，PG 走 ALTER 序列）、seed-delta、data-transform（两侧 SQL、幂等、带回执、须评审）、owner-metadata。
- 应用：SQLite 单事务、FK 关闭、提交前 `foreign_key_check`；PG advisory 锁；两侧都写 schema 历史元数据行（版本、合同 digest、两份 plan digest、时间）。
- 准入：两侧都比较「物理目录 = 头合同编译 plan 的物理结构」（按 plan digest 缓存），不再重放历史。旧二进制遇到更新的 epoch-2 库：只在新版本是「只扩展后继」时继续服务（把 `expandOnlySuccessorOf` 推广到两 provider），否则拒绝。
- 自本 RFC 的激活提交起，drizzle-kit 不再生成迁移、`drizzle.config.ts` 删除（此前 epoch-1 迁移照旧生成）；`db/migrations/*.sql`（epoch 1）与 PG 历史冻结在迁移包内，只供源识别与离线前滚。
- 切换前的过渡规则：在 RFC-395 激活提交之前，任何新增表 / 列的 RFC 仍向 epoch-1 两条链追加迁移，同时更新目标 contribution（I-a 结构锁），并在转换器源版本清单中登记新版本；转换器支持的源版本 = 候选构建时 epoch-1 的全部已发布版本。

### M1.4 设计文档修改

**design.md 新增 §13「目标 epoch 之后的 schema 演进」**：粘贴 M1.3 前五条。

**design.md §10 D12 行替换为：**

> | D12 | 新库启动重放全部历史迁移链；SQLite 的 drizzle-kit 迁移生成与「整链重放后比对」准入；启动期旧数据升级步骤（见 D4 / D5 增补） | 新 baseline 直接建库；epoch 2 内按合同历史的类型化边增量演进；准入比较头合同编译 plan；旧迁移不可变保存于转换 / 历史包 |

**migration.md §3 最后一段末尾追加：** 「epoch 2 的后续演进按 design §13 的合同历史边增量应用；在本 RFC 激活提交之前，新增 epoch-1 迁移必须同时登记为转换器支持的源版本。」

**plan.md §2 T13 行「完整交付」追加：** 「两 provider 统一的合同历史机制、边编译器与准入；`scripts/schema-history.ts`」。

**plan.md §3「schema / codec」行追加：** 正向「每类边在两 provider 上编译并应用后物理结构等于新头合同编译结果；rebuild-table 边保留行、FK 与索引」；反例「物理结构偏离头合同仍被准入；旧二进制在非只扩展后继上继续服务」。

### M1.5 用户决定

否。

---

## M2. 行处置粒度与存放（research-3 §6-2）

### M2.1 事实

- migration.md §3 要求每条源行有 `converted / preserved / archived / blocked` 处置；AC-1 要求「所有源行在迁移 receipt 中可追踪」。
- 现有 PG 逻辑拷贝在**同一目标事务**里写 chunk 行与 `logical_copy_chunks` 回执（`platform/persistence/postgresqlLogicalTarget.ts:539-628`），不存在「行已提交、回执未写」；工件按 chunk / 表记行数、首末键、摘要（`logicalDatabaseArtifact.ts:88-100`），文件工件只写一次（`modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore.ts:14-55`）。
- 大表（事件、观测）行数可能远大于业务表；为每行复制一条处置记录会使元数据与业务数据同量级。

### M2.2 方案

| 方案 | 后果 |
| --- | --- |
| A 每行一条处置 | 查询最简单；元数据与大表同量级，转换时间翻倍 |
| **B「同键可推导」用 chunk 级证明，例外行级记录** | 元数据只与例外数量成比例；每行仍可经 chunk 键范围追溯 |
| C 只记表级计数 | 不满足 AC-1 |

存放：目标库元数据表（与行同事务）或操作根文件。推荐**目标库**保存运行中状态与回执（保证幂等与原子），在 `validated` 时写一次性文件导出到操作根（审计与备份）。

### M2.3 推荐：B + 目标库

- **同键可推导转换**：目标主键等于源主键或其纯函数（如 `node_run_configs.node_run_id = node_runs.id`），目标列值是源行（加上已声明、带版本的查找集合）的纯函数。这类转换以 chunk 回执证明：源表与版本、键范围、行数、源规范摘要、各目标表行数与摘要、规则版本。chunk 内每行处置为 `converted`。
- **行级处置**只记：派生新 ID、合并（`tasks` 与 `task_repos` 镜像决议）、删除的占位行（宿主 workflow）、history-only、归档（归档 manifest 引用）、阻塞、冲突决议。推导质量（`legacy-derived` / `unknown`）写在目标行自己的 `provenance_quality` 或 `execution_legacy_evidence`，不在处置表重复。
- 表（SQLite 目标文件内 `aw_meta_*` 前缀；PG `agent_workflow_meta` schema）：`migration_runs`、`migration_chunk_receipts`、`migration_table_receipts`、`migration_row_dispositions`、`migration_artifact_receipts`、`activation_receipts`。由现有 `logical_copy_operations / logical_copy_chunks / database_generations` 泛化，不另起第二套激活事实；旧五表只保留兼容读者（PG 源识别）。
- 追溯接口：`agent-workflow db migration trace <table> <key>` 经 chunk 键范围或行级记录给出目标集合。
- 保留：随目标库保留至批准的保留期结束；之后可压缩为表级回执 + 已导出文件。

### M2.4 设计文档修改

**migration.md §3 表「Row disposition」行替换为：**

> | Row disposition | 同键可推导的转换以 chunk 回执证明（源表 / 版本、键范围、行数、源摘要、各目标表计数与摘要、规则版本）；派生 ID、合并、删除占位、history-only、归档、阻塞、冲突决议逐行记录（源表 + 结构化迁移键 → 目标表 / ID 集合或 archive ref、规则版本、决议） |

**migration.md §3 表后追加：**

> 迁移元数据存放在目标库（SQLite 目标文件内 `aw_meta_*` 表，PG `agent_workflow_meta` schema），chunk 行与其回执同事务提交；`validated` 时导出一份只写一次的回执文件到操作根。推导质量写在目标行或 `execution_legacy_evidence`，不在处置表重复。`db migration trace` 按源键给出处置。

**table-mapping.md §3「迁移元数据」行「目标表」改为：** 「`migration_runs`、`migration_chunk_receipts`、`migration_table_receipts`、`migration_row_dispositions`、`migration_artifact_receipts`、`activation_receipts`（由 logical-copy 与 generation 元数据泛化）」。

**plan.md §3「转换恢复」行追加：** 正向「任一源键可经 trace 得到处置；chunk 回执与行同事务」；反例「行级处置表出现同键可推导行（守卫）；chunk 行已提交而回执缺失」。

### M2.5 用户决定

否。

---

## M3. SQLite 目标文件位置与 pointer v2（research-3 §6-3）

### M3.1 事实

- SQLite 路径固定为 `Paths.db`（`util/paths.ts:16`；`platform/persistence/databaseProviderRuntime.ts:191-220`）；pointer `database-generation.json`（`util/paths.ts:92-93`），v1 严格 schema `{version:1, generationId, provider, operationId, schemaDigest, manifestDigest, activatedAt}`（`platform/persistence/generationValidation.ts:12-43`），文件为 `{payload, digest}`，原子写 + fsync + 读回（`generationStore.ts:113-166`）。
- SQLite 新装没有 pointer；无 pointer 时视为 `legacy-missing-pointer` 且直接取当前合同 digest（`generationValidation.ts:89-99, 225-227`）。
- 旧二进制遇 v2 pointer 时严格解析失败 → `generation-pointer-corrupt` 拒绝（research-3 §5.4）；旧二进制直接打开一个没有 `__drizzle_migrations` 的 SQLite 文件会尝试整链迁移直到首个冲突才失败——拒绝是偶然的（research-4 §10.3）。
- `tests/architecture/rfc349-provider-cutover.test.ts` 已要求编译 daemon 不得绕过 pointer 直开 `db.sqlite`。
- PG 首写标记已有（`postgresqlDatabaseClient.ts:127-149, 223, 231`），SQLite 没有。

### M3.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 代次目录文件 + pointer v2 显式指向** | 激活只是一次 pointer 原子替换；崩溃语义最简单；运维看到的文件路径改变 |
| B 激活时交换文件（源改名、目标改名为 `db.sqlite`） | 路径不变；两次改名不是一个原子操作，WAL / SHM 需额外处理，仍要 pointer 判定 |
| C 同一文件内新旧并存 | SQLite 无 schema 隔离，否决 |

### M3.3 推荐：A

- 目标文件：`~/.agent-workflow/databases/<generationId>/db.sqlite`（WAL / SHM 同目录）。新装同样落在代次目录，并**总是**写 pointer v2。
- pointer v2 载荷：`{version: 2, schemaEpoch, generationId, provider, role: 'installed' | 'converted' | 'restored', database: {kind: 'sqlite-file', relativePath} | {kind: 'postgresql-target', profileRef}, contractDigest, planDigest, operationId | null, manifestDigest | null, activatedAt, previous: {generationId, pointerDigest} | null}`，外层仍为 `{payload, digest}`。运行时只接受 v2；v1 只由迁移模块读取（源识别、首写前撤回）。
- 激活提交点：写临时文件 → fsync → rename 覆盖 pointer → fsync 目录。之前崩溃 = 源权威，之后 = 目标权威，由 activation receipt 判定。
- 首写前撤回：按 activation receipt 原样写回 v1 pointer 字节（源当时无 pointer 则删除 pointer），旧二进制即回到源。
- 源文件：冻结前完成 WAL checkpoint；`completed` 之前留在原位；`completed` 时整体改名移入 `database-migrations/<op>/source/`（同文件系统，不删除，按批准保留期保留）。
- 旧二进制防误开：pointer v2 使其在解析时拒绝；目标库内写一条 `__drizzle_migrations` 哨兵收据（未知 hash、`created_at = 0`），即使 pointer 丢失，epoch-1 二进制也在 RFC-275 预检阶段以 `DbSchemaDriftError` 拒绝。
- SQLite 目标在会话写路径加同事务的一次性首写标记，与 PG 同义。

### M3.4 设计文档修改

**migration.md §5 第 8 步「切换」中 SQLite 部分替换为：**

> SQLite 目标位于 `databases/<generationId>/db.sqlite`；切换以原子替换 pointer v2 为唯一提交点（写临时文件、fsync、rename、fsync 目录）。首写前撤回按 activation receipt 原样恢复 v1 pointer（或删除 pointer）。源文件在 `completed` 前保持原位，`completed` 时移入操作根保留，不删除。

**migration.md §3 末段追加：**

> generation pointer 升至 v2（显式 epoch、角色、数据库位置、合同与 plan digest、前一代引用）；运行时只接受 v2，v1 只在迁移模块读取。目标 SQLite 库内置 epoch-1 二进制必拒的哨兵迁移收据；SQLite 目标具备与 PG 同义的首写标记。

**plan.md §3「激活 / 回退」行追加：** 正向「pointer 替换前后各点崩溃；首写前撤回恢复原 pointer 字节；新装写 v2」；反例「epoch-1 二进制打开目标文件或读取 v2 pointer 后继续服务；SQLite 目标首写后仍允许撤回」。

### M3.5 用户决定

**Q3**（文件布局变化）：推荐接受。

---

## M4. provider 差异的目标裁决（research-3 §6-4）

### M4.1 事实

SQLite 迁移重放后的物理结构与合同（⇒ PG）的差异（research-3 §2.4；本次用只读脚本在内存库复算，结果相同）：

- **7 个仅 SQLite 的触发器**（`tests/architecture/rfc359-w5-t19g-schema-contract-reconciliation.test.ts:448-454` 已入账）：
  - `rfc328_tasks_lineage_after_insert`（`db/migrations/0210_rfc328_task_execution_ownership.sql:64-`）、`trg_tasks_launch_origin_inherit_child`（`0155_rfc301_task_launch_origin.sql:93-`，`0196` 重建）：插入后兜底补 lineage 与子任务 launch origin；四个 `insert(tasks)` 站点都显式写这三列，触发条件在生产路径上不成立（t19g `:420-445` 注释）。
  - `runtime_session_leases_reset_pending_insert / _update`（`0153_runtime_session_reset_fence.sql:4-18`）：因 SQLite ALTER 不能加 CHECK 而用触发器表达 `reset_pending IN (0,1)` 与 `reset_pending = 0 OR lease_node_run_id IS NOT NULL`；合同侧已有同义 CHECK（t19g `CONTRACT_ONLY_PROTECTIONS`）。
  - `trg_collaboration_gate_operations_committed_immutable`（`0212_rfc333_human_gate_operations.sql:81-91`）：已提交的 `result_gate_revision / receipt_json / committed_at` 不可再改。
  - `user_access_audit_no_update / _no_delete`（`0162_rfc305_user_permission_grants.sql:45-54`）：append-only 账本。
- **8 条仅 SQLite 的 FK**（含删除动作）：`development_missions.reopened_from_mission_id → development_missions` NO ACTION；`memories.supersedes_id / superseded_by_id → memories` SET NULL；`node_runs.container_run_id → node_runs` NO ACTION；`repo_group_nodes.child_group_id → repo_groups` NO ACTION；`task_collaborators.added_by → users` SET NULL（该列 NOT NULL）；`tasks.owner_user_id → users` SET NULL；`users.created_by → users` SET NULL。
  - 生产删除路径：记忆可硬删（`modules/memory/infrastructure/memoryCatalogOperations.ts:989-993`）——SQLite 自动置空引用、PG 留悬空；仓库组删除前应用先解除子组引用（`modules/source-control/infrastructure/repositoryWorkspaceStore.ts:280-301`）；`users`、`development_missions` 没有生产硬删；`node_runs` 只随任务级联删除。
- **`tasks.name`**：SQLite 物理可空（`0021_rfc037_task_name.sql` 以 ALTER 加列后按 `workflows.name`、回落 `'task-' || substr(id, -10)` 回填），合同 NOT NULL。
- **2 条部分 vs 全量唯一**：`code_work_observations.uniq_code_work_observations_event`（该表 ARCHIVE_THEN_OMIT，目标无表）、`intent_turn_events.uniq_intent_turn_events_external`（SQLite `WHERE external_event_id IS NOT NULL`，合同全量；t19g 判定两者等价）。
- 42 张表列序不同、9 + 3 条唯一的物理表示不同：只影响 v2 合同 digest，不影响行为。

### M4.2 方案（总体）

| 方案 | 后果 |
| --- | --- |
| **A 逐条裁决到两侧一致的原生表达** | 满足 G4；需要合同支持少量类型化行级规则 |
| B 全部取 PG 现状（删掉 SQLite 独有保护） | SQLite 侧不变量变弱，记忆删除行为变化 |
| C 全部取 SQLite 现状（含任意触发器） | 合同重新允许无类型触发器，回到「两份实现同一不变量」 |

### M4.3 推荐：A，逐条

| 项 | 目标裁决（两 provider 一致） | 转换器 |
| --- | --- | --- |
| `rfc328_tasks_lineage_after_insert` | 删除；lineage 推导留在任务创建 participant（领域函数），`task_launch_contexts.execution_lineage_id / lineage_slot_path_json` NOT NULL；结构守卫「只有一个任务创建 participant」（替代 `rfc359-w7-task-insert-lineage-completeness`） | 源行 NULL 时按 0210 的规则补齐，记 `legacy-derived` |
| `trg_tasks_launch_origin_inherit_child` | 删除；子任务继承父任务 launch origin 由创建 participant 保证，NOT NULL | 校验父子一致；不一致记证据，在途任务阻塞 |
| `runtime_session_leases_reset_pending_*` | 删除触发器，改为两侧原生 CHECK（`reset_pending` 为 bool codec；`reset_pending = false OR lease_node_run_id IS NOT NULL`） | 无 |
| `trg_collaboration_gate_operations_committed_immutable` | 保留不变量：合同新增类型化行级规则 `immutableOnceSet(columns, when)`，两侧编译为原生触发器（PG 触发器函数），错误统一映射为 `human-gate-committed-receipt-immutable` | 无 |
| `user_access_audit_no_update / _no_delete` | 保留不变量：类型化规则 `appendOnly(table)`，两侧原生 | 无 |
| `development_missions.reopened_from_mission_id` | 两侧 FK，NO ACTION | 悬空引用记证据、阻塞 |
| `memories.supersedes_id / superseded_by_id` | 两侧 FK，`ON DELETE SET NULL` | PG 源中的悬空指针置空并记证据（Q4） |
| `node_runs.container_run_id` | 两侧 FK，NO ACTION（同任务内；任务删除整体级联） | 按依赖拓扑插入或校验后启用；悬空 → history-only + 证据，在途阻塞 |
| `repo_group_nodes.child_group_id` | 两侧 FK，NO ACTION（应用先解除引用） | 悬空引用按应用的解除规则（清空挂载字段）处理并记证据 |
| `task_collaborators.added_by` | 两侧 FK，规范为 NO ACTION（原声明 SET NULL 与 NOT NULL 矛盾，实际效果等同拒绝删除） | 悬空引用阻塞 |
| `tasks.owner_user_id`、`users.created_by` | 两侧 FK，`ON DELETE SET NULL`（无生产硬删，声明性一致） | 悬空引用阻塞 |
| `tasks.name` | 两侧 NOT NULL | NULL / 空串按 0021 的回落规则 `'task-' || substr(id, -10)` 补齐，记 `legacy-derived` |
| `intent_turn_events` 唯一 | 两侧部分唯一索引 `(turn_id, source, external_event_id) WHERE external_event_id IS NOT NULL`，合同显式声明 NULL 语义 | 无 |
| `code_work_observations` 唯一 | 表归档，目标无表 | 归档 |
| 列序 / 唯一的物理表示 | 由 contribution 单一声明编译，两侧同序同形 | 按列名转换 |

registry 规则同步：不允许无类型触发器；只允许 `immutableOnceSet / appendOnly` 两种类型化行级规则，两侧编译、两侧行为对拍。

### M4.4 设计文档修改

**design.md §2 新增 §2.4「provider 差异的目标裁决」**：粘贴 M4.3 表，并加一句：

> 新 baseline 不含无类型触发器。行级不可变规则只有 `immutableOnceSet` 与 `appendOnly` 两种，由合同声明并在两 provider 上编译为原生实现，错误映射与行为对拍。插入兜底类触发器的不变量由唯一的领域写入者与 NOT NULL 约束承担。

**design.md §12.1 第 3 条「账本中各项的目标裁决留到 II-0」改为：** 「账本中各项的目标裁决见 §2.4」。

**migration.md §4 新增 §4.7「约束对齐」：** 粘贴 M4.3 表「转换器」列的规则（悬空 FK、`tasks.name`、lineage / launch origin 补齐）。

**plan.md §3「schema / codec」行追加：** 正向「两种行级规则在两 provider 上都拒绝改写 / 删除并映射同一错误；8 条 FK 的删除动作两侧一致；记忆删除后引用置空」；反例「合同出现无类型触发器；PG 上可删除 append-only 账本行」。t19g 对账守卫改为「两份编译 DDL 同义」，并补 FK、可空性、默认值的对账。

### M4.5 用户决定

**Q4**（PG 上记忆删除后引用置空）：推荐接受。

---

## M5. 种子行（research-3 §6-5）

### M5.1 事实

- 迁移重放后非空的表只有 4 张（research-3 §2.6 复算）：`users` 1 行（`__system__`，`db/migrations/0018_rfc036_users.sql:64`，`created_at` 取迁移时刻）、`auth_login_policy` 1 行（`0110_rfc221_auth_login_policy.sql:14`）、`committed_event_family_cutovers` 4 行（`0218_rfc341_committed_events.sql:87-91` 以 `legacy, epoch 1` 插入；`0219:242-248`、`0222:23-29` 改为 `dispatchable, epoch 2` 并写固定 `changed_at / change_ref`）、`employee_os_writer_state` 1 行（`0192_rfc310_digital_employee_os_authoring.sql:305`）。
- 依赖重放取种子的三处：托管安装 `seedHostedInstallation`（`platform/persistence/hostedInstallationSeed.ts:37-62, 115-154`）、测试 PG 复位（`tests/helpers/eachProvider.ts:657`）、`createInMemoryDb`（`db/client.ts:448-504`）。
- 投递认领要求 `committed_events.producer_epoch = cutovers.epoch`（`platform/events/committed/deliveryPersistence.ts:82-95`），迁入库的 epoch 必须原值保留；`legacy / shadow` 模式与 cutover 写者无生产调用方（research-4 §10.2）。
- 启动期幂等「ensure」的内建数据（内建工作流含 RFC-396 新增、事件类型目录、runtime 注册、员工模板 / 工具目录、融合资源、demo seed）不是迁移种子；其中 demo seed 仍写退役的 code-work 表（`code-capability/infrastructure/demoSeedPersistence.ts:16-23`）。

### M5.2 方案

| 方案 | 后果 |
| --- | --- |
| **A contribution 声明 `seeds`（仅新装执行）** | 新装、测试 baseline、托管安装同一来源；转换器保留源值并校验必需种子存在 |
| B 种子改为启动期 ensure | 与「新库不跑旧路径」无冲突，但种子与 schema 版本脱钩，测试 baseline 不完整 |
| C 继续靠迁移 SQL | 与 D12 冲突 |

### M5.3 推荐：A

- `SchemaContribution.seeds?: readonly SeedDefinition[]`，`SeedDefinition = { table, key, values, policy: 'install-only' }`；编译进 baseline plan，新装、测试 baseline 与托管安装执行；转换器**不**对已有数据套用种子，只原样转换源行，并在校验阶段断言必需种子存在（缺失则阻塞）。
- 具体：
  - identity-access：`users` 的 `__system__`（`created_at` 取安装时刻）、`auth_login_policy` 单例默认值（与 0110 相同）。
  - platform/committed-events：4 条路由 `(task-execution, task-lifecycle)`、`(collaboration, review | clarify | questions)`，`epoch = 2`，`changed_at / change_ref` 取 0219 / 0222 的常量（新装结果与今天新装逐字节一致）；目标去掉 `mode` 列（只剩可投递一种），转换器要求源 `mode = 'dispatchable'`，否则阻塞。
  - `employee_os_writer_state`：退役，不建表；转换器把其状态写入 activation receipt，并要求源已处于 OS active（drain 完成），否则阻塞。
- 启动期 ensure 保持为启动步骤（幂等、带内容校验），不进 schema 种子；demo seed 改写为目标模型 fixture（design §9 已要求）。

### M5.4 设计文档修改

**design.md §12.1「contribution」条目追加：** 「`seeds`（`install-only`）：只在新装、测试 baseline 与托管安装执行；转换器不套用种子，只校验必需种子存在」。

**design.md §9 第二段末尾追加：** 「目标 `committed_event_family_cutovers` 只保存 `(producer, family, epoch, changed_at, change_ref)`，新装种子取今天新装结果的同值；迁入库原值保留 epoch。」

**migration.md §4.5 第三段末尾追加：** 「源 `committed_event_family_cutovers.mode` 必须全部为 dispatchable，`employee_os_writer_state` 必须处于 OS active，否则阻塞。」

**plan.md §3「源识别」行追加：** 正向「新装、测试 baseline、托管安装三处的种子行逐字节一致」；反例「转换器把种子覆盖到迁入库的已有行」。

### M5.5 用户决定

否。

---

## M6. 跨 epoch 备份恢复（已决，补实现约束）

用户 2026-10-21 已确认切换前的旧 epoch 备份可经转换器在新版本上恢复（proposal §4、migration §2 末行）。实现约束：

- 源种类：epoch-1 SQLite 备份快照（VACUUM INTO + manifest v2，`platform/persistence/sqlite/systemBackupManifest.ts:47-60`）、epoch-1 逻辑工件（`logicalDatabaseArtifact.ts`，PG 备份与迁移工件）、托管备份。三者共用源读者接口（`preflight / assertUnchanged / readChunk`，`logicalDatabaseExport.ts:35`）。
- 恢复 = 一次离线 epoch 转换，产生 `role = restored` 的新代；不再走「换文件 + openDb 前滚」（`sqlite/systemProviderRestore.ts:486-502`）或 additive 行桥（`logicalDatabaseRestore.ts:125-151`）。
- 单机备份今天不含 `runs/ logs/ evidence/`（`tests/backup.test.ts:177`）：恢复时按 migration §4.4 区分「原本已缺失」与「恢复后新丢失」。

**plan.md §3「源识别」行正向追加：** 「epoch-1 SQLite 备份、epoch-1 逻辑工件、托管备份三种源恢复到目标 epoch」。

---

## M7. `migrationRole` 退役（research-3 §6-7）

### M7.1 事实

- `platform/persistence/providerTraits.ts:48, 94, 103`：`migrationRole` 把「源 / 目标」绑在 provider 上（SQLite = source，PG = target）。
- 消费者约 20 处：`generationValidation.ts:33-42`、`main.ts:566`、`bootstrap/daemonStart.ts:478`、`logicalDatabaseExport.ts:170`、`cli/database.ts:91`、`modules/system-operations/application/prepareDatabaseInstallation.ts:41, 51`、`infrastructure/portableDatabaseRestore.ts:132`、`databaseMigrationCoordinator.ts:203, 241, 316, 375, 670, 753, 763, 813`、`postgresqlProviderBackup.ts:82`、`databaseMigrationDaemonAdmission.ts:234, 245, 289`。
- 同族硬编码：`modules/system-operations/domain/databaseMigration.ts:40, 139`、`shared/schemas/databaseMigration.ts:12, 24, 265`、runner 的 `dbg_pg_` 命名（`databaseMigrationRunner.ts:116-118`）与 `reopenSqlite / activatePostgresql`（`:35-53`）、启动序列守卫账本（`tests/architecture/rfc359-w5-t19c-startup-sequence.test.ts:39-46`）。

### M7.2 方案

| 方案 | 后果 |
| --- | --- |
| **A 角色归代次与迁移 run** | 同 provider 迁移（SQLite → SQLite、PG → PG）与备份恢复自然成立 |
| B 保留 `migrationRole` 再加 epoch 轴 | 同一事实两种表达 |

### M7.3 推荐：A

- `database_generations.role ∈ {installed, converted, restored}` 与 pointer v2 的 `role`；迁移 run 记录 `(sourceProvider, targetProvider, sourceEpoch, targetEpoch)`，由支持矩阵（migration §2）校验。
- `generationValidation`：`role ∈ {converted, restored}` ⇒ 必须带 `operationId`（替代按 provider 判断）。
- PG 备份前置条件改为「存在 active generation」，不再依赖 RFC-349 迁移谱系与 `dbg_pg_` 命名。
- admission 方法改名 `reopenSource / activateTarget`；coordinator 的 `assertSqliteSource` 改为按支持矩阵校验源。
- 约 20 处消费者、shared DTO、守卫账本在同一提交改齐。

### M7.4 设计文档修改

**migration.md §3 末段追加：** 「源 / 目标角色属于迁移 run 与代次（`installed / converted / restored`），不属于 provider；`providerTraits.migrationRole` 删除。」

**design.md §10 D10 行「必须删除…」列追加：** 「`providerTraits.migrationRole` 及以 provider 判定迁移角色的全部分支」。

**plan.md §2 T13 行「完整交付」追加：** 「`migrationRole` 退役与约 20 处消费者、shared DTO、启动序列守卫账本同一提交改齐」。

### M7.5 用户决定

否。

---

## M8. T2a 等价标准（research-3 §6-8）

已决（design §12.1 第 1 条：逐字节为目标，做不到时以规范化相等兜底并记录原因，另以两条物理证明兜底）。补一条边界，避免兜底范围被放大：

**design.md §12.1「等价证明」第 1 条末尾追加：**

> 规范化只作用于 SQL 表达式文本（CHECK 表达式、索引表达式与部分索引谓词、SQL 默认值表达式），使用 t19g 的 `normalizeSqlText`；表 id、owner、codec、可空性、默认值种类、枚举值、键、列序等其余字段在 canonical JSON 中必须逐字节相等。落到兜底档时，RFC 记录逐项差异清单。冻结的 v2 投影位于 `platform/persistence/migration/legacy/`（该目录已被 `tests/architecture/rfc349-schema-contract.test.ts:132` 的归档消费者普查预留）。

用户决定：否。

---

## 附录 A：合并后的 Task 表族字段归属（替换 design §3.2 用）

§1、§4、§5、§6 的修改合并后，旧 `tasks` 70 列恰好各有一个去向：

| 目标 | 旧列 | 数 |
| --- | --- | --- |
| `tasks`（生命周期、与生命周期 CAS 同句的可变状态、树结构） | `id, name, status, started_at, running_ms, running_since, finished_at, error_summary, error_message, failed_node_id, auto_recovery_attempts, auto_recovery_suspended, auto_recovery_window_started_at, expires_at, deleted_at, owner_user_id, catalog_visibility, lifecycle_event_revision`；`worktree_path`（→ `workspace_root_ref`，`''` → NULL）；`workspace_pruning_at, workspace_prune_cause, workspace_pruned_at`；`source_termination_fence, source_termination_effect_rev`；`parent_task_id, root_task_id, invocation_depth, branch_started_at` | 28 |
| `task_definitions` | `workflow_id`、`workgroup_id`、`source_agent_id`、`code_round_id`（→ `subject_kind + source_id`）、`source_agent_name`（→ `source_name`）、`workflow_snapshot`、`workflow_version`（→ `source_revision`）、`inputs, max_duration_ms, max_total_tokens, schema_version, ref_closure_json`、`workgroup_config_json`（不可变部分；运行期部分 → `workgroup_task_state.runtime_config_json`）；新增 `definition_origin, engine_kind, definition_revision` | 13 |
| `task_launch_contexts` | `launch_origin, scheduled_task_id, webhook_trigger_id, webhook_fire_id, event_subscription_id, event_delivery_id, digital_employee_round_id, digital_employee_case_id, parent_node_run_id, execution_lineage_id, lineage_slot_path_json, trigger_context_json, platform_input_paths_json, source_termination_binding, source_termination_launch_rev` | 15 |
| `task_workspaces` | `repo_group_id, repo_group_name, git_user_name, git_user_email, auto_commit_push, space_kind, working_branch`；新增 `requested_source, task_branch` | 7 |
| `task_repository_mounts` / `requested_source` / `task_branch`（按 §6 规则） | `repo_path, repo_url, cached_repo_id, base_branch, branch, base_commit` | 6 |
| 派生，不持久 | `repo_count`（`max(1, 挂载数)`） | 1 |
| 合计 | | 70 |

`task_source_termination_states` 不再作为目标表（§4）。`idx_tasks_event_delivery_unique`（事件启动任务恰好一次的线性化点）随 `event_delivery_id` 移到 `task_launch_contexts`，与任务行同事务写入。

## 附录 B：删除清单变更汇总（design §10）

| D | 变更 | 来源 |
| --- | --- | --- |
| D1 | 整行替换（四个宿主、隐性依赖） | §1 |
| D2 | 「保留的真实能力」追加占位 / 失败任务与单仓重新启动 | §6 |
| D3 | 追加 `gitStashSnapshot`、retry 模式、pre-snapshot 只读化 | §7 |
| D4 | 追加比较器兜底、各模块 NX 选择、supersession SQL 孪生；启动期 seq 回填 | §3、§7 |
| D5 | 追加启动期 frame 回填与 CLI 入口 | §7 |
| D10 | 追加 `providerTraits.migrationRole` | M7 |
| D12 | 整行替换（M1）并追加「启动期旧数据升级步骤逐项分类」（§7） | M1、§7 |
| D13（新增） | v1 在途回放载荷的运行时解码与回插；非字面量载荷对象写入被重塑表 | §2 |

## 附录 C：新增 / 修改章节索引

- **design.md**：§2.4（M4）、§3.1 表与第二段（§1、§4）、§3.2 表（附录 A）、§3.3 聚合写协议（§4）、§3.4 任务树（§5）、§4 主仓投影与 checkpoint 段（§6、§9）、§5.1 表（§3、§8、§9）、§5.2 第二、三段（§3、§9）、§5.3 表（§8、§9）、§5.4 选中运行端口（§3）、§5.5 NodeRun 写协议（§4）、§5.6 envelope nonce（§8）、§6.1（§9-e）、§7.3 载荷版本（§2）、§8 API 兼容投影合同（§10）、§9（§5、M5）、§10（附录 B）、§12.1（M4、M5、M8）、§13 schema 演进（M1）。
- **migration.md**：§3 表与末段（M1、M2、M3、M7）、§4.1（§1、§4）、§4.2 表（§6、§12）、§4.3（§9）、§4.5（M5）、§4.6 持久化载荷（§2）、§4.7 约束对齐（M4）、§5 第 8 步（M3）。
- **table-mapping.md**：§2 `workflows`（§1）、`tasks`（§4）、`workgroup_task_state`（§4）；§3「Task 分层」（§4）、「迁移元数据」（M2）。
- **plan.md**：§2 T1（§7）、T13（M1、M7）、T15（§10）；§3 新增「聚合写协议」「持久化载荷」「API 投影对拍」三行并扩充 Task 主体 / 工作区 / NodeRun / 协作 / schema / 源识别 / 转换恢复 / 激活行；§6.2 新增 II-pre 行并补 T6 开发顺序（§3、§13）；§6.4 第 2、12、13 条改写。
- **proposal.md §4**（按 Q 的答复）：Q3 接受时在「数据库备份与恢复」行补「单机 SQLite 业务库位置由 generation pointer 指定（`databases/<generationId>/db.sqlite`）」；Q4 接受时补「PostgreSQL 部署删除记忆后，其他记忆中的引用置空（与 SQLite 一致）」；Q1 若选择退役共享记忆作用域，须在本表新增能力收缩行并重新确认。
