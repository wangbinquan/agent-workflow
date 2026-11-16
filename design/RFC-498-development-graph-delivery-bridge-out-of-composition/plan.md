# RFC-498 实施计划

依赖：RFC-497（Done）；与 S12 共用模块 composition 文件（本 RFC 只删 development-automation 的 `composition/graphDeliveryBridge.ts`，改
`composition/graphDevelopment.ts` 里取它的一条 import 与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-498-T1 用例迁入 application**：第 29～153 行与第 155～702 行原样迁入 `application/graph-development/deliveryBridge.ts`；`now`
  必填，开作用域改用 `withSelectedAutomationWorkspaceEffects`，import 按新目录改写（design D2）。
- **RFC-498-T2 composition**：删除 `composition/graphDeliveryBridge.ts`；`graphDevelopment.ts` 改取新文件、调用加 `now: Date.now`
  （design D3）。
- **RFC-498-T3 锁、账本与清单**：`rfc396-mr-bridge` 改取新文件、两处直接建用例加 `now`；`counts.json` 收紧（design D4）。
- **RFC-498-T4 用例**：新增 RFC-498 用例并登记 guard-manifest（design §4）。
- **RFC-498-T5 集中验证**：backend `tsc`、eslint；RFC-498 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-498-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新文件声明；`composition/graphDeliveryBridge.ts` 不存在、没有文件从旧位置取名字；`graphDevelopment.ts` 从新
      文件取用例、恰好调用一次并交出默认时钟
- [ ] AC-2 同样输入下交付四个方法与照看方法的返回、错误码、持久化与外部调用的次序和参数和此前一致；临时上传的搬运用的仍是装配时交来的
      同一个工厂
- [ ] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-497 转 Done 提交 `b84ac06c2` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-498 开发自动化的图交付桥用例迁出 composition（RFC-294 S10 第五步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
