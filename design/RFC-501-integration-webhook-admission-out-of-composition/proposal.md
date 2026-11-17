# RFC-501 集成的 webhook 启动准入与触发器校验迁出 composition（RFC-294 S10 第八步）

- **状态**：In Progress（2026-11-16）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求各模块
  `composition/` 的分支计数不高于经确认的上限；RFC-294 design §2 的依赖表不许 infrastructure 取 composition。
- **前序**：[RFC-500](../RFC-500-integration-development-event-observers-out-of-composition/proposal.md)（S10 第七步，Done，`81bb9a42b`）。
  S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 integration 的 `composition/webhookAdmission.ts`（删除）、
  `composition/webhookDispatch.ts` 取它的一条 import、`composition.ts` 的一条转出、`infrastructure/webhookDispatchRuntime.ts` 里转手它的
  函数与 bootstrap `daemonModules/integration.ts` 取它的 import 与一处调用，不碰 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-500 之后，integration 的组合层控制流实测 74 行：`webhookAdmission.ts` 17 行，是余下最多的一个；其余是
`taskImageDevelopmentAdapter.ts` 13 行（RFC-370 余项，避让）、`developmentAdapterConfigOperations.ts` 12 行、`codeHostEffects.ts` 11 行、
`approvalGateway.ts` 10 行等。

`webhookAdmission.ts`（191 行）是 webhook 的两道准入：启动准入（投递渲染出的启动在派发前按目标种类校验资源快照或定时目标）与触发器
保存校验（launch payload 的 schema、工作流 / 数字员工资源快照、静态问题、预检与一次演练渲染后的目标校验），外加按配置读默认运行时再
校验的校验器工厂。三个函数都是用例，只取本模块的 application / domain、resource-catalog 的 public 与 shared，不取 infrastructure，也没有
装配。它的使用方绕了一圈：`composition/webhookDispatch.ts` 取 `infrastructure/webhookDispatchRuntime.ts` 的 `createWebhookLaunchAdmission`，
而那个函数只是转手 composition 的 `composeWebhookLaunchAdmission`——infrastructure 反取 composition，正是 RFC-294 的依赖表不许的边。

## 2. 目标

- **G1 准入归 application**：三个函数原样迁入 `application/webhookAdmission.ts`；两个工厂改名为 `createWebhookLaunchAdmission` 与
  `createWebhookTriggerValidation`，`assertWebhookTriggerSaveable` 名字不变。
- **G2 composition 不再有这个文件，infrastructure 不再取 composition**：`composition/webhookAdmission.ts` 删除；
  `infrastructure/webhookDispatchRuntime.ts` 里只转手的 `createWebhookLaunchAdmission` 删除，`composition/webhookDispatch.ts` 直接从
  application 取启动准入；校验器工厂经 integration 的 `composition.ts` 转出给 bootstrap。
- **G3 账本与锁**：取这些名字的用例改取新位置；按路径读这个文件的锁改读新文件；`composition-control-flow-integration` 按实测收紧；新增
  RFC-501 用例。

## 3. 非目标

- integration `composition/` 的其余文件（`webhookDispatch.ts` 其余装配、`developmentAdapterConfigOperations.ts`、`codeHostEffects.ts`、
  `approvalGateway.ts` 等）与其他模块；`taskImage*` / `crewstation*` 一族（RFC-370 余项，逐个避让）。
- 改写准入或校验的判据、拆分函数；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在 `application/webhookAdmission.ts` 声明；`composition/webhookAdmission.ts` 不存在，没有文件从旧位置
  取名字；改名前的两个工厂名没有声明；`infrastructure/webhookDispatchRuntime.ts` 不再声明 `createWebhookLaunchAdmission`、不取 composition。
- **AC-2**：同样输入下启动准入与保存校验的结果、错误码与对端口的调用次序和参数和此前一致（迁移逐字，现有用例对拍）；派发与触发器服务拿到
  的准入与校验与此前是同一份实现。
- **AC-3**：新文件只取 shared、`@/util/errors`、`@/auth/actor` 的类型、resource-catalog 的 `public` 与本模块 domain / application，不取
  infrastructure、composition 与 IO 包；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
