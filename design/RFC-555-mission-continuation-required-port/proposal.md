# RFC-555 development-automation 经 integration 的 required-ports 实现 Mission 续接（RFC-294 S9 第十步）

- **状态**：Done（2026-11-23，落地 `2263968b9`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 5 项（跨 context 内部文件对）与 design §14
  “跨 context 内部文件对 → 0”；形状取 design §2 / §3 / §3.5 的 consumer-owned required SPI（`composition/required-ports.ts` 只由 bootstrap 与
  指定 provider adapter 取），做法沿用 [RFC-399](../RFC-399-context-dag-platform-one-way/proposal.md)（resource-catalog 的 `integration-adapter`
  实现 integration 的 `IntegrationTriggerSnapshotFactory`）。

## 1. 背景

integration 的事件中心适配器消费“代码平台事件续接已有工作”的端口 `CodeHostEventContinuationPort`（consumer 自有，声明在 integration 的
`application/ports/codeHostEventResponse.ts`）；development-automation 用 Mission 的 MR 认领实现它（`infrastructure/missionCodeHostEventContinuation.ts`），
bootstrap 把实现交给 integration 的组合根。实现方为了标注返回类型，直接取了 integration 的 `application/ports`——跨 context 内部文件对精确清单
15 条中的一条。

RFC-294 对“consumer 自有、别的 context 实现”的端口有现成的目标形状：consumer 在 `composition/required-ports.ts` 交出端口类型，provider 在指定的
`application/adapters/<consumer>-adapter.ts` 里只按类型取它并实现，目标 DAG 用虚线 `implements` 边登记。development-automation → integration 不是
offered 边，所以也不宜改成取 integration 的 public——那只是把这一条换成一条 DAG 外的 offered 边（`off-dag-offered-file-context-pairs` 44 → 45）。

## 2. 目标

- **G1**：integration 的 `composition/required-ports.ts` 交出 `CodeHostEventContinuationPort`（类型转出；端口仍声明在 application/ports，integration
  自己的使用方不变）。
- **G2**：development-automation 新增指定 adapter `application/adapters/integration-adapter.ts`，只按类型取这个端口；Mission 续接的逻辑（按 MR
  认领匹配、唤醒判定、记唤醒提示）从 infrastructure 原样挪进来，依赖 Mission 的存储端口；infrastructure 只把数据库绑定上去。
- **G3**：目标 DAG 登记虚线边 development-automation implements `CodeHostEventContinuationPort` → integration（RFC-294 design §3.1 的 Mermaid 与
  `REQUIRED_CONTEXT_EDGES` 同批）。
- **G4**：跨 context 内部文件对 15 → 14；精确清单与减速带随之降低；其余计数不升。
- **G5 结局不变**：同一段逻辑、同样的装配，续接匹配与唤醒提示与原先相同。

## 3. 非目标

- 其余 14 条跨 context 内部文件对；development-automation 现有两条取 integration `public/participants` 的 DAG 外 offered 边（另案）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：development-automation 只在 `application/adapters/integration-adapter.ts` 里按类型取 integration 的 `composition/required-ports`；续接的
  infrastructure 文件不再取 integration。
- **AC-2**：行为与装配不变（Mission 续接的既有用例照常通过）。
- **AC-3**：目标 DAG 与 design 的 Mermaid 同批登记新虚线边；跨 context 内部文件对 15 → 14，精确清单与 `counts.json` 随之更新；新增 RFC-555 用例并
  登记 guard-manifest；读旧位置的用例随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
