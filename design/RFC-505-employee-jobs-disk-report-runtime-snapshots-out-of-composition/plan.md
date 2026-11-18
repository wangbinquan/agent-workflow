# RFC-505 实施计划

依赖：RFC-504（Done）；与 S12 共用模块 composition 文件（本 RFC 改 digital-employee 的 `composition/builtinJobTemplates.ts`、
system-operations 的 `composition/maintenanceDisk.ts` 与 runtime-management 的 `composition/runtimeSelection.ts`；三个装配入口不变）。按
CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-505-T1 用例归 application、IO 归 infrastructure**：内建作业模板的确保迁入 digital-employee `application/builtinEmployeeJobs.ts`（时钟
  传入），运行时快照表迁入 runtime-management `application/runtimeSelection.ts`，PostgreSQL 磁盘报告迁入 system-operations
  `infrastructure/postgresqlMaintenanceDisk.ts`（design D2）。
- **RFC-505-T2 composition 只装配**：三个组合文件的装配入口改为从新位置取实现（design D3）。
- **RFC-505-T3 账本**：`counts.json` 三项收紧；guard-manifest 登记（design D4）。
- **RFC-505-T4 用例**：新增 RFC-505 用例（design §4）。
- **RFC-505-T5 集中验证**：backend `tsc`、eslint；RFC-505 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-505-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新位置声明；三个组合文件没有控制流、从新位置取实现；装配入口不变
- [ ] AC-2 同样输入下三组行为的结果、错误与端口调用和此前一致；时钟仍在调用时取、每处一次
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；三项 `composition-control-flow-*` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】
