# RFC-497 实施计划

依赖：RFC-496（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/missionOperations.ts`、
`composition/configOperations.ts` 与 `composition.ts` 里模块参与方接口的声明）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-497-T1 mission 用例迁入 application**：第 55～98 行、输入接口、持久化接口与第 128～703 行的用例原样迁入
  `application/missionOperationHandlers.ts`；基线解析与时钟取输入，合同类型改取同层文件（design D2）。
- **RFC-497-T2 参与方端口**：用例用到的 10 个成员迁入 `application/ports/developmentMissionAutomation.ts`，`DevelopmentAutomationModule`
  改为继承它（design D3）。
- **RFC-497-T3 配置用例迁入 application**：第 54～152 行、输入接口与第 154～656 行的用例原样迁入 `application/configOperationHandlers.ts`
  （design D4）。
- **RFC-497-T4 composition 只留装配**：两个文件只留组合输入类型（形状不变）、准入开关的查询投影、装配函数与 ACL 参与方类型的转出
  （design D5）。
- **RFC-497-T5 锁、账本与清单**：读用例源码的锁改指新文件；`rfc305-architecture-lock` 的跨 context 使用方清单改指；`counts.json` 收紧
  （design D6）。
- **RFC-497-T6 用例**：新增 RFC-497 用例并登记 guard-manifest（design §4）。
- **RFC-497-T7 集中验证**：backend `tsc`、eslint；RFC-497 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-497-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新的 application 文件声明；两个 composition 文件只声明、只交出组合输入类型、准入开关的查询投影与装配函数
      （配置一侧另外转出 ACL 参与方类型），没有控制流语句；`DevelopmentAutomationModule` 继承端口、只另外声明其余成员；没有文件从旧
      位置取迁出的名字
- [ ] AC-2 同样输入下两组操作的返回、错误码、外部调用的次序与参数和此前一致；基线解析与时钟仍在装配时建一次，ACL 判定照旧经 Resource
      Catalog 交来的参与方
- [ ] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-496 转 Done 提交 `b549dcc5e` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-497 开发自动化的 mission 与配置操作用例迁出 composition（RFC-294 S10 第四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
