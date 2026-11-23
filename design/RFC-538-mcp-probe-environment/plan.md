# RFC-538 实施计划

依赖：RFC-537。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-538-T1 探测环境**：`mcpProbeOperations.ts` 删去模块级变量、测试接缝函数与 `mcpProbeNow`，改为 `createMcpProbeEnvironment(options?)`、
  `createInProcessMcpProbeRunner(environment)` 与带 `now` 的 `composeMcpProbeOperations`；`composition.ts` 的转出随改（design D1）。
- **RFC-538-T2 组合根**：`daemonApplication.ts` 每份应用建一份环境（选项来自 `testSeams.mcpProbeOptions`），交给 observation 模块的 MCP 诊断、
  资源目录模块的写入时钟与 HTTP 组装的探测用例（design D2）。
- **RFC-538-T3 用例与锁**：新增 RFC-538 用例并登记 guard-manifest；provider HTTP 测试助手、四个用例与两处锁随改（design D3）。
- **RFC-538-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照；变异验证。
- **RFC-538-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第六步。

## 验收清单

- [ ] AC-1 `mcpProbeOperations.ts` 没有模块级状态与测试接缝函数；组合根为每份应用建一份探测环境，三处用同一份
- [ ] AC-2 探测与写入的结局不变；两份环境各用各的选项与时钟，选项在每次探测时读取
- [ ] AC-3 模块级可变单例 56 → 55、计数不升；锁随改；新增 RFC-538 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-537 转 Done）；实现与验证后再提交
`refactor(backend): RFC-538 MCP 探测的选项与时钟随应用走（RFC-294 S12 第十九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
