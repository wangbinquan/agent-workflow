# RFC-494 实施计划

依赖：无硬前置；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的这四个文件）。按 CLAUDE.md 文首硬规则：先完成全部
实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-494-T1 合同与编解码迁入 domain**：`composition/employeeTypePackage.ts` 除登记对象外原样迁入 `domain/employeeTypePackage.ts`，
  `runtimePackage`、`WorkContract`、`ToolImplementation` 加 `export`（design D1）。
- **RFC-494-T2 三个依赖文件迁入 domain**：工具合同登记（改名 `digitalEmployeeToolContractRegistrationsV2.ts`）、工具结果投影、旧程序升级
  （design D2）。
- **RFC-494-T3 composition 只留登记对象**（design D3）。
- **RFC-494-T4 使用方与账本**：生产、用例与 e2e 的 import 改到新位置；读源码的锁随内容改指；`counts.json` 收紧、`commons-debt.json` 锚点
  重新定位（design D4）。
- **RFC-494-T5 用例**：新增 RFC-494 用例并登记 guard-manifest（design §4）。
- **RFC-494-T6 集中验证**：backend `tsc`、eslint（含 e2e）；RFC-494 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告
  对照；全仓旧位置扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-494-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新的 domain 文件声明；composition 只交出登记对象、三个旧文件不在；没有文件从旧位置取迁出的名字
- [ ] AC-2 同样输入下包语义、执行合同登记、上下文 schema、两个运行时编解码器与旧程序升级的结果与此前一致
- [ ] AC-3 新文件不取 infrastructure、application、composition、IO 包与进程全局；跨 context 边、public surface 不升；组合层控制流收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-494 开发自动化的员工类型包合同与编解码归 domain（RFC-294 S10 第一步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
