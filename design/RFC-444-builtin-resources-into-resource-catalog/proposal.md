# RFC-444 内建资源清单归 resource-catalog（RFC-294 W4 B / D 第十步）

- **状态**：Done（2026-11-04；`98cd1706f`，exact SHA 主 CI run 41881968088：attempt 1 macOS e2e 分片 3/4 拿到 runner 后 1 failed / 2 flaky（RFC-396 订票旅程与 RFC-372 两条录制旅程在慢 runner 上点击超时，audit-backlog 已记的贴线长旅程，本 RFC 不触及其路径），分片 2/4、4/4 未被分配 runner；只重跑失败作业，attempt 2 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D（并清偿 W4-C 遗留的两条 R2 边）
- **前序**：[RFC-443](../RFC-443-oidc-into-auth/proposal.md)（OIDC 提供方服务与开通策略归 auth/oidc）
- **落位**：resource-catalog 的 `domain/systemResources.ts`，经 `public/types` 给模块外。

## 1. 背景

`services/systemResources.ts`（85 行）是框架内建资源（`aw-skill-merger` 代理、`aw-skill-fusion` 工作流）的唯一清单与 RFC-104 只读锁：
id / name 常量、「内建资源不在列表里显示」的两个过滤器、`isBuiltinRow` 与 `assertNotBuiltin`。归属表登记为 resource-catalog，
它只依赖共享合同与 `@/util/errors`，是纯规则。

它在 legacy 层，引用方却横跨多处：

- 路由 `routes/resourceAcl.ts`（只因它 import `services/`）与 `routes/agents.ts`；
- resource-catalog 自己的三个 composition 文件；
- task-execution 的两个 infrastructure 文件、bootstrap 一处、两个 legacy service；
- knowledge-evolution 的 `application/fusionOrchestration.ts`：两条 `R2-outbound-module-to-legacy` 账本边（KE-03，RFC-353 偏离项③，
  当时注明「随 resource-catalog 的内建资源播种面处理」）。其中一条是生产里已没有消费者的兼容再导出（注释说为「`@/services/fusion` 的
  importer」保留，而该文件已不存在；只剩两个用例经它取两个 name 常量）。

## 2. 目标

- **G1**：`services/systemResources.ts` 原样迁为 resource-catalog `domain/systemResources.ts`；`public/types` 转出模块外需要的常量与
  `assertNotBuiltin`。
- **G2**：resource-catalog 内部改相对路径；task-execution、knowledge-evolution、bootstrap、路由与 legacy service 经 `public/types` 取用；
  knowledge-evolution 的 `QUARANTINED_FUSION_SKILL_ID` 直接取共享合同（原样转出的正是它）。
- **G3**：删去 knowledge-evolution 里生产已无消费者的兼容再导出，两个用例改从清单本身取常量。
- **G4 行为不变**：内建资源的 id / name、列表过滤与只读锁的判定和错误全部不变。
- **G5 不留 facade**：原文件删除。

## 3. 非目标

- 内建资源播种改为 participant（RFC-353 偏离项③所说的整个资源创建面）。
- 其余 9 个路由的 `services/` 依赖。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/systemResources.ts` 不再存在，源码里没有对它的 import；新文件在 resource-catalog domain，模块外经 `public/types`。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 10 → 9（`resourceAcl`）；
  - `R2-outbound-module-to-legacy` 41 → 39（KE-03 两条）；
  - `services/` 文件 221 → 220；
  - 不新增 DAG 之外的 context 边（task-execution、knowledge-evolution → resource-catalog 均在 RFC-294 的 offered 边里）。
- **AC-3**：内建资源只读锁、列表隐藏、技能融合、迁移字面值与 ACL 端点的用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **放 domain，不放 application**：清单与只读判定是纯规则（只依赖共享合同与错误类型），domain 已有同类文件（如 `resourceAccess.ts`）
   经 `public/types` 转出。
2. **`public/types` 只转出模块外实际用到的符号**（四个 id / name 常量与 `assertNotBuiltin`）；两个列表过滤器与 `isBuiltinRow` 只在
   resource-catalog 内部用，不扩大 public 面。
3. **删除兼容再导出**：唯一的说明是给已不存在的 `@/services/fusion` 保路径，生产里没有消费者；两个用例改从清单本身取常量。
   留着它只会多一条 R2 边。
