# RFC-293 设计演进记录

> 本页及 `history-*` 文件是只读过程证据，不是现行产品合同。RFC-293 的有效规范仍是同目录下不带
> `history-` 前缀的 `proposal.md`、`design.md` 与 `plan.md`。

## 阶段 1：第一轮源码设计门

- 时间：2026-08-12
- 隔离 worktree：`agent-workflow-rfc293-design-gate-019ff60c`
- pinned baseline：`90602fc81347ed7a6cef6893a3d79cbbad813b85`
- 结果：第一轮评审为 `FAIL（12 P1 + 1 P2）`；当时尚未修改生产代码。
- 快照：
  - [proposal](./history-01-proposal.md)
  - [design](./history-01-design.md)
  - [plan](./history-01-plan.md)
  - [design gate](./history-01-design-gate.md)

## 阶段 2：第二轮修订与待复审稿

- 时间：2026-08-12 至 2026-08-13
- 隔离 worktree：`agent-workflow-rfc293-final-gate-cYuK3A`
- worktree baseline：`fcead748024d644ab9a42282f74c20f458d0ac4f`
- 结果：文档继续吸收第二轮 findings；设计门记录最终仍为 `Pending`，没有成为获批的生产合同。
- 快照：
  - [proposal](./history-02-proposal.md)
  - [design](./history-02-design.md)
  - [plan](./history-02-plan.md)
  - [design gate](./history-02-design-gate.md)

## 最终用户裁决与实现

2026-08-13，用户明确要求跳过设计门收缩，以其产品要求为准：只实现功能与 UX，Intent 继续复用普通
system-agent runtime，不新增 sealed/sandbox、credential/auth adapter、containment、capture quarantine、
历史清洗或 Intent-only 能力限制。现行三件套据此重写，功能提交为 `53c57080`，完成记账为
`b2e0a799`。

两阶段快照特意保留了后来被取代的约束与 findings，用于解释设计如何演进；它们不得被实现或评审工具当成
RFC-293 的当前验收条件。
