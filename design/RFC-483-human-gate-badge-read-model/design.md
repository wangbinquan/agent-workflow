# RFC-483 技术设计

落位：collaboration（bounded context）的 application（徽标用例与读模型端口）与 infrastructure（徽标读模型、装配期绑定），task-execution 的
composition 与 public（片段改由 composition 转出、撤出 public），bootstrap（绑定的来源）。不改 SQL、schema 与事务边界。

## 1. 现状（HEAD `1fa9be87c`，源码实读）

- **三个片段**（task-execution 的 infrastructure，`public/queries.ts:93`、`:101` 转出；task-execution 内部的 `createTaskGateQueries` 等也用，
  不变）：
  - `taskGateOpenCondition(db, taskId, includeMissing = false, requireSubjectName = false)`（`infrastructure/taskGateQueries.ts:76`）：
    `EXISTS(任务行 ∧ 状态不在 TERMINAL_TASK_STATUSES [∧ 主题名非空])`；`includeMissing` 时再 OR「没有任务行」。主题名经 resource-catalog 的
    `workflowNameExpression` 求值。
  - `taskGateVisibleCondition(db, taskId, viewer)`（`:110`）：`EXISTS(任务行 ∧ taskVisibilityCondition(viewer))`，与 task-execution 的
    `visibleTaskIds` 同一判据（owner 是我，或我在 task_collaborators 里；`canReadAllTasks` 时恒真）。
  - `nodeRunStatusCondition(db, runId, status)`（`infrastructure/nodeRunQueries.ts:596`）：`EXISTS(node_runs 行 ∧ status = ?)`。
- **使用点**（模块外只有这两个函数，7 处）：
  - `collaboration/infrastructure/review.ts#countPendingReviews(db, actor?)`（`:2039`）：待决的评审版本、同 (run, port) 没有更新的待决版本；
    actor 存在且没有 `tasks:read:all` 时加「任务可见 OR 我是该评审节点的评审人」；`nodeRunStatusCondition(…, 'awaiting_review')`；
    `taskGateOpenCondition(…, false, true)`。
  - `collaboration/infrastructure/clarifyRounds.ts#countAwaitingClarifyRounds(db, actor)`（`:202`）：等人工的澄清轮次；
    `taskGateOpenCondition(…, canReadAllTasks)`（看全部任务的人连没有任务行的轮次也计）；没有 `tasks:read:all` 时加可见性；已归档的轮次以
    内联 `VALUES` 关系计入，同样两条条件（`includeMissing` 恒为 false）。
  - 调用方：`collaborationRouteOperations.ts` 的 `reviews.countPending`、`clarify.countPending`（懒加载两个模块），实现 application 端口
    `CollaborationRouteOperations`；HTTP 入口 `routes/reviews.ts:208`、`routes/clarify.ts:219`。
- **用例**：`rfc311-badge-counts`（对拍旧的列表 + 过滤管线）、`rfc359-w56-badge-round-trip-budget` / `rfc359-w57-clarify-badge-round-trip-budget`
  （各 actor 形态恒发一条语句），另有 `rfc202-lifecycle-exits`、`rfc395-a2-task-subject`、`rfc319-task27-de28-manual-retry-and-host-anchor`、
  `rfc395-q1-clarify-history`、`review-state-machine`、`rfc340-review-access` 直接调这两个函数；`rfc395-a7-owner-queries` 从 task-execution 的
  public 取两个 task gate 片段做行为用例。
- **表归属**：两个计数引用的表都属于 collaboration（`doc_versions`、`review_node_reviewers`、`clarify_rounds`）；task-execution 的表只在三个
  片段里出现。

## 2. 机制与落位

1. **task-execution**：composition 转出三个片段（同一函数）；`public/queries` 撤出并留注释。
2. **装配期绑定**（collaboration infrastructure）：`TaskExecutionParticipantBindings` 增三个成员，类型照 task-execution 函数的签名写
   （drizzle `SQL` / `AnyColumn`、`PersistenceDb`、`NodeRunStatus`，都在 infrastructure 内）；读模型侧以
   `HumanGateBadgeTaskScope = Pick<TaskExecutionParticipantBindings, 三个成员>` 声明用到的部分。bootstrap 的
   `composeTaskExecutionParticipantBindings`（跨 context 闭包）与用例 helper 补上。
3. **application（D14）**：
   - `application/ports/humanGateBadgeReadModel.ts`：`HumanGateBadgeViewer`（`{ kind: 'all-tasks' }` 或 `{ kind: 'task-member'; userId }`）与
     `HumanGateBadgeReadModel`（`countPendingReviews(viewer)`、`countAwaitingClarifyRounds(viewer)`），只有 DTO。
   - `application/humanGateBadges.ts`：`humanGateBadgeViewer(actor?)`——没有 actor 或带 `tasks:read:all` 的看全部任务，其余按任务成员；
     `countPendingReviewBadge(readModel, actor?)`、`countAwaitingClarifyBadge(readModel, actor)`。
4. **徽标读模型**（collaboration infrastructure）：两个计数函数改收 `(db, taskScope, viewer)`，语句与条件次序逐字不变，谓词改从 `taskScope`
   取；查看者分支与原来的 actor 分支一一对应（all-tasks ⇔ 原「没有 actor 或带 `tasks:read:all`」；澄清在 all-tasks 下仍连没有任务行的轮次
   一起计）。`createCollaborationRouteOperations` 用手里的绑定组出一个 `HumanGateBadgeReadModel`（照旧懒加载两个模块），两个 `countPending`
   改调 application 的用例。
5. **行为**：SQL 与往返数不变；查看者判定是纯函数。

## 3. 账本与计数

- `PUBLIC_SURFACE_DEBT` 销 8 条（三个片段的持久化句柄与 drizzle 类型）；`public-surface-deviations` 65 → 57（两个模块的 public 上 19 → 11），
  `counts.json` 收紧到实测。余下 11 条都在 task-execution 的 public 上，消费方是 memory、integration、workspace-insight、resource-catalog、
  bootstrap 或没有消费方，属于 S9 的其他 context 对。
- guard-manifest 登记 RFC-483 用例。
- 表归属账本不变：读模型不引用 task-execution 的表，task-execution 的谓词也不引用 collaboration 的表。
- 跨 context import、未消费 public 符号与越 DAG 文件对按实测记（预期 collaboration 取 task-execution `public/queries` 的片段 import 撤掉，
  bootstrap 取 composition 的增加；未消费仍 91）。

## 4. 用例

- **新增** `tests/rfc483-human-gate-badge-read-model-boundary.test.ts`：
  1. task-execution 的 public 文件不导出三个片段（转出与本地声明、值与类型都认，带正对照）；
  2. collaboration 的全部生产文件不从 task-execution 的任何入口取三个片段（命名 import、别名、相对路径、命名空间成员与 re-export 都认；
     带负对照）；
  3. 绑定有三个成员，bootstrap 取自 task-execution 的 composition；
  4. 徽标读模型端口只有 DTO 签名（不出现 drizzle、`PersistenceDb`、`SQL`、`AnyColumn`），查看者判定在 application，两个路由操作调
     application 的徽标用例；
  5. 行为（双引擎）：查看者判定的三种形态；经绑定的读模型与直接用 task-execution composition 的谓词计数相同。
- **改动**：调两个计数函数的用例改传绑定与查看者（语法树 codemod）；`rfc395-a7-owner-queries` 改取 composition；w56 / w57 的判据（恒一条
  语句）不变、调用随签名改；`rfc311` 的对拍不变。`tsc` 看不到的文本断言按 RFC-482 的做法用字面量扫描对 HEAD 与候选核一遍。

## 5. 失败模式

- **查看者判定漂移**：原分支写在 SQL 旁边，迁到 application 后一一对应；行为用例与 `rfc311` 对拍兜底。
- **往返数回升**：判据不变的 w56 / w57 报出。
- **谓词不同源**：绑定交的是 task-execution 的同一函数，不是复制；徽标与 `visibleTaskIds` 仍共用同一段可见性代码。
- **文本断言**：按 §4 末条先扫后改；集中验证先跑 `tests/architecture/` 与读源码文本的用例，再上全量。

## 6. 实施中的细化

- **绑定成员的类型**：三个成员照 task-execution 函数的签名写（`taskGateOpenCondition` 的两个布尔参数仍可省），bootstrap 直接交
  task-execution composition 转出的同一函数；读模型侧的 `HumanGateBadgeTaskScope` 是这三个成员的 `Pick`，路由操作交的是整份绑定。
- **路由操作里的读模型**：`createCollaborationRouteOperations` 用 `Object.freeze<HumanGateBadgeReadModel>({ … })` 组出读模型（标注在
  `const` 上时 `Object.freeze` 的泛型推断不把上下文类型传给方法参数，`viewer` 会成隐式 any），两个方法照旧在调用时才懒加载
  `review.ts` / `clarifyRounds.ts`。
- **查看者分支**：澄清计数保留 `canReadAllTasks`（= 查看者是 all-tasks）这个局部量，活跃轮次与归档轮次两段仍用它选分支，与原实现逐行
  对应；评审计数在 task-member 分支里把可见性的 `canReadAllTasks` 写成常量 `false`（原实现在这个分支里求出的也恒为 false）。两个计数
  函数里不再判 `tasks:read:all`（只剩澄清文件头注释里的说明），澄清文件的 `Actor` import 随之删除。
- **用例侧**：调两个计数函数的 9 个用例文件由语法树 codemod 改成 `(db, taskExecutionParticipants, humanGateBadgeViewer(actor?))`（34 处，
  补两个 import）；`rfc395-a7-owner-queries` 的两个 task gate 片段改取 composition；`rfc359-w55` 的伪造绑定补三个不该被调用的成员。
- **tsc 看不到的文本断言**：字面量扫描（对照 HEAD `fb469ce00`）在真实用例里只有 8 条「HEAD 命中、候选不命中」，逐条核对都不是对改动
  文件的断言（用例自己的负对照字符串与 import、旧管线的对拍代码、RFC-483 用例自己的反向断言）；三份钉 sha256 的 fixture 都不含改动的
  文件，`rfc395-selection-semantics-ledger` 记的 `review.ts` 站点按函数名与序号定位、不在改动的函数里。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：读模型端口与查看者判定按内容落在 collaboration 的 application；三个谓词仍在 task-execution 的 infrastructure；绑定是消费侧的装配
  形状。
- **C11**：task-execution 的 public 撤出三个片段、不新增；collaboration 的 public 不变。
- **C12**：RFC-483 用例覆盖 task-execution 的全部 public 文件、collaboration 的全部生产文件、bootstrap 的绑定与 application 的徽标端口。
- **C13**：触及的减速带收紧到实测。
- **偏离**（按 CLAUDE.md §RFC workflow 第 8 条列出；按用户授权记为已批准，可推翻）：S9 第 4 项字面要求「collaboration 不再把
  task-execution 的 SQL 片段拼进自己的查询，评审 / 澄清读取 task 事实改经业务查询」。本 RFC 后，两条徽标计数仍在各自的一条语句里组合
  task-execution 的谓词：谓词不再经 public，而由 consumer 自有的装配期绑定交入，组合点是明确拥有该联合投影的读模型。理由：
  1. AC-11 的单语句预算（w56 / w57 钉住）排除了返回 DTO 的业务查询——那就是 RFC-359 消掉的三段式；
  2. 另两种单语句做法都更差：读模型直接引用 task-execution 的表，会让 collaboration 依赖任务表结构、复制可见性判据（与 `visibleTaskIds`
     两条路会漂），并扩大只减不增的表归属账本；由 task-execution 拥有联合投影，则要反向引用 collaboration 的表（越出目标 DAG），并让它知道
     评审版本与评审指派的语义；
  3. RFC-294 design §3.3 允许联合投影「由读模型 adapter 明确拥有」，D15 把 consumer 自有的 required 端口列为按业务目的定义的窄合同；本 RFC
     的绑定只装这三个谓词、只服务两条徽标计数。

  Done 文档在 RFC-294 plan S9 第 4 项下记这条裁决。

- **取舍（可推翻）**：
  1. 沿用 RFC-400 / RFC-482 / RFC-485 的绑定对象，不另立只装谓词的端口（同一份装配输入、同一条传递路径）；读模型侧用 `Pick` 切片声明
     用到的三个成员；
  2. 读模型留在原文件（`review.ts`、`clarifyRounds.ts`）：两条计数与同文件的列表查询逐条对照（注释写明谓词一一对应），搬走会拆开这份对照；
  3. 查看者只分两种（看全部任务 / 按任务成员）；评审的「另加节点指派」是评审读模型自己的条件，不进查看者 DTO。
