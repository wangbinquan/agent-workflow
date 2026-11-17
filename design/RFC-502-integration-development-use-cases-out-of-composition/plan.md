# RFC-502 实施计划

依赖：RFC-501（Done）；与 S12 共用模块 composition 文件（本 RFC 改 integration 的 `composition/developmentAdapterConfigOperations.ts`、
`composition/codeHostEffects.ts`、`composition/approvalGateway.ts`、`composition/digitalEmployeeToolConnections.ts` 与
`infrastructure/developmentToolConnectionStore.ts`，不改 bootstrap 与 `composition.ts`）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-502-T1 用例归 application**：四组用例原样迁入 application 的四个新文件，工具连接 store 的接口迁入 `application/ports/`，工厂改名为
  `create…`（design D2）。
- **RFC-502-T2 composition 只装配**：四个组合文件只留装配入口，审批的两条装配共用一份投影；infrastructure 的工具连接 store 改取端口文件
  （design D3）。
- **RFC-502-T3 锁、账本与注释**：6 个用例改取新位置；`rfc344`、`rfc321`、`rfc471`、`rfc466`、`rfc497` 改读新文件或两处都读；
  development-automation 的两处注释改写；`counts.json` 收紧（design D4）。
- **RFC-502-T4 用例**：新增 RFC-502 用例并登记 guard-manifest（design §4）。
- **RFC-502-T5 集中验证**：backend `tsc`、eslint；RFC-502 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-502-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新文件声明；四个组合文件只声明允许的装配入口、没有控制流；改名前的名字与私有投影、目录函数没有
      声明；store 接口只在端口文件声明
- [ ] AC-2 同样输入下四组用例的结果、错误码与端口调用和此前一致；bootstrap 取到的装配入口不变；审批的两条装配共用一份投影
- [ ] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-501 转 Done 提交 `183febdb9` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-502 集成的开发适配器配置、代码托管交付、审批网关与工具连接目录迁出 composition（RFC-294 S10 第九步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
