# RFC-552 实施计划

依赖：RFC-551。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-552-T1 判据**：`publicSurfaceViolations` 不再整体跳过 `public/operations`，按 design §1 处理合同类型 import 与描述工厂。
- **RFC-552-T2 收口**：knowledge-evolution 的运维函数改由 composition 转出、bootstrap 改取；`OwnerIdentityQueries` 移到 identity-access
  `public/queries`（design §2）。
- **RFC-552-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 按实测更新并写明来由；新增 RFC-552 用例并登记 guard-manifest；随改读旧
  位置的用例。
- **RFC-552-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；先跑读源码文本的用例，再按 RFC-533 的口径与 RFC-550 的选法选用例；
  架构报告对照；变异验证。
- **RFC-552-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第八步。

## 验收清单

- [ ] AC-1 检测器不再整体豁免 `public/operations`；合同类型 import 与描述工厂按 design §1 处理
- [ ] AC-2 knowledge-evolution 的运维函数不再从 public 导出、bootstrap 改取 composition；`OwnerIdentityQueries` 在 `public/queries`
- [ ] AC-3 显形的偏差逐条入账并写明后继；`public/operations` 的导出逐条入账；新增 RFC-552 用例并登记
- [ ] AC-4 行为不变；受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-551 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-552 public/operations 的类型检查豁免收窄到操作描述工厂（RFC-294 S9 第八步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
