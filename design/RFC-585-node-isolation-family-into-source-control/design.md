# RFC-585 技术设计

记号：`S/` = `packages/backend/src/`，`SC/` = source-control 的模块目录，`TE/` = task-execution 的模块目录。数字取 HEAD `11255a537`。不改生产行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：source-control 的 `infrastructure/local`（本机隔离工作区实现，与已在那里的 `localIsolationWorkspace.ts` 同层）；两个错误类进
  source-control 的 `domain`，经 `public/types` 交出（`public/types` 已有同类的 `RepositoryTransportCredentialError`）。
- **承担的演进**：W5 的“worktree / submodule 收编到 source-control”第一步；platform 不再含任何业务实现的隔离机制，也不再取 legacy 的 `services/`。
- **不新增** DAG 之外的边：task-execution → source-control 是 DAG 上的 offered-consumption；迁走的文件在 source-control 里取 platform、`util/git`、
  `@/config` 与 `services/mergeAgent`（legacy，与 source-control 的其他文件相同）。
- **留下的债**：`services/mergeAgent.ts`（两个 context 共用）、`util/git.ts` 本身。
- **偏离项**：无。

## 1. 文件去向

| 原文件                                              | 新位置                                           |
| --------------------------------------------------- | ------------------------------------------------ |
| `S/platform/workspace/local/isolation.ts`           | `SC/infrastructure/local/nodeIsolation.ts`       |
| `S/platform/workspace/local/isolationReferences.ts` | `SC/infrastructure/local/isolationReferences.ts` |
| `S/platform/workspace/local/submoduleParams.ts`     | `SC/infrastructure/local/submoduleParams.ts`     |
| `S/services/gitSubmodule.ts`                        | `SC/infrastructure/local/gitSubmodule.ts`        |

- 四个文件内容逐字不变，只改 import 说明符（搬迁脚本按语法改写；迁走文件互相之间的相对路径随之重算）。`nodeIsolation.ts` 里
  `IsoWorkspaceBlockedError`、`MergeAgentChildUnreapedError` 两个类的声明逐字移到 `SC/domain/isolationErrors.ts`，本文件改为取它们（同一个类，
  `instanceof` 不变）；`CanonicalWorktreeMissingError` 只在本文件与用例里用，不动。
- `SC/public/types.ts` 转出这两个错误类。

## 2. task-execution 的改动

- `TE/infrastructure/isolationWorkspaceView.ts`：快照、合并、丢弃、冲突解决四个入口删去“没有作用域就退回本机函数”的分支，统一经
  `workspaceRecord(handle)` 取作用域（没有就抛 `TypeError`，与 `completeIsolatedHumanConflict` 一致）。签名改用 task-execution 自己的端口
  （`IsolationCleanupBinding['discardIsolatedWorkspace']`、`MergeConflictPorts['workspace']['resolveIsolatedConflict']` 的入参）与 source-control
  public 作用域的方法类型（`IsolationWorkspaceScope['completeHumanConflict']` 的结果），不再取本机函数的类型。
- `TE/infrastructure/executionDiagnostics.ts`：两个错误类改从 `SC/public/types` 取。
- 生产句柄：只由 source-control 的作用域创建（`localIsolationWorkspace.ts` 的 `createNodeIso` / `rebuildIsoHandle`、两个托管实现），task-execution 的
  视图在 `create` 时登记作用域；引擎里的 `as IsoHandle` 都是对这些句柄的类型收窄，不新造句柄。

## 3. 用例

- 新增 `T/helpers/nativeIsolationCleanup.ts`：在 task-execution 的 `bindIsolationCleanup()` 之上，把“没有作用域的本机句柄”交给 source-control 的本机
  `discardIsolationWorkspace`，有作用域的照旧走视图——即原来生产里的退路，原样搬进用例辅助。用 `createNodeIso` 直接造句柄、再经
  `discardNodeIso(bindIsolationCleanup(), …)` 清理的用例改取这个辅助。
- 取两个错误类的用例改从 `SC/public/types` 取；按路径读 `isolation.ts` 源码的用例改读新位置；直接 import 旧路径的用例与辅助由搬迁脚本改写。
- 门与账本：架构报告归属表删 `services/gitSubmodule.ts` 一行；`counts.json` 两个上限；`rfc457` 的 platform → services 边清单删去三条（它们随文件进了
  source-control）；`rfc395` 的检查点边界清单、`rfc377`、`rfc403` 与 `ci-workflow-path-filters` 的路径；`git-protocols-e2e.yml` 的两份路径过滤；
  `architecture/repository-publication-call-sites.json` 的两处路径。
- 新增 `T/rfc585-node-isolation-family-into-source-control-boundary.test.ts`，登记 guard-manifest：① 四个旧路径不存在，`src` / `tests` / `scripts` 的
  全部说明符不再解析到它们（带负对照）；② task-execution 的生产源码不取 source-control 的 infrastructure，`isolationWorkspaceView.ts` 不再调用本机
  函数（带负对照）；③ platform 不取 `services/`（带负对照）；④ 两个错误类只在 source-control 的 domain 声明一次，并由 `public/types` 交出。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：用例 ① 红，legacy 计数也红（`services/gitSubmodule.ts`）。
- **task-execution 又直取本机实现**：用例 ② 红，跨 context 内部文件对计数也红。
- **生产里出现没有作用域的句柄**：视图直接抛 `TypeError`（与原来经作用域的入口一致），隔离与清理的用例会红。

## 5. 取舍（可推翻）

1. **删去视图的本机退路，而不是把本机函数经 public 交给 task-execution**：本机函数的签名带 platform 的 `Logger` 与句柄类型，放进 public 会增加
   public 类型偏差；退路只有用例在走，搬进用例辅助是 RFC-584 的同一做法。
2. **`mergeAgent` 留在 `services/`**：它的合并代理模板归 task-execution 的端口用、冲突解析归 source-control 的隔离实现用，拆分是下一步。
3. **错误类进 domain 再经 public 交出**：避免 source-control 的 infrastructure 经本模块的 public 入口取值（RFC-452 的求值环教训）。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：隔离实现按内容进 source-control 的 infrastructure，错误类进 domain；platform 只剩中性机制。**C11**：source-control 的 public 面多两个被
  task-execution 消费的错误类。**C12**：RFC-585 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符，② ③ 覆盖 task-execution 与 platform 的全部源码，
  ④ 读 source-control 的 domain 与 public。**C13**：`legacy-horizontal-files` 64 → 63、`legacy-service-implementations` 4 → 3，其余计数不升。
- **留下的债**：`services/mergeAgent.ts`；`util/git.ts`；platform 里的 `runGit` 使用方。
