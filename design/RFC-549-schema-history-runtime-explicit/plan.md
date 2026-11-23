# RFC-549 实施计划

依赖：RFC-548。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-549-T1 绑定与类型**：`RuntimeSchemaBinding` 多 `history`，bootstrap 的绑定带上二进制的历史与替换口；删去 platform 的登记与读取函数
  （design D1、D3）。
- **RFC-549-T2 读取方**：各读取方显式收下历史，沿调用链交到最近的载体；Worker 的初始化消息必须带历史（design D2）。
- **RFC-549-T3 用例与夹具**：新增 RFC-549 用例并登记 guard-manifest；随改 design D4 所列用例、测试助手与 e2e 夹具。
- **RFC-549-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手、子进程夹具与
  两跳的测试助手（`docs/dev-gotchas.md` RFC-527 那条）与 `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；
  变异验证。
- **RFC-549-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十五步。

## 验收清单

- [ ] AC-1 `runtime.ts` 没有模块级状态；读历史的函数都由调用方显式交入；Worker 的初始化消息必须带历史
- [ ] AC-2 各处读到的历史与原先相同，迁移 / 恢复 / 备份 / 逻辑复制 / 启动准入的结局不变
- [ ] AC-3 模块级可变单例 39 → 37、计数不升；新增 RFC-549 用例并登记；读旧接口的用例与 e2e 夹具随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-548 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-549 schema 历史运行时由组合根显式交给 platform（RFC-294 S12 第二十八步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
