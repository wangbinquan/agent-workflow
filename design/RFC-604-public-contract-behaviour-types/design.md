# RFC-604 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `0f2ded0db`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 检测规则在 `T/architecture/rfc294Gates.ts` 的 `publicSurfaceViolations`。
  - 类型写法改在三个模块的 application 端口：runtime-management `application/ports/agentLiveCapture.ts`，source-control
    `application/ports/repositoryPreparationEffects.ts`、`scratchWorkspaceEffects.ts`、`isolationWorkspace.ts`。
- **裁定一：平台日志器是合同接口**。
  - `Logger` 只有 `debug / info / warn / error / child` 五个方法，不暴露存储、事务、传输或进程句柄。检测器禁止 `@/platform/*`，本意是挡住
    `PersistenceTx`、提交事件引用这类机制类型（design §3.2 的“表结构耦合”与 §3.3 的“Drizzle / Hono / vendor 类型”）。
  - 每个模块本来都依赖平台日志。合同带上调用方的日志器，是为了让被调方在调用方的服务名与上下文下记日志。
  - 改成各模块自有的同形接口只是复制：结构类型下彼此可互换，不增加隔离。所以按 design §3.2 的“确属合同的形态先改检测规则”处理。
  - 只放行这一个具名接口：同一文件的其他导出、其他平台模块照旧禁止。检测器不展开它的声明（声明里的
    `Record<string, unknown>` 字段属于平台日志的形状，不是任何模块的合同）。
- **裁定二：方法参数里的回调是方法签名的一部分**。
  - 借出式参数（`run(act)`、`withPreviewIndex(operation)`）与进度 / 判定回调，在被调方法执行期间被调用。它们的参数与返回类型完整，检测器照旧逐个检查。
  - 函数类型出现在属性里，是把行为当数据存放：按 RFC-569 的先例写成端口或输入形状上的方法。出现在返回值里，是交出闭包：应是带方法的句柄。这两种位置照旧记债。
  - design §3.3 的“命令不收 deps / callback”不受影响：命令的输入是 DTO，回调在 DTO 里是属性。
- **统一收法**：输入对象里函数类型的成员（`assertCurrent`、`checkpoint`、`runAgent`、`getRootSessionId`、`onInsert`）改写为方法签名。它们是调用方随输入
  提供的极小端口；调用方传的对象字面量与被调方的调用写法都不变。
- **偏离项**：无。

## 1. 检测规则

- **规则一**：
  - 类型引用的绑定来自 `@/platform/logging/logger`、导入名为 `Logger` 时，既不记“forbidden type import”，也不展开。
  - `import('@/platform/logging/logger').Logger` 同样处理。
- **规则二**：
  - 适用条件：函数类型节点的父节点是参数声明，且该参数属于方法签名、方法声明、调用签名、构造签名或函数声明。
  - 满足时不记“unsafe/open type FunctionType”，但照旧遍历它的子节点：回调的参数与返回类型里的 `unknown`、平台类型等仍会记债。
  - 联合里的函数类型（如 `((x) => void) | undefined`）不算参数类型本身，照旧记债。

## 2. 类型改写

| 文件                                                               | 成员                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| runtime-management `application/ports/agentLiveCapture.ts`         | `getRootSessionId()`、`onInsert?(info)`                             |
| source-control `application/ports/repositoryPreparationEffects.ts` | `checkpoint(evidenceJson)`、`assertCurrent()`                       |
| source-control `application/ports/scratchWorkspaceEffects.ts`      | `assertCurrent()` ×2                                                |
| source-control `application/ports/isolationWorkspace.ts`           | `resolveConflict` 输入的 `runAgent(prompt, workspaceRef, manifest)` |

方法签名不能带 `readonly`，其余不变；调用方与实现由 `tsc` 全量核对。

## 3. 账本与计数

- `PUBLIC_SURFACE_DEBT` 去掉 8 条：
  - runtime-management `AgentMaterialCompiler`、`AgentMaterialEvidence` 的 `Logger`，以及 `AgentMaterialEvidence` 的 `FunctionType`。
  - source-control `selectIsolationWorkspaceFactory` 的 `Logger` 与 `FunctionType`、`selectRepositoryGitWorkspaceFactory` 的 `FunctionType`、
    `WorkspaceMaintenanceEffects` 的 `FunctionType`。
  - task-execution `SystemAgentRunFamily` 的 `Logger`。
- 留下注释说明出处。`counts.json` 的 `public-surface-deviations` 27 → 19（max 同步降，reason 写 `max=19`）。

## 4. 用例

- 新增 `T/rfc604-public-contract-behaviour-types-boundary.test.ts`，登记 guard-manifest：
  1. **规则一**：合成的 public 类型引用 `Logger` 不记债；同文件的另一导出、`PersistenceTx` 照旧记债。
  2. **规则二**：方法参数、可选参数、调用签名参数、函数声明参数里的回调不记债；属性、返回值、联合成员里的函数类型记债；回调参数里的 `unknown` 照旧记债。
  3. **改写**：七个成员在源码里是方法签名，不再是函数类型属性。
- 计数：`public-surface-deviations` 27 → 19，其余不变。

## 5. 失败模式

- **有人把规则一放宽到整个 `@/platform`**：RFC-604 用例 ① 的 `PersistenceTx` 反例红。
- **有人把规则二放宽到属性或返回值**：RFC-604 用例 ② 的反例红。
- **有人把这些成员改回函数类型属性**：RFC-604 用例 ③ 与 `rfc294-architecture-preflight` 的逐条相等红。

## 6. 对 RFC-294 刷新后规则的对账

- **C12**：RFC-604 用例读源码并跑合成语料，检测器逐条相等由 preflight 执行。
- **C13**：计数降、不升。

## 7. 留下的

- 不透明身份引用 `object`（development-automation 证据暂存、integration 适配器效果），改为带品牌的句柄。
- task-execution 合同上的 `CommittedEventRef`，改为模块自有形状。
- shared 运行时清单的有限键映射类型，按规则或改写处理。
- `unknown` DTO（材料证据的失败原因、运行时配置命令、用量事件、自动升级回执），存量回执要定兼容口径。
- 能力 / 凭据 / 身份一族，等 RFC-546。
