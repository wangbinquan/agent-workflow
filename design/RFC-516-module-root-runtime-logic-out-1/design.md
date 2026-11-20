# RFC-516 设计：模块根装配文件的运行期逻辑迁出（一）

## 1. 现状（HEAD，源码实读）

| 文件（`packages/backend/src/modules/` 下） | 内容（HEAD 行）                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `event-center/composition.ts`              | 缺省观察者（254～260：`options.observer ??` 后的对象字面量，`run` 一调就抛）                        |
| `identity-access/composition.ts`           | `RuntimePresenceConnections` 类（65～93：开连接、幂等释放、关停时逐个释放）                         |
| `source-control/composition.ts`            | `reconcileRepositoryTransportConnectionProjections`（155～172）；员工案例操作宿主的核对（231～237） |

读这些原文的锁：`rfc321-repository-publication-ratchet` 读 bootstrap 的启动实现里有 `reconcileRepositoryTransportConnectionProjections(`（名字与
bootstrap 的 import 不变，不受影响）。按被迁的每一行原文全仓搜用例（RFC-514 的教训），没有别的锁。

## 2. 机制与落位

### D1 归 application

- **`event-center/application/unavailableObserverProgram.ts`**（新）：`createUnavailableEventObserverProgram(): EventObserverProgramPort` 返回 HEAD
  第 255～259 行的 `run`（逐字）；端口类型取本模块的 `composition/required-ports`（application 取 required-ports 的类型已有先例，类型会被擦除）。
- **`identity-access/application/runtimePresenceConnections.ts`**（新）：`RuntimePresenceConnections` 类（HEAD 第 65～93 行逐字，改为导出），取本模块
  `application/operationContext` 的 `DirectAuthorityRuntime`、`application/commands/trackUserPresence` 的 `TrackUserPresence` 与
  `public/participants` 的两个类型。
- **`source-control/application/repositoryTransportConnectionProjection.ts`**（增）：`reconcileRepositoryTransportConnectionProjections`（HEAD 第 155～172
  行逐字）。
- **`source-control/application/employeeCaseWorkspace.ts`**（增）：`requireEmployeeCaseWorkspaceOperations(selected)`，函数体是 HEAD 第 231～237 行逐字。

### D2 模块根只装配

- event-center：`observer: options.observer ?? createUnavailableEventObserverProgram()`（缺省值仍在每次装配、未给观察者时新建）。
- identity-access：从新位置取 `RuntimePresenceConnections`，构造与交出不变。
- source-control：`reconcileRepositoryTransportConnectionProjections` 从 application 转出（bootstrap 的 import 不改）；操作宿主一支先调
  `requireEmployeeCaseWorkspaceOperations(selected)` 再交出 `selected.operations`，选择本身留在模块根。

### D3 锁与账本

- RFC-515 门的例外清单删去 `event-center/composition.ts`、`identity-access/composition.ts` 与 `source-control/composition.ts`（33 → 30），清单长度断言随改。
- guard-manifest 登记 RFC-516 用例（`assertsAbsence: true`，“不存在”写成 `toEqual([])` 的字面形态）。`counts.json` 不变（F13 不计模块根）。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/` 下）                                    | 声明并交出                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `event-center/application/unavailableObserverProgram.ts`（新）                | `createUnavailableEventObserverProgram`             |
| `identity-access/application/runtimePresenceConnections.ts`（新）             | `RuntimePresenceConnections`                        |
| `source-control/application/repositoryTransportConnectionProjection.ts`（增） | `reconcileRepositoryTransportConnectionProjections` |
| `source-control/application/employeeCaseWorkspace.ts`（增）                   | `requireEmployeeCaseWorkspaceOperations`            |

允许的形状：三个模块根 `composition.ts` 不再声明这些名字（收敛函数只转出），没有循环、`try` 与 `throw`。

## 4. 用例

新增 `packages/backend/tests/rfc516-module-root-runtime-logic-out-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；三个模块根不再声明它们。
- ② 三个模块根没有循环、`try`、`throw` 与错误的构造；四个名字在生产代码里只被预期的模块根调用（实参钉住）；带负对照。
- ③ 两个新文件的依赖面是闭集（import 逐条钉住），不用进程全局；带负对照。
- ④ 行为：缺省观察者以原文错误拒绝（带与不带观察者程序引用两种）；登记表只为会话来源开连接、释放幂等、关停释放全部；收敛对每行同步、对缺失的提供方移除；
  核对接受齐全的宿主、拒绝缺操作的宿主。

## 5. 失败模式

- **走样**：按 HEAD 原行切片生成，用词法单元比对复核。
- **按原文钉住被迁行的锁**：已按原文全仓搜（§1）。
- **门的例外清单**：随本 RFC 删 3 条；陈旧例外会让 RFC-515 门红，所以必须同提交。

## 6. 取舍（可推翻）

1. **登记表类整体迁入 application**：它只依赖本模块的 application 与 public 类型，是在线状态用例的运行期部件，不是装配。
2. **收敛函数并入投影文件**：它只用这个文件的投影构造器与仓库端口，放一处好找；模块根转出名字不变。
3. **选择留在模块根**：操作宿主与分步效果的二选一是装配；只把核对挪走。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是运行期部件与用例，落 application；模块根只装配与选择。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-516 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读三个模块根与新位置；RFC-515 门覆盖全模块。
- **C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 模块根收口的第一步：RFC-515 门的例外清单 33 → 30。
- **留下**：digital-employee、system-operations 与 task-execution 的模块根（另立后继）；RFC-370 的 27 个例外文件与 `composition-forbidden-import-files`
  的 12 个待 RFC-370 余项。
