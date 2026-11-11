# RFC-485 设计

落点：task-execution 的 `application/ports`（闭合读取接口）与 `public/types`、`composition`；collaboration 的 `infrastructure`（绑定与调用点）；
memory 的 `composition` 与 `infrastructure`（装配输入与两个存储）；bootstrap 的绑定与 memory 模块装配。三条依赖都在目标 DAG 内
（collaboration → task-execution、memory → task-execution，`tests/architecture/rfc294Target.ts`）。

## 1. 现状（HEAD `067169518`，源码实读与语法树普查）

- **交出面**：`modules/task-execution/public/queries.ts` 第 28 行包一层导出 `createNodeRunQueries(db)`，第 107～108 行转出
  `createNodeOutputQueries`、`createTaskGateQueries`，并以类型交出 `NodeRunQueries`、`NodeOutputQueries`、`NodeOutputContent`、`TaskGateQueries`。
  `PUBLIC_SURFACE_DEBT`（`rfc294-architecture-preflight`）记着三个工厂签名里的 `PersistenceDb`（第 437、443、456 行）。
- **接口**（`application/ports/`）：`NodeRunQueries` 16 个方法，`NodeOutputQueries` 5 个，`TaskGateQueries` 4 个。
- **模块外的使用**（普查脚本按调用点统计）：
  - `NodeRunQueries`：`list` 13、`readFields` 8、`listFields` 5、`listDispatchFacts` 5、`humanGateProjection` 3、`read` 3、`listHistoryFields` 3
    （memory 2）、`listWithCheckpoints` 2、`readWithCheckpoints` 1、`listHistory` 1、`listHistoryDispatchFacts` 1、`latestHistoryPerNode` 1（memory）
    ——12 个方法；`heldSession`、`heldSessionRunIds`、`listResumeRuns`、`latestPerNode` 只在 task-execution 内部用；
  - `TaskGateQueries`：`listContexts` 15、`listDefinitionContexts` 13、`listDispatchContexts` 4、`visibleTaskIds` 2——全部 4 个；
  - `NodeOutputQueries`：`runsWithOutput` 4、`readPort` 3、`listPorts` 1、`listActiveContents` 1（memory）；`listProducedPorts` 只在内部用。
- **类型名的使用**：`NodeRunQueries`、`NodeOutputQueries`、`NodeOutputContent`、`TaskGateQueries` 在模块外没有按名字引用（只用工厂的返回值）；
  行形状类型 `NodeRunFactSnapshot`、`NodeRunCheckpointSnapshot`、`NodeRunDispatchFacts`、`TaskGateContext`、`TaskGateDefinitionContext` 有 2～3 个
  文件按名字使用。
- **绑定在手的范围**：collaboration 62 个函数里 16 个（33 处）已有 `TaskExecutionParticipantBindings`；余下的调用链有几条一直到 bootstrap
  构造的入口（任务访问端口、命令上下文、clarify 答案查询、已提交事件投影等）。
- **memory**：`composition.ts` 第 154～155 行 `new DrizzleMemoryDistill{Read,Work}Store(input.db, input.clarifyAnswers)`，第 116 行
  `composeMemoryInjectionQueriesFor(db)` 造注入读存储；bootstrap `daemonModules/memory.ts` 第 21、25 行用根 db 造注入查询与
  `clarifyAnswers`。memory 调 task-execution 查询用的都是这个根 db。

## 2. 机制与落位

- **闭合读取接口**（task-execution `application/ports`）：
  - `nodeRunQueries.ts`：`export interface TaskNodeRunReads`——上面 12 个方法的签名，原样搬过来；`NodeRunQueries extends TaskNodeRunReads`，只再声明
    4 个内部方法；
  - `nodeOutputQueries.ts`：`export interface TaskNodeOutputReads`——`readPort`、`listPorts`、`runsWithOutput`、`listActiveContents`；
    `NodeOutputQueries extends TaskNodeOutputReads`，再声明 `listProducedPorts`；
  - `TaskGateQueries` 四个方法都被用到，原样作为闭合接口。
- **交出面**：`public/types` 交出 `TaskNodeRunReads`、`TaskNodeOutputReads`、`TaskGateQueries`；`public/queries` 撤出三个工厂与
  `NodeRunQueries`、`NodeOutputQueries`、`NodeOutputContent` 的类型转出，`TaskGateQueries` 的转出移到 `public/types`（留注释说明去处）；行形状
  类型照旧交出。
  `composition.ts` 转出三个工厂（RFC-482 的做法），供 bootstrap 与用例取用。
- **collaboration**：`TaskExecutionParticipantBindings` 增 `createNodeRunQueries(db): TaskNodeRunReads`、`createTaskGateQueries(db): TaskGateQueries`、
  `createNodeOutputQueries(db): TaskNodeOutputReads`；bootstrap 的 `composeTaskExecutionParticipantBindings` 补上。调用点改成
  `<绑定>.createX(<原句柄>)`；手里没有绑定的函数沿调用链加一个绑定参数，直到已有绑定的函数或 bootstrap 的装配点（由 bootstrap 交入
  `closure.taskExecutionParticipants`）。确切的接线清单以实现时 `tsc` 报出的调用点为准，记在 §6。
- **memory**：装配输入增 `taskNodeRuns: TaskNodeRunReads` 与 `taskNodeOutputs: TaskNodeOutputReads`；蒸馏工作存储（`DrizzleMemoryDistillWorkStore`）与注入读存储（`DrizzleMemoryInjectionReadStore`）改收它们，
  不再自己调工厂；bootstrap 的 memory 模块用根 db 从 task-execution 的 composition 建好交入（与 `clarifyAnswers` 同一条路）。memory 只在根 db
  上读，所以交实例即可、不必交工厂。

## 3. 账本与计数

- `PUBLIC_SURFACE_DEBT` 销 3 条；`public-surface-deviations` 68 → 65。
- task-execution 与 collaboration 的未消费 public 符号保持 0：新交出的两个闭合接口与 `TaskGateQueries` 由 collaboration 的绑定类型与 memory 的
  装配输入取用；撤出的全量接口名在模块外没有使用者。
- 越 DAG 的 offered 文件对 47、跨 context 内部文件对 43 不变。
- 先用字面量扫描（`docs/dev-gotchas.md`「`tsc` 只看 import」一条的补充）对 HEAD 与候选找出受影响的源码文本断言，随改动改写。

## 4. 用例

- **新增 RFC-485 用例**（登记 guard-manifest）：
  - task-execution 的 public 文件不导出三个工厂与撤出的全量接口名（值与类型、转出与运行时命名空间都认，带负对照）；
  - collaboration 与 memory 的全部生产文件不从 task-execution 的任何入口取这三个工厂；
  - `TaskExecutionParticipantBindings` 有这三个成员，bootstrap 的绑定取自 task-execution 的 composition；memory 的装配输入有两个读取端口，
    bootstrap 的 memory 模块从 task-execution 的 composition 建它们；
  - `TaskNodeRunReads`、`TaskNodeOutputReads` 只有方法签名，`NodeRunQueries` / `NodeOutputQueries` extends 它们，从 `public/types` 交出；
  - 双引擎行为：经绑定构造的 `createNodeRunQueries(db).list` 与直接构造的读到相同的行。
- **既有用例**：取这三个工厂的用例改取 task-execution 的 composition；调用新加了绑定参数的函数的用例补传
  `tests/helpers/taskExecutionParticipantBindings.ts` 的绑定（语法树 codemod，沿用 RFC-482 的脚本）；构造 memory 存储的用例补传端口。

## 5. 失败模式

- **事务里的读换了连接**：collaboration 交的是工厂，每个调用点仍用原来的句柄构造，事务边界不变。memory 交实例，前提是它只在根 db 上读
  （§1 已核对：句柄都是装配时的根 db）。
- **漏传的调用链**：缺参数由 `tsc` 报出；模块外取三个工厂的残留由 RFC-485 用例报出。
- **文本断言的账本**：按 §3 末条先扫后改；集中验证先跑 `tests/architecture/` 与读源码文本的用例，再上全量。两边都超时的用例单独拿到真结果。
- **装配顺序**：bootstrap 的 memory 模块需要在 task-execution 的读取能建出之后装配；它们只依赖根 db 与 task-execution 的 composition 工厂，
  不依赖 task-execution 的运行时状态。

## 6. 实施中的细化

- **开门参与者的事务内读取不经绑定**：collaboration 的开门参与者（`DatabaseHumanGateOpenParticipantInTx`）的事务内依赖，本来就由
  task-execution 在调 `HumanGateOpenParticipantScope.inTransaction(tx, …)` 时按事务交入（RFC-395 的注入方式）。`taskParticipants` 增
  `nodeRuns: TaskNodeRunReads`，task-execution 的生命周期持久化用同一个 `tx` 建好交入；两个开门投影函数改收它，不再自己构造读取。
- **装配时拿不到完整绑定的两处，参数收窄到用到的工厂**：memory 模块在 task-execution 模块之前装配（`executionPermits` 还没有创建），
  数字员工模块的装配也没有它；它们用到的两个 collaboration 入口改收绑定的子集——clarify 历史投影与答案查询收
  `TaskNodeRunQueryBinding`（`createNodeRunQueries`、`createTaskGateQueries`），已提交人工输入查询收 `createNodeOutputQueries`。完整的绑定照样
  满足这两个子集；bootstrap 从 task-execution 的 composition 直接交这几个工厂。
- **以类实现的存储与评审互斥锁**：`DatabaseReviewMutationScopeResolver`、`DrizzleTaskFeedbackStore`、`DatabaseManualQuestionOpenWriter` 的
  构造参数增绑定；命令上下文的输入增绑定，内部构造的任务访问端口、评审任务访问端口、手动提问写入器与反馈存储都取它。评审互斥锁
  `withReviewNodeMutationLock` 的来源参数从「解析器或 db」改为「解析器或 `{ db, taskExecutionParticipants }`」，带 db 与绑定的参数对象直接传。
- **bootstrap 的绑定各算一次**：`daemonHttpComposition`（任务访问端口与协作路由操作）与 `daemonSession`（已提交事件投影与人工门终态清扫）
  各自只调一次 `composeTaskExecutionParticipantBindings`，两处共用同一个对象。
- **接线**：src 的调用点按 `tsc` 报错逐层补齐，五轮收敛（首轮 432 个报错，其中 src 约 80 处）；已有绑定的 16 个函数里 33 处调用改写，
  其余函数加绑定参数或在参数对象里加字段。用例侧：从 public 取这三个工厂的 5 个文件改取 composition；调用新加了参数的函数的用例由语法树
  codemod 补传 helper 的绑定、给 memory 存储补传读取端口（70 个文件、681 处）；6 个用例手改（`@ts-expect-error` 的位置、互斥锁来源的比较、
  memory 装配合同的选项、伪造绑定的新成员与带查询计数的 task-gate 读取）。
- **tsc 看不到的文本断言**：字面量扫描（对照 HEAD `4c416ad75`）找出 3 处并改写——`rfc395-clarify-answer-boundary`（memory 模块构造 clarify
  答案查询的写法，改为容忍换行的正则）、`rfc395-task-definition-boundary`（开门参与者构造参数的正则加 `participants.nodeRuns`，并断言生命周期
  持久化交入 `nodeRuns`）、`rfc128-p5-d-autodispatch`（预检调用的定位文本）；`rfc395-a3-site-regressions` 的 B5 从源码抽出执行的两个函数多了
  绑定参数，调用随之加参，原先以自由变量注入的假读取改由绑定参数交入。
- **集中验证查出的两处**：`rfc395-serialized-insert-source-locks.json` 钉着 `seal.ts` 的 sha256，随 seal 事务里的 node-run 读取改经绑定构造而
  更新，`why` 补一句评审说明（句柄仍是 seal 事务的 `tx`）；`rfc461` 用假 db 装配整个 memory 模块，node-output 工厂构造时就调 `tablesOf(db)`，
  改成装配期建一次后在装配处抛错，用例改交占位读取（它不走这两条读取）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：闭合读取接口按内容落在 task-execution 的 `application/ports`；collaboration 的绑定与 memory 的装配输入都是消费侧的装配形状。
- **C11**：task-execution 的 public 撤 3 个工厂与 3 个类型名（`NodeRunQueries`、`NodeOutputQueries`、`NodeOutputContent`）、增 2 个闭合接口，
  `TaskGateQueries` 从 `public/queries` 移到 `public/types`；
  collaboration 与 memory 的 public 不变。
- **C12**：RFC-485 用例覆盖 task-execution 的全部 public 文件、collaboration 与 memory 的全部生产文件、bootstrap 的绑定与 memory 模块装配。
- **C13**：触及的减速带收紧到实测。
- **取舍（可推翻）**：
  1. 沿用 RFC-400 / RFC-482 的绑定对象，不另立只装查询的绑定（同一份装配输入、同一条传递路径）；
  2. 闭合接口按「模块外实际用到的方法」划，不按调用方再细分成多个小接口——collaboration 的使用分散在 24 个文件，细分只会让绑定变宽；
  3. memory 交实例而不是工厂：它只在根 db 上读，交实例让 memory 的两个存储不必知道持久化句柄如何构造读取，也与 `clarifyAnswers` 一致。
