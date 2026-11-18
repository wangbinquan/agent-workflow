# RFC-504 实施计划

依赖：RFC-503（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 resource-catalog 的 `composition/builtinWorkflowCatalog.ts`，改
`composition/intentContextAuthorization.ts`、`composition/mcpOperations.ts`、`composition/resourcePackageOperations.ts`、
`composition/workgroupTaskRoom.ts` 与 resource-catalog `composition.ts` 的一条转出，改 bootstrap `daemonModules/digitalEmployee.ts` 与
`daemonHttpComposition.ts` 的 import 与调用）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态
自查。

## 任务

- **RFC-504-T1 用例归 application、IO 归 infrastructure**：资源包暂存、任务房的两个端口实现（连同两个端口接口）、意图上下文的授权核对迁入
  application，内建工作流目录与 MCP 的 ACL 测试失效迁入 infrastructure；工厂改名为 `create…`，资源包暂存的 id 改为传入（design D2）。
- **RFC-504-T2 composition 只装配**：删除 `composition/builtinWorkflowCatalog.ts`，经 `composition.ts` 转出、bootstrap 改取；四个组合文件只留
  装配入口与转出（design D3）。
- **RFC-504-T3 锁与账本**：改钉 `rfc401`、`rfc345` 的四处、`rfc231`、`rfc390`、`rfc305`；两个用例辅助改 import；`counts.json` 收紧（design D4）。
- **RFC-504-T4 用例**：新增 RFC-504 用例并登记 guard-manifest（design §4）。
- **RFC-504-T5 集中验证**：backend `tsc`、eslint；RFC-504 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-504-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新位置声明（同名类型钉在原处）；删除的组合文件不存在、没有文件从它取名字；改名前的名字没有声明；四个
      组合文件没有控制流
- [ ] AC-2 同样输入下五组行为的结果、错误与端口调用和此前一致；bootstrap 拿到的是同一份实现；资源包暂存与应用的 id 同源
- [ ] AC-3 新位置的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-resource-catalog` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-503 转 Done 提交 `d0bcbd1c8` 的 CI）；实现与验证后再
提交 `refactor(backend): RFC-504 资源目录的内建工作流、资源包暂存、任务房协作、意图上下文授权与 MCP 测试失效迁出 composition（RFC-294 S10
第十一步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
