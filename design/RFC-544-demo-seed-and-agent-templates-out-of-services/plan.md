# RFC-544 实施计划

依赖：RFC-476。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-544-T1 演示种子**：`services/demoSeed.ts` 迁为 `bootstrap/demoSeed.ts`，`daemonApplication.ts` 改动态 import（design D1）。
- **RFC-544-T2 代理模板**：V2 声明迁入 `domain/developmentAgentTemplatesV2.ts`，旧版数据与纯函数迁入 `domain/legacyDigitalEmployeeAgentTemplates.ts`，
  两个用例迁入 `application/digitalEmployeeAgentTemplates.ts`，`public/participants.ts` 只转出，bootstrap 三个文件改取 public（design D2）。
- **RFC-544-T3 用例**：新增 RFC-544 用例并登记 guard-manifest；随改 design D3 所列用例。
- **RFC-544-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被迁名字与旧路径的字符串形态、读被改源码的测试助手与
  `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；
  变异验证。
- **RFC-544-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan §4.7 记“其余”一族第二步。

## 验收清单

- [ ] AC-1 `services/` 下没有这两个文件；迁入位置与分层按 design §3，bootstrap 只经 public 取用
- [ ] AC-2 内置代理对齐、公开模板列表、工具展示名、升级映射、工具配置与首启示例的结局不变
- [ ] AC-3 新增 RFC-544 用例并登记；钉着旧路径的用例与锁随改；减速带计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-544 演示种子与数字员工代理模板迁出 services/（RFC-294 §4.7 其余一族第二步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
