# RFC-576 技术设计

记号：`S/` = `packages/backend/src/`，`SO/` = `S/modules/system-operations/`。落在 system-operations 的 `inbound/http`（接收七个绑定）与
`composition/routes.ts`（只转出），`server.ts` 只改 import。另改架构报告的归属表、`architecture/counts.json`、钉着旧路径的用例与指针，新增一个
RFC-576 用例。数字取 HEAD `8f236d5bb`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：system-operations 的 `inbound/http`（七个绑定）与 `composition/routes.ts`（只转出挂载函数）。
- **承担的演进**：W9-D 里 `routes/` → 模块 `inbound/` 的第一批；system-operations 的入站绑定全部进模块。
- **不新增** DAG 之外的边：七个绑定对模块的依赖全部是 `import type`——本模块的 public 与 application，与 identity-access `public/participants`
  的授权类型（架构报告把这类边归为 `authority-type-only`，DAG 已有 system-operations → identity-access 这一项）；`server.ts` 指向 composition 属
  装配根例外。
- **public 面收窄**：绑定进模块后，`public/operations` 的 `SystemOperationDescriptors`、`DatabaseMigrationOperationDescriptors` 与
  `public/queries` 的 `SystemOverviewQuery` 不再有模块外的消费者（第一次出报告时 `unconsumed-public-symbols-system-operations` 0 → 3），撤回
  application：两个描述合同进 `application/operationDescriptors.ts`（RFC-550 已把造它们的工厂放在那里），`SystemOverviewQuery` 进
  `application/overview.ts`（它的实现所在）。绑定、`composition.ts` 与用例改从那里取；`public/operations` 只剩别名表与
  `MaintenanceDiskOperations`。撤回之后又有三个 public 符号只剩它们自己引用（第二次出报告仍是 0 → 3）：`public/queries` 的
  `SystemOverviewAuthority` 移进 `application/ports/systemOverviewSources.ts`（概览来源端口，概览实现从那里取），`public/types` 的
  `CancelStagedRestoreResult`、`RecoveryStatusView` 改在 `application/systemOperationContracts.ts` 里从各自的 schema 推出（schema 本来就在那里）。
  再往下没有了：它们引用的只有 identity-access 的 public 类型与本模块 application 的 schema。
- **留下的债**：绑定仍用 `routes/registry`、`routes/operationRoute`、`routes/operationAuthority` 三个 HTTP 传输工具与 `@/auth/actor`，与其他模块的
  绑定相同，随传输工具归位另立。
- **偏离项**：无。

## 1. 文件去向

| 原文件                           | 新位置                                       |
| -------------------------------- | -------------------------------------------- |
| `S/routes/backup.ts`             | `SO/inbound/http/backupRoutes.ts`            |
| `S/routes/restore.ts`            | `SO/inbound/http/restoreRoutes.ts`           |
| `S/routes/databaseMigrations.ts` | `SO/inbound/http/databaseMigrationRoutes.ts` |
| `S/routes/overview.ts`           | `SO/inbound/http/overviewRoutes.ts`          |
| `S/routes/daemon.ts`             | `SO/inbound/http/daemonRoutes.ts`            |
| `S/routes/maintenance.ts`        | `SO/inbound/http/maintenanceRoutes.ts`       |
| `S/routes/maintenanceDisk.ts`    | `SO/inbound/http/maintenanceDiskRoutes.ts`   |
| —                                | `SO/composition/routes.ts`                   |

文件内容原样，只有说明符随新位置重算（取本模块 public 的仍用别名）。`composition/routes.ts` 只转出七个 `mount*Routes`（四个依赖类型只在各自的绑定里用，不转出），不含逻辑。

## 2. 连接

- `server.ts`：七条 import 合为一条，取 `@/modules/system-operations/composition/routes`；`Parameters<typeof mount…>` 一类的类型与挂载调用、先后
  顺序不变。
- 用例里直接 import 这些绑定的（`rfc213-restore-route` 等）改指新位置。

## 3. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去七行（其中 `daemon`、`maintenance`、`maintenanceDisk` 三行原记为 platform；它们取 system-operations 的
  public，platform 不能取模块，归 system-operations 才对得上）；`counts.json` 的 `legacy-horizontal-files` 上限 98 → 91。
- `rfc552` 的 public/operations 导出清单删去两个描述合同；`rfc346` 断言备份与还原两个绑定从 `../../application/operationDescriptors` 取描述合同
  （原来断言的是 public）。
- 钉着旧路径的用例随改：读源码的（`rfc346-system-operations-contracts` 读备份与还原两个绑定、`rfc370-daemon-host-root-wiring` 读 daemon 绑定等）、
  按目录扫路由的（扫 `routes/` 的同时也扫各模块 `inbound/` 的保持不变；只扫 `routes/` 而断言其中有这些文件的，改成扫新位置）。
- 新增 `tests/rfc576-system-operations-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 七个旧路径不存在，`src` / `tests` / `scripts`
  的全部说明符不再解析到它们（带负对照）；② 七个绑定对模块的 import 全部是 `import type`：别名只取本模块 public 与 identity-access 的
  `public/participants`，相对路径只取本模块的 application / domain / public，不取 `@/db`、`services/`、本模块的 infrastructure / composition 与别的
  模块；③ `composition/routes.ts` 只有转出；
  ④ `server.ts` 从 `composition/routes` 取这七个挂载函数，不再取 `@/routes/` 下的这七个文件。

## 4. 检索

按 `docs/dev-gotchas.md`“挪文件前的检索”的清单：路径文本（含 `e2e/`、前端、脚本、工作流、`design/` 的 Markdown 链接与账本）、分段拼出的路径、
正则写的路径、泛化放行（按目录 `routes/` 放行或断言的）、源码摘要锁、按目录名判的规则、`import.meta` 相对路径。

## 5. 取舍（可推翻）

1. **七个一起进 system-operations**：`daemon`、`maintenance`、`maintenanceDisk` 在归属表里记的是 platform，但它们读写的是 system-operations 的 public
   合同，按依赖只能是 system-operations 的入站绑定。
2. **`routes/health.ts` 不在本批**：它取 task-execution 的类型与 platform 的健康计数，归谁要另看。
3. **文件名加 `Routes` 后缀**：与已经迁入模块的绑定（`codeRoutes.ts`、`webhookTriggerRoutes.ts` 等）同名法。

## 6. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-576 用例 ① 红。
- **绑定开始取模块内部或值依赖别的 context**：用例 ② 红，`module-layer-violations` / `context-value-pairs-off-dag` 门也红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：不改 public。**C12**：RFC-576 用例 ① 覆盖 `src` / `tests` /
  `scripts` 的全部说明符；② ③ 只读八个新文件；④ 只读 `server.ts`。**C13**：`legacy-horizontal-files` 98 → 91，其余计数不升。
- **本 RFC 承担的演进**：`routes/` → 模块 `inbound/` 的第一批。
- **留下的债**：`routes/` 余 43 个；路由传输工具归位。
