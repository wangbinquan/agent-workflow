# RFC-301 任务启动来源归一与筛选补全 — 技术设计

状态：**Implementing（2026-08-14，用户已批准完整实现与提交上库）**

## 1. 当前事实与缺口

### 1.1 查询契约只有两种真实来源

`packages/shared/src/taskOperations.ts` 当前定义：

```ts
export const TASK_LIST_ORIGINS = ['all', 'manual', 'scheduled'] as const
```

前端 `packages/frontend/src/routes/tasks.tsx` 已经直接用该常量渲染筛选 Dialog 中的共享
`Segmented`，因此 UI 缺项不是独立组件问题，而是 shared contract 本身不完整。

### 1.2 后端把“没有定时 ID”等同于“手动”

`packages/backend/src/services/taskOperations.ts` 的来源谓词当前等价于：

```sql
manual    => scheduled_task_id IS NULL
scheduled => scheduled_task_id IS NOT NULL
```

`tasks` 表其实已经有 `scheduled_task_id`、`webhook_trigger_id`、`webhook_fire_id` 与冻结
`trigger_context_json`，但没有一个可以表达 direct API 的字段。继续在读端拼条件会产生三份问题：

- Webhook 被 manual 条件吞掉；
- API 没有可用的持久证据；
- 子任务的局部 trigger 字段不等于整棵任务树的启动来源。

### 1.3 可信输入已经存在，但散落在不同路径

- `ActorSource = session | pat | daemon` 位于 `packages/backend/src/auth/actor.ts`；
- `ExecutionInvoker = user | scheduled | node | webhook` 位于 execution service；
- tasks/agents/workgroups HTTP routes 以 `user` invoker 进入统一 execution 入口；
- scheduled/webhook invoker 在 execution dependency builder 中注入各自元数据；
- call 子任务通过 `callLaunch` 进入 `startTask`，创建事务已经读取父任务状态；
- Fusion 创建与驳回后重启会直接调用 `startTask`，是统一 execution invoker 之外的生产根入口。

RFC-301 不再添加一套来源推断，而是把以上两个可信维度在根任务写入前收敛成一个值，并让子任务从
父行继承。

## 2. 领域模型与共享契约

### 2.1 枚举

shared 先提供 frontend/backend query 都要消费的中性闭合 literal/codec，并由列表筛选常量组合：

```ts
export const TASK_LAUNCH_ORIGINS = ['manual', 'scheduled', 'webhook', 'api'] as const
export type TaskLaunchOrigin = (typeof TASK_LAUNCH_ORIGINS)[number]

export const TASK_LIST_ORIGINS = ['all', ...TASK_LAUNCH_ORIGINS] as const
export type TaskListOrigin = (typeof TASK_LIST_ORIGINS)[number]
```

这些 literal 的业务语义、归约与写入 invariant 仍由 `task-execution/domain` 拥有；shared 只承载中性
contract/codec，并以 parity test 锁 domain value object 与这四个 literal 1:1。`TaskLaunchOrigin` 是持久事实；
`TaskListOrigin` 是 query contract。`all` 永远不允许写入数据库。

### 2.2 语义矩阵

| 创建上下文                          | 根任务来源 | 子任务来源               |
| ----------------------------------- | ---------- | ------------------------ |
| `user` + session actor              | manual     | 不适用                   |
| `user` + PAT actor                  | api        | 不适用                   |
| `user` + daemon actor               | api        | 不适用                   |
| scheduled invoker                   | scheduled  | 不适用                   |
| webhook invoker                     | webhook    | 不适用                   |
| node/call invoker（任意技术 actor） | 不建根     | 读取并继承 parent 的来源 |
| Fusion + session actor              | manual     | 不适用                   |
| Fusion + PAT/daemon actor           | api        | 不适用                   |

Scheduled/Webhook 的业务 invoker 优先；不能先把 daemon actor 映射成 API 再遗漏覆盖。恢复、retry、resume
都继续操作同一个 task row，不重新计算来源。

### 2.3 不进入公开 wire

`launchOrigin` 只存在于 shared 内部类型、DB schema 与查询条件；启动链携带的是闭合
`TaskLaunchProvenance`，不接受调用点直接指定最终值。以下接口不增加字段：

- task create/update request；
- `Task` / `TaskSummary`；
- TaskOperations 列表 item；
- 任务详情投影。

这既避免客户端伪造，也避免为了一个筛选条件扩大全部读模型。现有 `scheduledTaskId` 与 RFC-298 的
Webhook 来源链接投影原样保留。

## 3. 持久化设计

### 3.1 新列与约束

在 `tasks` 增加：

```sql
launch_origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (launch_origin IN ('manual', 'scheduled', 'webhook', 'api'))
```

本 RFC **不新增来源索引**。当前 TaskOperations 先把 actor-authorized `base` CTE 标成
`MATERIALIZED`，再在 `non_view_matches` 上应用来源/status/subject/scope/search；`(launch_origin,
started_at,id)` 因而无法参与 tasks 表扫描，只会增加每次 task INSERT 的写放大。为保留不匹配 parent 的 context
分支，本 RFC 也不把来源条件错误地下推并裁掉 `base`。未来若整体重写列表 query、能以 query-plan 实证使用该索引，
再随该性能改动落地。

实现开工时从已提交 migration journal 分配下一个空闲编号，不在 RFC 中预占 `0155`；同时更新
Drizzle schema、journal、schema snapshot 与 rolling-upgrade 计数/列断言。

### 3.2 子任务继承 trigger

为守住 mixed-version/code rollback，migration 同时增加 task-execution-owned trigger：

```sql
CREATE TRIGGER trg_tasks_launch_origin_inherit_child
AFTER INSERT ON tasks
WHEN NEW.parent_task_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tasks parent
    WHERE parent.id = NEW.parent_task_id
      AND parent.launch_origin <> NEW.launch_origin
  )
BEGIN
  UPDATE tasks
  SET launch_origin = (
    SELECT parent.launch_origin FROM tasks parent
    WHERE parent.id = NEW.parent_task_id
  )
  WHERE id = NEW.id;
END;
```

新 application writer 仍在 INSERT 前验证并显式写相同值；trigger 是同一创建事务内的旧-writer兼容围栏，
不是第二套业务判定。旧 binary 在新 schema 上插入 child 时虽然先得到默认 manual，trigger 会立即改成 parent
来源；新 writer 根 + 旧 writer child 因此不会形成混合树。缺 parent 的异常 raw INSERT 不由 trigger 人造来源，
继续交给 FK/application gate。

### 3.3 历史回填

迁移在一个事务内执行，顺序固定：

1. 新列默认把所有现有行置为 `manual`；
2. 对根/局部行按持久证据计算候选：有合法 webhook 证据则为 `webhook`，否则
   `scheduled_task_id IS NOT NULL` 则为 `scheduled`，其余保持 `manual`；
3. Webhook 证据只接受现有 `webhook_trigger_id` / `webhook_fire_id`，或严格合法的 canonical
   `trigger.webhook.*`：migration SQL 镜像 `TriggerContextSchema`，检查三层 object、只允许
   `TRIGGER_CONTEXT_FIELDS`、所有 leaf 都是 text，且 `event_type` 属于 `CODE_HOST_EVENT_TYPES`；不能只因任意
   JSON 出现同名 key 就命中。常量漂移测试把 SQL allowlist 与 shared closed constants 对拍；
4. 从 `parent_task_id IS NULL` 的根开始，用递归 CTE 把根的候选来源写到全部可达后代，覆盖后代
   自己的局部候选；
5. 与根断开的悬空行、无根循环保持第 2 步的最佳局部候选/默认值。递归使用去重语义且不从异常行
   人造根，保证迁移终止；
6. 不尝试回填 API。现有表中 session/PAT/daemon 直接启动没有可证明的逐任务关联，猜测 owner、时间
   或审计事件都不满足来源事实要求。

若某个历史后代局部含 webhook context、但其根是 scheduled，则最终来源仍是 scheduled；来源描述的是
启动整棵树的入口，不是当前节点可访问的模板上下文。

### 3.4 不可变性

application 代码只有初始 `INSERT` 写 `launch_origin`；唯一 UPDATE 是上节 migration trigger 对**刚插入 child**
做同事务继承。不新增服务更新方法，也不允许 resume/retry/recovery 修改。测试棘轮锁定 production TypeScript
没有 `UPDATE tasks SET launch_origin`，并锁 trigger 只能按 `NEW.id` 从 exact parent 复制。

## 4. 写入链路

### 4.1 根任务统一判定

task-execution domain 新增无 I/O 的闭合归约：

```ts
type DirectTaskInitiator = 'manual' | 'api'

type TaskLaunchProvenance =
  | { kind: 'direct-json' | 'direct-multipart' | 'fusion'; initiator: DirectTaskInitiator }
  | { kind: 'schedule' }
  | { kind: 'webhook' }

function deriveTaskLaunchOrigin(provenance: TaskLaunchProvenance): TaskLaunchOrigin {
  if (provenance.kind === 'schedule') return 'scheduled'
  if (provenance.kind === 'webhook') return 'webhook'
  return provenance.initiator
}
```

可信 inbound/legacy execution adapter 先把认证结果投影成 `DirectTaskInitiator`：session → manual，PAT/daemon
→ api。Domain 不 import `Actor` 或 `ActorSource`。execution 入口再把该值与 `ExecutionInvoker` 收敛成 provenance：

- `scheduled` → `{kind:'schedule'}`；
- `webhook` → `{kind:'webhook'}`；
- `user` → 当前 direct lane + `{initiator}`；
- `node` 不生成 root provenance，交由创建事务继承 parent。

tasks、agents、workgroups 路由继续使用当前统一 execution 入口；无需按 endpoint 重复判断。Fusion 的
route 在 actor 仍用于授权的同时，把 inbound 已解析的 `DirectTaskInitiator` 传给 create 与 reject/relaunch；
`services/fusion.ts` 只组 `{kind:'fusion',initiator}`，不读取 token/`actor.source`。生产根入口清单加入 source
ratchet：新增绕过 execution 的 `startTask` 调用必须显式提供 root provenance，不能靠默认值静默上线。

内部测试 helper 或非生产 fixture 若未传 provenance，根任务可默认
`{kind:'direct-json',initiator:'manual'}`，以保持测试构造简洁；该默认值不得被生产根入口依赖。

### 4.2 子任务在父读取事务内继承

`startTask` 当前已经在子任务初始 INSERT 的同一事务中读取 parent 状态。扩展这次 SELECT 读取
`parent.launch_origin`，最终写值为：

```ts
const persistedOrigin = parentTaskId
  ? parent.launchOrigin
  : deriveTaskLaunchOrigin(deps.launchProvenance ?? TEST_ONLY_MANUAL_PROVENANCE)
```

规则：

- 有 parent 时，父行来源是唯一权威值；调用方不能覆盖；
- 若 `callLaunch` 同时携 root `launchProvenance`，作为内部 invariant error 在 INSERT 前失败；
- parent 不存在/不可启动继续沿用现有错误，不单独降级为 manual；
- 父来源与初始子行在同一事务内读取/写入，避免并发子任务看到临时状态；
- `launch_origin` 之后不可变，所以并发创建多个子任务都得到同一值。

这同时覆盖 workflow 与 workgroup call、多层嵌套以及 webhook context 已由 RFC-292 冻结继承的路径。

### 4.3 根元数据一致性

在 initial INSERT 前增加内部断言：

| 根 provenance | 必需证据                                                                     | 禁止的冲突证据               |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| schedule      | non-empty `scheduledTaskId`                                                  | Webhook IDs/context          |
| webhook       | non-empty `webhookTriggerId` **且** `webhookFireId` **且** canonical context | `scheduledTaskId`            |
| direct/manual | trusted session 投影                                                         | Scheduled/Webhook 根归属字段 |
| direct/api    | trusted PAT/daemon 投影                                                      | Scheduled/Webhook 根归属字段 |
| fusion/manual | trusted session 投影                                                         | Scheduled/Webhook 根归属字段 |
| fusion/api    | trusted PAT/daemon 投影                                                      | Scheduled/Webhook 根归属字段 |

历史回填可以凭任一 durable Webhook 证据尽力分类；**新写入不沿用这份宽松 OR**。当前 Webhook invoker 已同时
要求 trigger ID、fire ID 和 `TriggerContext`，少任一项都代表 publication contract 断裂，必须 fail closed，不能创建
“能筛到 Webhook、却没有 delivery/source-link 归属”的半态任务。

子任务只校验 parent 来源，不要求复制全部根级 ID；它可以按现有行为继承必要的 trigger context。这样不会把
“筛选归属”错误耦合成“每个后代必须伪造 webhook fire ID”。

## 5. 查询与分页

TaskOperations 对任意非 `all` 来源使用唯一谓词：

```sql
b.launch_origin = ?
```

`base` CTE 内部增加 `t.launch_origin` 列，`OperationsSqlRow` 可仅为 SQL 类型携带它，`mapRows` 明确不投影到
response。删除 manual/scheduled 的特殊 NULL 推断。既有 view/status/search/subject/scope、facet、树展开与排序
不变。现有 cursor fingerprint 已包含 `origin`，继续确保某来源生成的 cursor 不能在另一来源下复用；新增枚举
测试覆盖 webhook/api 并锁未知值失败。

由于全部后代都继承根来源，查询层无需递归猜根，也不会为来源筛选额外 join parent 表。

## 6. 前端与 i18n

`tasks.tsx` 继续用 shared `TASK_LIST_ORIGINS` 渲染一个 `Segmented`，只扩数据与翻译：

| value     | 中文         | English     |
| --------- | ------------ | ----------- |
| all       | 全部来源     | All origins |
| manual    | 手动启动     | Manual      |
| scheduled | 定时启动     | Scheduled   |
| webhook   | Webhook 触发 | Webhook     |
| api       | API 启动     | API         |

`zh-CN.ts` 的强类型 Resources interface 与中英文对象 1:1 增补。现有 filter state、URL query、Apply/
Reset、关闭与焦点恢复行为不改。

五项在 390px 不强行压成难点按的小字。沿用 `.task-list-filter-dialog .segmented` 的内部横向 overflow，
验证：Dialog/page 无横向溢出、所有项可通过触控滚动与键盘到达、选中项可见、44px 触控高度与浅/深色
对比度不退化。

## 7. 兼容、失败与回滚

### 7.1 新代码 + 新 schema

schema admission 通过后，新代码只读写 `launch_origin`。CHECK 约束阻止未知值；内部一致性失败保留具体
错误和输入来源，不降级为 manual。

### 7.2 旧代码 + 新 schema

默认值保证旧 INSERT 不报错，但旧 writer 创建的所有非手动来源都可能降级为 manual，包括
Scheduled、Webhook、API 与它们的子任务。该窗口是滚动部署兼容降级，不是精确归类承诺；部署完成后
不根据模糊证据补猜 API。

### 7.3 回滚

- 代码回滚不 DROP 列/trigger、不重写已分类记录；
- 旧查询忽略额外列并恢复 manual/scheduled 的旧推断；
- 旧 writer 创建的非手动根会默认 manual；child trigger 始终复制 parent，避免回滚期把已有树拆成两类；
- 再次部署新代码时，已由新 writer 写入的精确来源仍保留；
- 若实现尚未发布，可整体回滚生产/shared/frontend commit，但 migration 仍保持向前兼容。

## 8. 测试设计

### 8.1 Shared 与 schema

- 四个真实来源与 `all` 的 parse/serialize；未知、大小写变体、空值反例；
- DB CHECK、默认值、child-inherit trigger、Drizzle 类型与 migration journal/snapshot；
- mutation test 证明删掉 webhook/api 任一枚举都会打红。

### 8.2 来源写入矩阵

- user+session、user+PAT、user+daemon 三条 direct root；
- scheduled/webhook 在 daemon actor 下仍覆盖为业务来源；
- Fusion create 与 reject/relaunch 的 session/PAT 组合；
- manual/api 根携带 scheduled/webhook 冲突元数据、scheduled 缺 ID、webhook 三件证据缺任一项均失败；
- request body/query/header 注入 `launchOrigin` 不可进入 schema。

### 8.3 树与并发

- 四种根来源各自的一层 workflow child、workgroup child；
- Webhook/Scheduled 的两层混合 call 链仍逐层等于根；
- 多个并发 child 对同一 parent 均继承相同来源；
- dangling parent、已终态 parent 与传入来源冲突保留具体既有/invariant error；
- retry/resume/recovery 不改已落来源。

### 8.4 迁移

旧库 fixture 覆盖 manual、scheduled、webhook ID、canonical webhook context、非法 JSON、局部冲突、
多层树、悬空 parent、无根 cycle。断言：根传播优先、异常行保留最佳局部来源、迁移终止、API 不被
猜测、重复打开升级后的库无二次漂移。

### 8.5 查询、前端与 E2E

- TaskOperations 四来源分别只返回匹配树，组合 view/status/search/subject/scope 条件不漂移；
- cursor fingerprint 对五值隔离，切换筛选重置 cursor，facet/排序稳定；
- frontend 弹窗五项、中英文、Apply/Reset/Escape/focus、390px touch/keyboard/overflow；
- 更新 `e2e/task-operations-fixtures.ts` 的内部来源构造，不向 wire 偷塞未知字段；
- 真实 daemon 中分别经登录 session、PAT、scheduled fire、localhost webhook fire 创建根任务，再由
  browser 应用四个筛选，至少一条触发 call child 并证明树未拆散。

## 9. RFC-294 目标架构落位

### 9.1 Bounded context 与层次归属

本 RFC 是 `task-execution` 的纵切能力；`integration` 与 `identity-access` 只提供各自已经拥有的可信输入，
不拥有任务来源事实。

| 事实/动作                              | 唯一 owner 与层次                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `TaskLaunchOrigin` 语义、值对象与归约  | `task-execution/domain`；shared 只放 frontend/backend 共用的中性 literal/codec                    |
| 根任务 admission、child 继承与不可变写 | `task-execution/application` + task repository port                                               |
| 来源筛选、分页、projection             | `task-execution/application/queries`                                                              |
| `tasks` 列、mapper、trigger 与回填     | `task-execution/infrastructure` schema contribution；migration 编号仍由 platform/persistence 治理 |
| session/PAT/daemon 的可信映射          | inbound binding 消费 identity-access 认证结果                                                     |
| schedule/webhook 来源                  | integration launch source → task public launch contract                                           |
| Fusion 来源                            | knowledge-evolution → task pre-materialized launch contract                                       |
| HTTP/MCP query/DTO                     | inbound adapter，仅解析/映射，不判断来源                                                          |

Domain 不 import `Actor`、Hono、Drizzle、integration/Fusion 类型。用于**根来源归约**的过渡输入只消费
task-owned closed provenance：

```ts
type TaskLaunchProvenance =
  | {
      kind: 'direct-json' | 'direct-multipart' | 'fusion'
      initiator: 'manual' | 'api'
    }
  | { kind: 'schedule' }
  | { kind: 'webhook' }
```

这一步给 RFC-294 §3.5 的 task-owned `TaskLaunchSource` 补足用户已确认的 direct/fusion initiator 语义：对应
root variants 带由可信 inbound 生成的 `initiator`，schedule/webhook 由 source kind 决定。RFC-294 完整
`TaskLaunchSource` 中的 `call-workflow` / `call-workgroup` variants 仍只携 `parentTask` / `parentNodeRun` 引用；
它们是 admission source，不是可信的 origin carrier，**禁止**预填 `parentOrigin`。application 必须解析 exact
parent 并在创建事务内读取其持久来源。上述过渡字段不是 transport 字符串，不进入每个 `OperationContext`，
也不能从 wire 传入。

### 9.2 本波承担的架构演进

实现新增纯 `task-execution/domain/taskLaunchOrigin`（实际路径按当前 module skeleton 落位），让枚举、归约和
invariant 从第一天即有目标 owner。现有横向文件只作为迁移期一跳调用面：

- `services/execution/executor.ts` 把现有 invoker/可信 direct initiator 投影成 closed provenance；
- `services/task.ts` 的 initial transaction 调 domain 归约并写 task-owned repository 字段；
- `services/taskOperations.ts` 的既有 query facade 改委托精确来源 predicate；
- `services/fusion.ts` 只接收 inbound 已解析的 direct initiator，不 import Actor mapper 或自行看 token。

这些旧文件不新增跨域 DB query、业务 facade、ambient provider 或公开 symbol。未来 RFC-294 launch-intent 波次把
`initiator` 合入对应 direct/fusion root variants，schedule/webhook 继续按 kind 归约，call variants 继续只靠 parent
引用在事务内继承；随后删除 `StartTaskDeps` 过渡字段。本 RFC 的 DB 值、domain 归约和 query 语义无需再次迁移。

### 9.3 过渡债务与偏离审计

- **过渡债务 A**：当前仓库尚未建立完整 `modules/task-execution/infrastructure` schema contribution，列仍需追加到
  集中的 `db/schema.ts`。本 RFC 同时在设计/测试中登记 task-execution 为唯一 owner，不新增其他模块直接写列；等
  RFC-294 persistence composition 波次只迁物理位置。
- **过渡债务 B**：当前生产 admission 仍以 `StartTaskDeps` 传参。本波新增的来源输入必须对生产根入口显式、对 child
  禁止覆盖；它是一跳 shape adapter，不承载授权、查询、fallback 或第二 writer。
- **过渡债务 C**：TaskOperations 全量 query 尚在 legacy service；本波只把来源谓词收成 task-owned exact filter，
  不借一个小筛选改动搬迁整套列表 query，避免与并发 task 架构工作形成大爆炸提交。

以上均符合 RFC-294 的渐进 facade/schema 迁移模型；没有新增目标架构偏离、跨 context internal import 或
`KNOWN_VIOLATIONS`。若实现核实必须新增上述清单之外的偏离，立即停工回到 RFC 呈批，不能在实现中默许。

## 10. 影响文件与边界

预计只触及：

- `packages/shared/src/taskOperations.ts` 及 shared tests；
- task-execution domain 来源值对象、backend DB schema/migration、trusted inbound mapper、execution deps、`startTask`
  初始事务、Fusion adapter 与 TaskOperations query/tests；
- frontend task route、双语资源与相关单测/E2E/视觉场景；
- rolling-upgrade/migration journal 与 E2E fixtures；
- RFC/STATE 索引和必要的开发 gotcha（仅在实现中出现可复用教训时）。

不在 route 以 endpoint/User-Agent 字符串判断，不让 DB/query 层依赖 HTTP actor，不让 integration 或
knowledge-evolution 直接写 task 表，也不借本 RFC 搬迁 TaskEngine/WrapperRuntime/NodeExecutor/ExecutionKernel。
