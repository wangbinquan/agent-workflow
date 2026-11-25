# RFC-579 技术设计

记号：`S/` = `packages/backend/src/`，`CO/`、`DA/` 分别是 collaboration、development-automation 的模块目录。数字取 HEAD `0a5bf21f1`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：两个模块各自的 `inbound/http`（development-automation 已有 `employeeCaseRoutes.ts`）；挂载函数经各模块的
  `composition.ts` 转出。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第四批；两个模块的 public 面撤回只被路由用的转出，development-automation 的 `public/operations`
  入口随之退役；三条 public 类型偏差销账。
- **不新增** DAG 之外的边：`taskClarifyDirective` 取 task-execution `public/types` 的路由操作类型（DAG 有 collaboration → task-execution）；两个开发
  配置 / 任务路由取 identity-access `public/participants` 的授权类型（authority-type-only）。`server.ts` 指向 composition 属装配根例外。
- **留下的债**：绑定仍用 `routes/registry`、`routes/operationRoute`、`routes/operationAuthority` 与 `@/auth/actor`，随传输工具归位另立。
- **偏离项**：无。

## 1. 文件去向与连接

| 原文件                             | 新位置                                          | 改动（import 来源）                                             |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `S/routes/clarify.ts`              | `CO/inbound/http/clarifyRoutes.ts`              | 路由操作端口取 `application/ports/collaborationRouteOperations` |
| `S/routes/reviews.ts`              | `CO/inbound/http/reviewRoutes.ts`               | 同上；审查访问判定取 `domain/reviewAccess`                      |
| `S/routes/taskClarifyDirective.ts` | `CO/inbound/http/taskClarifyDirectiveRoutes.ts` | 提问节点判定取 `domain/clarifyAskingNode`                       |
| `S/routes/taskQuestions.ts`        | `CO/inbound/http/taskQuestionRoutes.ts`         | 路由操作端口同上；冲突码取 `domain/taskQuestionConflicts`       |
| `S/routes/developmentConfig.ts`    | `DA/inbound/http/developmentConfigRoutes.ts`    | 描述工厂、schema 与句柄合同取 `application/configOperations`    |
| `S/routes/developmentMissions.ts`  | `DA/inbound/http/developmentMissionRoutes.ts`   | 取 `application/missionOperations`                              |
| `S/routes/missionInputUploads.ts`  | `DA/inbound/http/missionInputUploadRoutes.ts`   | 上传用例端口取 `application/missionInputUploadOperations`       |

- 文件名取挂载函数名去掉 `mount`。两个模块的 `composition.ts` 各加对应的转出；`server.ts` 的 collaboration 四条 import 合为一条，development-automation
  三条并进已有的一条（它已取 `mountDevelopmentCaseRoutes`）。挂载调用与顺序不变。
- public 撤回（按 RFC-578 design §3 的口径算到不动点，四层）：
  - `CO/public/participants.ts`：删去 `application/ports/collaborationRouteOperations` 的整组转出（`CollaborationRouteOperations` 与 11 个参数 / 结果类型）。
  - `CO/public/types.ts`：删去 `ReviewAnchorRequest`、`ReviewGateDecision`、`GateDecisionReceipt`、`HumanGateIdentity`、`ReviewAccessDecision`、三组命令
    合同（各一对输入 / 结果）与 `TASK_QUESTION_CONFLICT` 的转出；`ReviewActor`、`CollaborationCommandContext` 等留下。
  - `CO/public/queries.ts`：删去 `isAskingNodeInSnapshot` 的转出。
  - `DA/public/operations.ts`：全部 21 个导出都只被路由用，文件删除。
  - `DA/public/commands.ts`：删去 `MissionInputUploadOperations` 的转出，两个维护命令类型留下。
  - 本模块里经 public 取它们的读者改取声明处：`CO/application/ports/reviewDecisionCommand.ts`、`CO/infrastructure/clarify/autoDispatch.ts`、
    `CO/infrastructure/taskQuestionDispatch.ts`、`DA/composition/configOperations.ts`、`DA/composition/missionOperations.ts`。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去七行；`counts.json` 的 `legacy-horizontal-files` 上限 84 → 77，`public-surface-deviations` 上限
  32 → 29（`DevelopmentConfigIdentityView`、`DevelopmentConfigOperations`、`DevelopmentMissionOperations` 三条开放类型偏差随撤回销账）；
  `rfc294-architecture-preflight` 的偏差清单删去这三条。
- `rfc552` 的 `public/operations` 账本删去 development-automation 一项（入口删了）；`rfc550` 的冻结夹具记着 RFC-550 从这个入口撤出的 7 个名字——
  夹具不改，用例对“后来整个删掉的入口”按“删掉的入口什么都不交出”处理，正对照随之去掉这一项。
- 钉着旧路径的用例随改：按路径读源码或列清单的 `rfc108`、`rfc122`、`rfc128-p5-d`、`rfc326-mcp-review-tools`、`rfc333`、`rfc339`、`rfc341`、`rfc344`、
  `rfc349-collaboration-route-operations`、`rfc349-digital-development-provider-boundary` 与 ACL 写门守卫的委托表；`rfc305` 的 identity-access 消费者
  账本两条；`rfc331` 的 legacy 消费者清单删去三个迁走的路由（它们成了 collaboration 的模块文件，模块边界守卫覆盖它们）；`rfc442` 的方向用例
  ——`taskFeedback`（task-execution 的路由，仍在 `routes/`）照旧只经 exact public，两个迁进 collaboration 的绑定改为取本模块内部；`rfc349` 断言
  路由经 public 取路由操作端口，改为取本模块端口。经 public 取撤回符号的用例改取声明处；直接 import 旧路径的用例由搬迁脚本改说明符。
- 集中验证里另查出的两处（都已随改）：`rfc294-architecture-preflight` 的 capability 名称账本里 `ReviewActor leaks through public/types` 一条随撤回
  销账（带 `ReviewActor` 的三组命令合同不再从 public 转出）；`rfc439` 的“`routes/` 下多于 30 个文件”这条非空下限改成 10（W9-D 让 `routes/` 按设计
  变小，本 RFC 之后 29 个；迁走的绑定是模块文件，R1 账本覆盖它们）。
- 架构报告只出报告的变更入口普查 2391 → 2390：`taskClarifyDirective` 的 schema 条目随文件改到新路径；上传路由里 `operations.delete(…)` 那处
  HTTP 站点不再在扫描范围内（同 RFC-578 design §2）。
- 不改：描述过往迁移的注释；e2e 注释里的源码行号锚点（多处早已过时，属于写用例时的出处记录，没有东西读它们）；`rfc503` / `rfc561` /
  `rfc294-review-offered-edge-dag` 里写成字符串的负对照夹具（不依赖文件存在）。
- 新增 `tests/rfc579-collaboration-development-automation-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 七个旧路径不存在，`src` /
  `tests` / `scripts` 的全部说明符不再解析到它们（带负对照）；② 七个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块
  application / domain / public）与登记过的别的模块 public，不取 `@/db` 与 `services/`（带负对照）；③ 三个 public 文件不再转出撤回的 26 个符号，
  development-automation 的 `public/operations.ts` 不存在、`public/commands.ts` 不再转出上传端口；④ `server.ts` 从两个模块的 composition 取七个
  挂载函数。

## 3. 检索与撤回的推算

同 RFC-578 design §3。本 RFC 的推算在 `0a5bf21f1` 的报告上做：collaboration 四层 25 个、development-automation 四层 22 个，两个模块迁完仍有 public 面。
检索另按 RFC-578 的教训用全名单（含裸的类型名）查经 public 取撤回符号的读者。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-579 用例 ① 红，`legacy-horizontal-files` 也红。
- **撤回的符号又从 public 转出，或 `public/operations.ts` 重建**：用例 ③ 红，`unconsumed-public-symbols-*` 门也红。
- **绑定多取别的模块**：用例 ② 红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 5. 取舍（可推翻）

1. **两族一个 RFC**：撤回虽多，几乎全是转出行；做法与验证同 RFC-578。
2. **`public/operations.ts` 删除而不是留空**：留一个空入口没有意义，`rfc552` 的“有 public/operations 的模块”清单随之少一项。
3. **`rfc550` 的冻结夹具不改**：夹具是 RFC-550 当时的事实；用例对后来删掉的入口按“什么都不交出”处理，比改夹具更能保住它的原意。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：两个 public 面收窄 47 个只被本模块用的转出，一个 public 入口退役，
  三条类型偏差销账。**C12**：RFC-579 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③ ④ 只读相关文件。**C13**：`legacy-horizontal-files`
  84 → 77、`public-surface-deviations` 32 → 29，其余计数不升。
- **留下的债**：`routes/` 余 29 个；路由传输工具归位；resource-catalog、task-execution 等族。
