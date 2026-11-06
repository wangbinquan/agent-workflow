# RFC-459 owner 作用域名与代理启动保留归 resource-catalog（RFC-294 W9-D 第六步）

- **状态**：Done（2026-11-06，落地 `6f47af807`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-458](../RFC-458-envelope-parser-to-shared/proposal.md)（信封解析器归 shared，`services/` 84 → 82）。
- **落位**：resource-catalog 的 `application` / `infrastructure` / `public/participants`；用例 helper。

## 1. 背景

`services/` 里还有三件归属清楚、却靠 `services/` 转手的小东西：

- **owner 作用域名**（`services/ownerScopedName.ts`）：经典资源（代理、技能、MCP、插件）「同一 owner 下名字唯一」的 NULL 安全谓词
  （`COALESCE(owner_user_id, '')` + name，配 0118 迁移的表达式唯一索引）与唯一冲突判定。实现放在 identity-access
  （`infrastructure/ownerScopedName.ts` 的 `ownerScopedNameCondition`、`application/ownerScopedName.ts` 的 `isOwnerScopedNameConflict`），
  identity-access 自己一处都不用；唯一的生产使用者是 resource-catalog（技能的两处），经 `services/` 转手取 identity-access 的 composition
  与 public（resource-catalog → identity-access 不是目标 DAG 给的边）。`commons-manifest` 早把这一条记在 resource-catalog 名下。
- **代理启动保留**（`services/agentLaunchReservation.ts`）：进程内引用计数表，task-execution 的单代理启动在物化工作区到写任务行之间
  持有代理 id，resource-catalog 的代理删除在有启动持有时拒绝（`agent-launching` 409）。两个模块都直取 `services/`。
- **身份门面**（`services/userIdentities.ts`）：RFC-036 / RFC-349 留下的兼容门面，生产代码零引用，只剩 7 个用例在用；它取
  identity-access 的 composition（`R1` 1 条）。

## 2. 目标

- **G1 归位**：owner 作用域名的谓词与冲突判定迁入 resource-catalog（`infrastructure/ownerScopedName.ts` 与 `application/ownerScopedName.ts`，
  两个兼容名 `ownerScopedNameWhere` / `isOwnerNameUniqueViolation` 一并迁入），identity-access 删去这两份实现与 composition / public 的再导出；
  代理启动保留迁入 resource-catalog `application/agents/agentLaunchReservation.ts`，task-execution 经 resource-catalog `public/participants`
  取 `acquireAgentLaunch` / `releaseAgentLaunch`（task-execution → resource-catalog 是目标 DAG 给的边）；身份门面迁入用例 helper。三个
  `services/` 文件删除。函数体原样。
- **G2 账本下降**：`R1` 101 → 99；不新增目标 DAG 之外的边、跨 context 内部文件对、`module-layer-violations` 与不可达生产文件；public surface
  identity-access −1（`isOwnerScopedNameConflict`）、resource-catalog +2（两个闭合签名的函数），偏差数不升。
- **G3 行为不变**：保留表仍是进程内唯一一份（resource-catalog 的删除守卫与 task-execution 的启动读写同一个表）。

## 3. 非目标

- resource-catalog 里代理 / 插件 / MCP 三个仓储各自的私有 `ownerScopedNameWhere`、ACL 内核手抄的两半（P3 发现 ACL-10）——去重留给 ACL
  继任合同那一刀；本 RFC 只把锚点改指新位置。
- `resourceAcl`、`nodeRunMint` / `systemAgentRun`、`commitPushRunner` 等其余 `R1` 来源；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个旧文件不在，`src/`、用例与脚本零引用旧路径；identity-access 不再有 owner 作用域名的实现与再导出；保留表只有 resource-catalog
  一份，task-execution 取到的就是它。
- **AC-2**：架构计数按实测：`services/` 82 → 79，`R1` 101 → 99（账本逐条相等），`R2` 不变；越界类计数不升，public surface 偏差不升。
- **AC-3**：受影响用例（owner 名冲突判定两引擎一致、技能唯一性、代理删除的启动守卫、单代理启动、身份门面的 7 个用例、public 导出清单锁）
  全部通过；新增 RFC-459 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **owner 作用域名归 resource-catalog，不留 identity-access、也不进 `platform`**：唯一索引建在资源表上，判定按资源表与索引名匹配，使用者
   全在 resource-catalog；identity-access 自己不用，留着只会逼 resource-catalog 越界取它。
2. **保留表放 resource-catalog `application`，经 `public/participants` 给 task-execution**：resource-catalog → task-execution 不是目标 DAG
   给的边，表只能归 resource-catalog；它是纯内存的进程内协调（无 IO），与删除守卫同处；两个函数签名闭合（`string → void`）。
3. **身份门面迁入用例 helper，不保留在生产代码**：生产零引用，它的意义只剩给老用例一个 db 形参的入口。RFC-375 §4 把
   `services/userIdentities.ts` 列为「需用户决定」的保留项，理由是 `rfc212-revalidation-behavior` 的锚点在它上面；本 RFC 不删代码，
   而是整体迁入 `T/helpers/userIdentities.ts`，`rfc212` 的锚点随之改指（与同一张表里已迁入 `T/helpers/auth/` 的 legacy session / PAT
   store 同式），按用户 2026-11-02 的授权由本会话决定，可推翻。
