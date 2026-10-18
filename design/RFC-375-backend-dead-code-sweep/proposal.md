# RFC-375 后端死代码清扫（RFC-294 S3）

- **状态**：In Progress（2026-10-17 立项；用户授权设计完成后直接交 Codex 执行，免设计门与实现门，由本会话审核执行正确性）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S3；review-2026-10-16 F8
- **基线**：HEAD `b76a88e70`（行号仅作定位提示）
- **落位**：跨 context 的删除批：development-automation、digital-employee、collaboration、code-capability、task-execution、
  resource-catalog、event-center、integration、intent、runtime-management、`platform/persistence`、legacy `services/`

## 1. 背景

RFC-294 的 2026-10-16 审视（F8）指出后端存在大量没有生产 consumer 的代码：无实现无调用的端口、只被测试 import 的
`services/` 文件、从入口不可达的生产文件、没有生产调用方的定时器启动函数。它们让后续 S5 / S6 / W4 / W9 要迁移、要对账的
面变大，也让「这段代码在不在用」需要反复人工判断。

本 RFC 在 HEAD 上用真实 import 图（TypeScript AST；值、类型、`export … from`、字面量 `import()` / `require()`、
`import('x').T`、Worker 的 `new URL(…, import.meta.url)`；入口取自 `scripts/build-binary.ts`：`main.ts` 与 4 个 Worker 入口及
两个独立打包的助手）复核：后端 2,375 个文件中 92 个从入口不可达（91 个 TS 文件 7,413 行，外加一个被嵌入的 `.mjs` 资产，
它不是死代码）。

## 2. 目标

- **G1** 删除经核实无生产 consumer、且没有被既有 RFC 明确保留的代码（清单见 design §2），总计约 70 个文件、约 5,000 行，
  外加若干符号级删除。
- **G2** 只测死代码的测试随之删除；覆盖仍然存在的行为的测试改指向现行实现（同一行为，换 import 或换入口）。
- **G3** 零产品行为变化：不改任何 API、MCP、路由、WS、事件、schema、错误码或后台作业行为。
- **G4** 记录「为什么保留」的清单：仍不可达但有明确理由保留的文件逐个写明理由与后继，作为 RFC-376 入口可达性门的初始例外。

## 3. 非目标

- 不删除既有 RFC 明确决定保留的代码：`services/driverLease.ts`（RFC-328/108 的历史合同）、注入行为 oracle 七件套
  （RFC-349/359「退役前作为 oracle」）、`postgresqlTaskLifecycleTransaction.ts`（RFC-359 §5hn「不删」）。是否推翻这些决定
  需要用户另行决定。
- 不动 RFC-370 的兼容地址与只被 RFC-370 测试使用的文件（`services/runner.ts` 一族、`customEventObserverProgram.ts`、
  `mcpDiagnosticsEffects.ts`、`composition/systemAgentRun.ts`、`services/scriptDepsEnv.ts`、development-automation 的三个
  兼容包装），留给 RFC-370 收口或后续批次。
- 不修剪仍在使用的 `services/` 门面中的单个导出名（属 W9-D），不处理「仅被类型边触达的文件中的运行时死值」。
- 不迁移 collaboration 中依赖 composition 助手的 public 包装函数（直接移入 application 会违反分层，留给 S5）。
- 不触碰 git 族文件（RFC-377 独占）、node-run 新旧判定相关文件（RFC-374）、架构治理文件（RFC-376）。
- 不做任何安全相关改动。

## 4. 用户故事

- 作为后续 RFC-294 后继（S5 / S6 / W4 / W9）的实施者，我面对的待迁移面更小，不会再把时间花在已经没人调用的实现上。
- 作为代码阅读者，`services/` 与模块 `public/` 里看到的符号都有真实调用方。

## 5. 验收标准

- **AC-1** design §2 清单中的文件与符号全部删除，删除前逐项以当时 HEAD 复核「生产 importer = 0」。
- **AC-2** design §3 的测试改动完成：删除只测死代码的测试；改指向的测试针对现行实现运行并通过。
- **AC-3** 重新计算的入口可达性中，仍不可达的生产文件只剩 design §4 的保留清单（每项有理由与后继）。
- **AC-4** typecheck、lint、depcheck 通过；受影响测试全绿；推送后 exact SHA 的 GitHub Actions 为准。
- **AC-5** 无 API / MCP / 路由 / 事件 / schema 变化（改动文件中不含路由注册、操作描述符、迁移或 schema）。

## 6. 能力影响

无。删除对象都没有生产调用方；定时器启动函数的作业主体仍经 maintenance Worker、provider runtime session 等现行路径运行。
