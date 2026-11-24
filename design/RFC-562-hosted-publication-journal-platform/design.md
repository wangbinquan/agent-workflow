# RFC-562 技术设计

落在 platform/content（发布日志归位）、system-operations（required 端口、装配与恢复归一）、task-execution（指定 adapter 与装配根）与五个 owner context 的
`crewstation` 适配（只换类型的出处）；bootstrap 换两处类型与一处实现的出处。数字取 HEAD `7e5b37e36`。不改行为。

## 1. 改动

| 位置                                                                                                          | 做法                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/content/hostedObjectPublications.ts`（迁入）                                                        | 发布日志的合同，原样来自 system-operations `infrastructure/crewstation/objectPublicationContract.ts`                                                                                                                      |
| `platform/content/infrastructure/hostedObjectPublications.ts`（迁入）                                         | 发布日志的实现，原样来自 system-operations `infrastructure/crewstation/objectPublications.ts`；新增 `releaseHostedPublicationsInTx`（恢复归一专用，内容是 system-operations 原先自己写的那条 UPDATE）                     |
| system-operations `infrastructure/crewstation/hostedRestoreNormalization.ts`                                  | 释放遗留发布改调 `releaseHostedPublicationsInTx`，不再取 `content_publications`                                                                                                                                           |
| system-operations 的装配、备份与维护端口                                                                      | `composition/crewstationObjectPublications.ts`、`composition/crewstationDatabaseBackups.ts`、备份的三个 infrastructure 文件与 `application/ports/maintenanceSystemOperations.ts` 改从平台取；备份释放水位仍由它实现并注入 |
| system-operations `application/ports/hostedRestoreNormalization.ts`（迁入）与 `composition/required-ports.ts` | 恢复归一参与者的声明处与交出处；`public/participants.ts` 与 `public/commands.ts` 不再转出日志的类型、维护命令与恢复归一参与者                                                                                             |
| 五个 owner context 的 14 个文件                                                                               | `HostedObjectPublications` 等类型改取 `@/platform/content/hostedObjectPublications`                                                                                                                                       |
| task-execution                                                                                                | `application/adapters/system-operations-adapter.ts` 按类型转出恢复归一参与者，`infrastructure/hostedRestoreNormalization.ts` 从 adapter 取；实现改由 `composition.ts` 交出，`public/participants.ts` 不再转出它           |
| bootstrap                                                                                                     | `crewstation.ts` 从 system-operations 的 required-ports 取类型、从 task-execution 的装配根取实现；`maintenanceWorkerEffects.ts` 的维护命令类型改取平台合同                                                                |
| 目标 DAG                                                                                                      | `rfc294Target.ts` 与 RFC-294 design §3.1 的 Mermaid 登记 `task-execution implements HostedRestoreNormalizationParticipant → system-operations`                                                                            |

`releaseHostedPublicationsInTx(tx, { owner, keys, now })`：把 `(owner, key)` 落在点名范围内、状态为 pending / ready 的发布置为 releasing（`releasedAt`、
`updatedAt` 取 `now`，`nextAttemptAt` 归零，清掉封存的源），key 为空时什么都不做——与原先那段代码逐字段相同；它不经执行栅栏（恢复事务里没有活的
栅栏），物理 unpin 仍由维护作业做。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 15 条，
  `counts.json` 26 → 11；`rfc294-design-parity` 的 design 边总数 110 → 111。
- 表归属：`rfc395-module-table-ownership-debt.json` 销去 3 条（120 → 117），`rfc317-table-ownership` 的三条后继映射随之删除，发布日志作为内容 owner 自己的
  机制文件登记进 `GLOBAL_INFRASTRUCTURE`（与 `contentStore.ts` 并列）。
- public 类型偏差：`rfc294-architecture-preflight` 的 `PUBLIC_SURFACE_DEBT` 销去 3 条，`counts.json` 59 → 56。
- 按路径登记的两处随迁：`rfc349-null-ordering-parity`（日志两处有序读取的判据）、`rfc395-content-boundary`（日志只用目标发布表）。
- 用例的 import 出处：15 个 `rfc370-*` / `rfc395-*` 用例改从平台取日志，其中两个同时改从 task-execution 的 infrastructure 取恢复归一实现。
- 新增 `tests/rfc562-hosted-publication-journal-platform-boundary.test.ts`，登记 guard-manifest：① system-operations 以外全部模块的源码取它的只剩
  task-execution 的 adapter 按类型取 required-ports（带负对照）；② 日志的位置、合同只取类型、实现不取 `modules/`，system-operations 的 public 不再交出；
  ③ 恢复归一参与者的声明、交出、adapter 与 bootstrap 的取法，task-execution 的实现经装配根交出；④ 恢复归一不再直接碰 `content_publications`；⑤ 目标
  DAG 的边。
- 新增 `tests/rfc562-restore-publication-release.test.ts`（两种数据库）：闭合操作只动点名 owner、点名 key、pending / ready 的行；空 key 不动；经
  system-operations 的恢复归一走到它（快照里另一个仍在构建的备份判失败、发布开始释放，恢复来源的发布照旧被采纳）。

## 3. 失败模式

- **有模块重新按名字取 system-operations 的 public**：RFC-562 用例 ① 与两份精确清单同红。
- **平台里的日志取了某个模块**：`platform-to-modules-file-pairs` 门与 RFC-562 用例 ② 红。
- **恢复归一又去直接改发布表**：RFC-562 用例 ④ 与表归属账本红。

## 4. 取舍（可推翻）

1. **整份日志（合同与实现）迁入 platform/content，而不是只挪合同或给五个 owner 各写一份窄端口**：实现本来就只依赖 platform，读写的两张表归
   platform/content，两份账本写明的去处都是平台内容机制；只挪合同会留下“业务模块实现平台合同、直接写平台的表”的半截状态，各写窄端口则把一份有请求
   联合类型的合同抄五遍。
2. **system-operations 继续装配日志**：它拥有唯一的托管对象维护作业与备份释放水位（平台声明的 `HostedBackupReleaseHorizon` 由它实现并注入），
   bootstrap 的两个调用点不变。
3. **恢复归一参与者走 required 端口 + 指定 adapter，而不是也放进 platform**：它是 system-operations 的恢复编排向各 owner 要的实现面，和
   `DoctorTaskLifecyclePort` 同类；物理恢复协议下沉 platform 是 W9-E 的事。
4. **task-execution 的实现从 public 撤到装配根**：它只被 bootstrap 取；留在 public 上，它返回类型里的事务句柄会让同一笔 public 类型偏差换个名字留下。
5. **闭合操作只收恢复归一用到的那一条 UPDATE，逐字段照搬**：不顺手改成走 `release`（那条路径要执行栅栏，恢复事务里没有）。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：发布日志归 platform/content（合同在目录根、实现在 infrastructure），恢复归一参与者归 system-operations 的 `application/ports` 并经
  required-ports 交出。**C11**：system-operations 的 public 收窄 9 个符号（日志七个类型、维护命令类型、恢复归一参与者），task-execution 的 public 收窄 1 个
  （恢复归一实现）；platform 不取任何模块。**C12**：RFC-562 两个用例覆盖边界与行为。**C13**：DAG 外 offered 边 26 → 11、表归属债 120 → 117、public 类型
  偏差 59 → 56，其余计数不升；目标 DAG 多一条虚线 required 边（110 → 111）。
- **留下的债**：托管对象发布与 `ContentStore` 的发布账本仍是两套实现（RFC-395 的后继机制未启用）；其余 11 条 DAG 外 offered 边。
