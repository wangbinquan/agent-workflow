# RFC-497 开发自动化的 mission 与配置操作用例迁出 composition（RFC-294 S10 第四步）

- **状态**：Done（2026-11-15，落地 `b01642940`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围点名“`missionOperations.ts` / `configOperations.ts` / `graphDeliveryBridge.ts` 的命令处理按层归位”；proposal D16、
  review-2026-11-09 R11 / F13。
- **前序**：[RFC-496](../RFC-496-development-employee-workspace-out-of-composition/proposal.md)（S10 第三步，Done，`9688abfd3`）。S10 与
  S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 development-automation 的 `composition/missionOperations.ts`、
  `composition/configOperations.ts` 与模块参与方接口的声明（`composition.ts`，只动类型），不碰 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-496 之后，development-automation 的组合层控制流实测 274 行：`graphDeliveryBridge.ts` 62 行、`missionOperations.ts` 61 行、
`configOperations.ts` 18 行，其余多在 RFC-370 余项逐个避让的 `taskImage*` / `crewstation*` 里。

`missionOperations.ts`（722 行）与 `configOperations.ts`（684 行）是同一种形状：两组操作的合同（接口、输入 schema 与操作描述）早就在
application（`application/missionOperations.ts`、`application/configOperations.ts`，由 `public/operations` 转出），composition 里放的是它们的
实现——

- mission 操作：发起与预览、列表（游标分页与筛选校验）、详情投影（待答问题、协作、流水线证据）、需求文件、外部源刷新、取消与重试、
  决策轨迹、流水线证据分段读、交接三命令、切换（cutover）与接管已有 MR；
- 配置操作：五类配置资源（动作模板、验证配置、数字员工、自动化策略，以及转交的开发适配器）的列表、详情、创建、修订、发布、归档与
  ACL 行读取，员工剧本的读、改、校验，配置引导旅程，仓库指派，以及策略与员工选择的预览。

用例要离开 composition，还差两样东西：mission 用例取上传准入的基线解析时直接调用 infrastructure 的工厂；它要用的模块参与方接口
`DevelopmentAutomationModule` 声明在模块的 `composition.ts`，application 不许取 composition（类型也不行）。

## 2. 目标

- **G1 mission 用例归 application**：游标与筛选的 schema、辅助函数、用例的输入接口与持久化接口原样迁入
  `application/missionOperationHandlers.ts`（`createDevelopmentMissionOperations`）；基线解析与默认时钟改由 composition 给。用例要用的参与方
  成员成为 application 的端口 `ports/developmentMissionAutomation.ts`，`DevelopmentAutomationModule` 改为继承它（成员与类型不变）。
- **G2 配置用例归 application**：ACL 参与方接口、辅助函数与用例原样迁入 `application/configOperationHandlers.ts`
  （`createDevelopmentConfigOperations`）；默认时钟改由 composition 给。
- **G3 composition 只留装配**：两个文件只留组合输入类型、准入开关的查询投影与装配函数，不含任何控制流语句；bootstrap 与用例照旧从
  这里取装配函数与 ACL 参与方类型。
- **G4 账本与锁**：读这些文件源码的锁与登记改指新文件；`composition-control-flow-development-automation` 按实测收紧；新增 RFC-497 用例。

## 3. 非目标

- `graphDeliveryBridge.ts`（S10 下一步）、`activityOperations.ts` 与 development-automation `composition/` 的其余文件；其他模块的
  composition；S10 的全模块门。
- 两份合同文件（`application/missionOperations.ts`、`application/configOperations.ts`）与 `public/operations`；`taskImage*` / `crewstation*`
  一族（RFC-370 余项，逐个避让）。
- 拆分或改写两组用例；任何行为变化、接口、错误码、权限判定与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在新的 application 文件声明（早已存在的同名声明逐个钉住）；两个 composition 文件只声明、只交出
  组合输入类型、准入开关的查询投影与装配函数（配置一侧另外转出 ACL 参与方类型），没有控制流语句；`DevelopmentAutomationModule` 继承
  端口、只另外声明其余成员；没有文件从旧位置取迁出的名字。
- **AC-2**：同样输入下两组操作的返回、错误码、外部调用的次序与参数和此前一致（迁移逐字，现有用例对拍）；基线解析与时钟仍在装配时
  建一次，ACL 判定照旧经 Resource Catalog 交来的参与方。
- **AC-3**：新的 application 文件只取 zod、`ulid`、shared、`@/util/errors`、`@/util/log`、identity-access 的 `public/participants` 与本模块的
  domain / application / engine，不取 infrastructure、composition、IO 包与进程全局；跨 context 边、public surface 不升；
  `composition-control-flow-development-automation` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
