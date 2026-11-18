# RFC-506 身份访问的改密用例与意图目录的演员绑定迁出 composition（RFC-294 S10 第十三步）

- **状态**：In Progress（2026-11-18）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  退出门要求组合层“无循环与 switch，`try` 与 `throw` 只出现在登记清单内”的门对全部模块为绿，各模块 `composition/` 的分支计数不高于经确认的
  上限。
- **前序**：[RFC-505](../RFC-505-employee-jobs-disk-report-runtime-snapshots-out-of-composition/proposal.md)（S10 第十二步，Done，
  `490d75e04`）。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只改 identity-access 的
  `composition/userOperations.ts` 与 intent 的 `composition/resourceCatalog.ts`，新增 identity-access 的
  `application/commands/resetUserPassword.ts`，扩充 intent 的 `application/resourceCatalog.ts`；两个装配入口的名字、签名与位置不变，
  bootstrap 与用例的 import 不改；不碰 `crewstation*`（RFC-370 余项）。

## 1. 背景

RFC-505 之后，identity-access 组合层的控制流（F13 口径）只有 `userOperations.ts` 2 行；intent 有 5 行，其中 RFC-370 余项
`crewstationArtifacts.ts` 3 行与 `crewstationScratch.ts` 1 行，另 1 行在 `resourceCatalog.ts`。这两处都是“用例或用例状态写在
composition”：

- `userOperations.ts`（49 行）的 `composeIdentityUserOperations` 交给 `createIdentityUserOperations` 的 `resetPassword` 是管理员改密用例：
  - 目标是系统用户时抛 `ValidationError('system-user-immutable', 'cannot reset password for __system__')`；
  - 否则取一次 `Date.now()`，哈希新密码，经认证运行时的 `writeLocalPasswordIfUnmanaged` 写入（`forcePasswordChange` 缺省 false、
    `activate: true`、`updatedAt` 为该时刻），再以同一时刻撤销该用户的全部会话。

  其余是装配（`afterDisabled` 撤销会话后转交可选的回调，没有 F13 口径的控制流）。

- `resourceCatalog.ts`（48 行）的 `composeIntentResourceCatalogBinding` 里，一张 `WeakMap` 记下每个查询上下文是为哪个 actor 铸的：
  - `contextFor` 铸出上下文后登记；
  - 资源目录查询的 `resolveActor` 按上下文取回，取不到（不是本目录铸的上下文）就抛 `intent-resource-catalog-context-not-bound`。

  这是每请求的用例状态，不是装配缺口（RFC-359 W5-T19b 账本的注释已这样定性）；其余是装配。

code-capability `historyQueries.ts` 的未绑定缺省、integration `webhookIngress.ts` 的可选装配与 system-operations 的两处装配期路径选择
都属装配期的选择或 S12 的缺省回落，resource-catalog 的 `resourceAcl.ts` 另立，都不在本步。

## 2. 目标

- **G1 用例与状态归位**（函数体逐字不变）：
  - 改密用例迁入 identity-access 的 `application/commands/resetUserPassword.ts`（`createResetUserPassword`）。系统用户 id、认证运行时的
    两次凭据写、哈希与时钟由装配传入，与同目录其他命令以 `systemUserId` 取系统用户的做法一致。
  - 演员绑定迁入 intent 的 `application/resourceCatalog.ts`（`createIntentCatalogActorBinding`），与它服务的目录工厂同文件。
- **G2 composition 只装配**：两个组合文件保留装配入口，各自从新位置取实现，不再有 F13 口径的控制流。
- **G3 账本与锁**：
  - `composition-control-flow-identity-access` 2 → 0、`composition-control-flow-intent` 5 → 4（按实测）；
  - RFC-359 W5-T19b 的组合根占位账本销掉 `modules/intent/composition/resourceCatalog.ts: marker=1` 一行；
  - 按源码文本钉着改密写法的锁（`rfc349-auth-caller-closure`）改钉新位置，断言不放松；
  - 新增 RFC-506 用例。

## 3. 非目标

- `crewstation*`（RFC-370 余项）；code-capability 的未绑定缺省、integration 的可选装配、system-operations 的装配期路径选择（另立或随 S12）；
  resource-catalog 的 `resourceAcl.ts`（另立）；其余模块（source-control、development-automation、task-execution）。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新位置声明；两个组合文件没有 F13 口径的控制流，各自从新位置取实现；装配入口的名字、签名与
  位置不变。
- **AC-2**：同样输入下，改密与演员绑定的结果、错误与对端口的调用和此前一致：
  - 改密：系统用户被拒，且不哈希、不写、不撤销；普通用户先写后撤销，两次用同一时刻，`force` 缺省 false；
  - 演员绑定：登记后取回；未登记的上下文抛同一个错误；两次装配互不串台；
  - 时钟仍在调用时取，每次改密取一次。
- **AC-3**：
  - 新位置的依赖面是闭集：identity-access 的新文件只取 `@/util/errors` 的 `ValidationError`，不取 `@/auth`、infrastructure、composition
    与 IO 包，不用进程全局；intent 新增的函数只用该文件已取的类型、不新增 import、不用进程全局；
  - public surface 不升；两项 `composition-control-flow-*` 收紧到实测，其余计数不升；T19b 的账本只减不增。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
