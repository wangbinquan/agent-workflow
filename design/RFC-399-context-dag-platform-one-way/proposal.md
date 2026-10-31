# RFC-399 恢复 context 值级 DAG 与 platform 单向依赖（RFC-294 S5 第一步）

- **状态**：Done（2026-10-31：提交 `950f5900b`，CI 补正 `2112b40fc`，exact SHA CI `41198759095` 全绿；验证见 plan「集中验证」）。
  落档记录（2026-10-31 落档。用户 2026-10-30「你继续推进RFC294，你可以使用codex进行调研和实现，过程中按你的判断来推进，
  不用询问我」：由本会话设计、交 Codex 实施并审核；规则取舍由本会话按推荐决定，见 §6。设计门免：逐处只读研究由 Codex 完成，
  本会话逐条对源码复核后定稿；实现门做一轮只审功能的 Codex 检视）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S5；design §3 常驻规则 7、§3.1、§14
- **基线**：HEAD `d7c5d5462`（= `origin/main`；行号只作定位提示，以实施时源码为准）
- **落位**：各 context 的 `application/ports`（consumer 自有端口）与 `application/adapters`（provider 实现）、`bootstrap/`（注入与维护
  作业装配表）、`platform/`（只留中立机制）

## 1. 背景

RFC-294 S5 的退出门是三条结构规则：context 值级依赖无环且 ⊆ design §3.1；`platform` 不 import `modules`；没有 drizzle / schema
再导出桶。RFC-395 已完成其中两步（任务生命周期写入迁回 task-execution、工作区 GC 策略离开 platform），三条规则仍都不成立。
在 `d7c5d5462` 上按 `tests/architecture/rfc294Gates.ts` 的口径计：

| 规则 | 现值 | 构成 |
| --- | --- | --- |
| context 值级 SCC | 2 | {collaboration, memory, resource-catalog, task-execution}；{development-automation, integration} |
| 越出 DAG 的值级 context 对 | 9 | 28 处值级 import，见 design §1 |
| `platform` → `modules` 文件对 | 19 | 5 个文件：维护作业分派、维护 Worker 效果、原生上传、磁盘维护、隔离工作区 |
| drizzle / schema 再导出桶 | 1 | `modules/task-execution/infrastructure/legacySqliteTransportMechanisms.ts`（`export * from 'drizzle-orm'`） |

9 对越界依赖各有来由，但没有一处是两个 context 真的需要双向同步：有的是常量或纯函数放错了 owner，有的是本该在 bootstrap
发生的跨域装配写在了某个模块的 composition / infrastructure 里，有的是 consumer 直接调了 provider 的实现而没有经过自己的端口。
platform 的 19 对里，14 对来自维护 Worker：作业分派表把十个模块的命令类型写进了 platform，效果选择把五个模块的端口类型写进了
platform。2026-10-30 进度对账（RFC-294 [review-2026-10-30](../RFC-294-backend-layered-target-architecture/review-2026-10-30.md) §3）
把 S5 列为阻塞已解除、可以开工的后继。

## 2. 目标

- **G1 context DAG**：context 值级 SCC 2 → 0，越出 DAG 的值级 context 对 9 → 0；design §3.1 的实线边集不变。
- **G2 platform 单向**：`platform` → `modules` 文件对 19 → 0，platform 不因此新增对 `bootstrap/` 的依赖。
- **G3 无再导出桶**：删除 `legacySqliteTransportMechanisms.ts`；`databaseMechanismDependencies` 判据原样保留。
- **G4 不绕门、不回退**：不以 `services/` legacy facade、同形本地类型、新 facade 或类型转导出替代真实注入；其余结构门不升，
  顺带下降的计数随实测压低上限（预期跨 context 内部文件对 88 → 约 73、越出 DAG 的 offered 文件对 61 → 约 52、`export *` 桶 23 → 22）。
- **G5 纯结构**：不改任何用户可见行为、错误码与错误文本、事务边界与次序、对象的构造时机与实例范围。

## 3. 非目标

- S5 范围里的另外三项，留给 S5 第二步：collaboration 对 task-execution 内部的引用改走 task 拥有的 tx-bound participant
  （现有 17 个文件对）、`services/humanGateComposition.ts` 收进 collaboration 装配、legacy `Actor` 退出模块 `public/` 合同。
- 经 `services/` legacy facade 的间接跨域依赖（W9-D）。本 RFC 不新增此类依赖；已知存量见 design §5，不在本批清理。
- composition 子文件里的实现迁往正确的层、workgroup 引擎迁入 task-execution（S6）。
- design §3.1 的实线边集调整；全部 61 条越出 DAG 的 offered 例外清零（本批只清与上述 9 对相关的部分）。
- 安全相关改动。

## 4. 用户可见变化

无。发布二进制、HTTP / MCP / WS 合同、数据库结构与迁移均不变。

## 5. 验收标准

- **AC-1 结构门**：`context-value-sccs`、`context-value-pairs-off-dag`、`platform-to-modules-file-pairs` 三个清单为空，
  `legacySqliteTransportMechanisms.ts` 不存在；`tests/architecture/rfc376-structural-guards.test.ts` 的提交基线、
  `architecture/counts.json` 的 max 与 `tests/architecture/rfc294-review-offered-edge-dag.test.ts` 的例外清单按实测下调，
  其余计数不升。
- **AC-2 不绕门**：本批触及的模块文件不新增对 `@/services/*` 的 import 来替代被删除的跨域 import；不新增 composition 禁止导入
  文件、模块级可变单例、`platform` → `bootstrap` 依赖；新增的 required-SPI provider 实现只 `import type` consumer 的
  `composition/required-ports`（结构测试锁定，见 design §4）。
- **AC-3 行为不变**：design §3 列出的既有用例全部通过且不改断言意图；因文件移动而改路径的测试只改 import 与构造方式；
  `rfc338-maintenance-mutations` 的变异继续作用于搬迁后的真实实现并能失败。
- **AC-4 DAG 文档同步**：本批新增的 required SPI 以虚线登记到 RFC-294 design §3.1 与 `rfc294Target.ts` 的
  `REQUIRED_CONTEXT_EDGES`（同一提交），`rfc294-design-parity` 通过。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **不改实线边集**：九对越界依赖全部以「归位」或「consumer 自有端口 + bootstrap 注入」解决；新增的只是 required-SPI 虚线。
2. **Agent 的执行契约端口规整归 resource-catalog domain**：它只按 Agent 自身 frontmatter 里的声明规整 Agent 的
   `outputs` / `outputKinds` / `outputWrapperPortNames` / `branchPorts`，不读契约注册表；默认结果端口名 `agent-result`
   提到 `@agent-workflow/shared`，两个 context 共用一个定义。
3. **代码托管仓库匹配器归 development-automation domain**：生产上只有它一个消费者，不满足进 platform / shared 的条件。
4. **workgroup 的两个宿主节点 ID 进 shared，driver 不迁**：退出门只需要这两个持久协议常量；3,300 行 driver 的归位属 S6。
5. **记忆快照的渲染 / 解码留在 memory**：task-execution 经自有端口取用，不把有领域语义的算法扩进共享层。
6. **托管 MCP 诊断只换依赖方向，不搬文件**：resource-catalog 定义诊断执行端口，bootstrap 用闭包把 task-execution 的 runner
   交给它；两个文件留在各自 composition 里，归位属 S6。（Codex 研究建议连同文件归位一起做，本会话收窄范围。）
7. **维护作业：作业体归 owner，bootstrap 只放装配表，platform 只按作业键调用注入的处理器**；不把整份分派表搬进 bootstrap
   （bootstrap 不得含业务分支），也不在 platform 写一份同形的模块命令类型（那会把业务编排留在 platform）。
8. **维护 Worker 效果：业务 selection 进 bootstrap，platform 留中立的描述符、作用域与构造 / 释放机制**。
9. **`repoRelForcedPaths` 归 `platform/workspace`**：它是隔离工作区的路径机制，platform 的隔离实现与 task-execution 都在用；
   不搬 1,972 行的 `isolation.ts`。（Codex 研究建议放 shared，本会话改放 platform：前端不用它。）
10. **被移走的实现不在原位置留 facade**：facade 本身就会保留被禁止的依赖。
11. **一个 RFC 两部分**（A：context DAG；B：platform 与再导出桶），分两次派发 Codex 实施，全部实现与用例完成后集中验证一次。
12. **偏离项**：落档时无；实施中接受的偏差见下条，逐条记录在 plan「实施记录」。
13. **实施中接受的偏差**（2026-10-31，本会话审核后决定）：
    - `services/taskCollab.ts` 删除而不是保留：A1 之后它已没有生产消费者，保留会让不可达文件 27 → 28；测试改为直接引用 collaboration。
    - A10 端口的渲染返回 `string | null`：沿用 memory domain 对空快照返回 `null` 的现有行为。
    - A7 的 RC 端口复用 runtime-management 的三个合同类型：这条类型依赖原在 RC composition 文件里，随端口迁入 `application/ports`，
      越界 offered 精确清单因此新增一条（`W4-E` 清偿），总数仍由 61 降到 54。
    - 维护作业体搬回 owner 后，TE / RC 作业体要用的三个 legacy 函数与 DE 内置工具目录的四个模板帮助改由 bootstrap 注入，
      模块不新增对 `services/` 的引用（RFC-317 R2 账本不增）。
    - `services/task.ts`、`services/upload.ts`、`services/humanGateContinuationEffects.ts` 新增 7 条 R1 记录：它们替换了同一 legacy
      文件原先经 TE composition 或 platform 的间接依赖，变得可见；R1 净减 2 条，归 W9-D。
    - DAG 新登记 17 条 required-SPI 虚线（工厂、作用域与子端口按实际类型名分别登记），多于落档时列出的 10 条。
    - 门函数 `contextPairsOffDag` 增加只供负例使用的 `throughServices` 选项，默认口径不变。
    - 维护作业处理器经各模块 `composition.ts` 交给 bootstrap，不走 design 原写的 `public/commands`：处理器签名带
      `@/platform/contracts/maintenanceJob` 类型，`rfc294-architecture-preflight` 的 W0-R 公共面精确账本不允许 public 合同
      出现 platform 类型，走 public 会新增 23 条偏差。只给 bootstrap 用的出口走 composition，与 `runDigitalEmployeeOsCycle` 同形。
    - SO `backupPrune` 在没有数据库备份实现时清理本地 `backups/` 目录，这段搬到 `system-operations/infrastructure/local/localBackupPrune.ts`，
      由 SO composition 注入作业体：`rfc346-system-operations-contracts` 禁止 SO application 层引用 `node:path`。
