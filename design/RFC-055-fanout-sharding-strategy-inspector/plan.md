# RFC-055 Plan — 任务分解与 PR 拆分

> 状态：Draft（2026-05-21）
> 上游：[proposal.md](./proposal.md) / [design.md](./design.md)

## 0. 一句话范围

补齐 `agent-multi` 节点的 sharding strategy UI 入口（NodeInspector 抽屉新增 `<Select>` + 条件 `<NumberInput>`），同时在 shared 抽纯函数、backend 加 validator 规则、workflow GET 接 backfill，让 v1 三种策略全部可达。**单 PR**。

## 1. 任务清单

| 编号       | 任务                                                                                  | 依赖     | 估算 | 产物                                                                 |
| ---------- | ------------------------------------------------------------------------------------- | -------- | ---- | -------------------------------------------------------------------- |
| RFC-055-T1 | 新建 `packages/shared/src/sharding.ts`：类型 + `validateShardingStrategy` / `normalizeShardingStrategy` / `applyShardingBackfill` / `DEFAULT_SHARDING_STRATEGY` 4 个符号；`packages/shared/src/index.ts` re-export | —        | 0.3d | sharding.ts + index.ts 改动；编译通过                                |
| RFC-055-T2 | 纯函数单测 `packages/shared/tests/sharding.test.ts`：13 case 全绿（design.md §7.1）   | T1       | 0.3d | 13 case；`bun test --filter @aw/shared` 全绿                         |
| RFC-055-T3 | 新建 `packages/frontend/src/components/canvas/ShardingStrategyField.tsx`：复用 `<Select>` / `<Field>` / `<NumberInput>` 公共组件，禁止原生 `<select>`（RFC-035） | T1       | 0.4d | 组件文件 + i18n 调用                                                 |
| RFC-055-T4 | i18n key 中英双语：`fieldShardingStrategy` / `fieldShardingStrategyHint` / `shardingKind.{perFile,perNFiles,perDirectory}` / `fieldShardingN` / `fieldShardingNHint` / `fieldShardingDepth` / `fieldShardingDepthHint`（8 个） | —        | 0.2d | en-US.ts + zh-CN.ts type 接口 + 实文案                               |
| RFC-055-T5 | 接入 `NodeInspector.tsx`：agent-multi 段紧跟 SourcePortField 下方挂 `<ShardingStrategyField>`；readOnly 透传 | T3, T4   | 0.2d | NodeInspector.tsx diff ~10 行                                        |
| RFC-055-T6 | JSDOM Inspector 集成测 `packages/frontend/tests/canvas-sharding-inspector.test.ts`（design.md §7.2，约 8 case + 源代码层兜底） | T5       | 0.5d | 测试文件                                                             |
| RFC-055-T7 | 后端 validator 追加 2 条规则（`agent-multi-sharding-missing` warning / `-invalid` error），引用 T1 的 `validateShardingStrategy` | T1       | 0.2d | workflow.validator.ts diff                                           |
| RFC-055-T8 | validator 单测 `packages/backend/tests/workflow-validator-sharding.test.ts`（design.md §7.3，4 case） | T7       | 0.2d | 测试文件                                                             |
| RFC-055-T9 | workflow GET 路径接 `applyShardingBackfill(def)`（`packages/backend/src/services/workflow.ts`） | T1       | 0.1d | service diff 1 行 + 1 case 补到 workflow service 既有测试            |
| RFC-055-T10 | scheduler 端到端测 `packages/backend/tests/scheduler-fanout-sharding.test.ts`（design.md §7.4，3 case） | T9       | 0.4d | 测试文件                                                             |
| RFC-055-T11 | 三件套 + push + CI 验证：`bun run typecheck && bun run test && bun run format:check` 全绿；推 push 后查 GitHub Actions（含 build-binary smoke + Playwright e2e）全绿 | T2/T6/T8/T10 | 0.2d | commit + CI run id                                                   |

**总估算**：~3.0d 单人。

## 2. 依赖关系

```
T1 ──┬──> T2 (shared tests)
     ├──> T3 (UI component)
     ├──> T7 (backend validator)
     └──> T9 (backfill in GET)
T3 ──┐
T4 ──┴──> T5 (NodeInspector wiring) ──> T6 (JSDOM tests)
T7 ──────────────────────────────────> T8 (validator tests)
T9 ──────────────────────────────────> T10 (scheduler e2e)
T2 / T6 / T8 / T10 ──> T11 (three-check + CI)
```

T1 是关键路径起点，落档后 T2/T3/T7/T9 可并行。

## 3. PR 拆分建议

**默认单 PR**。理由：

- 全部改动加起来 < 800 行，且强耦合（UI 字段、纯函数、validator 规则、backfill 是一个语义闭环；拆开任一项都让另一半失语境）。
- RFC 工作流 §5 默认"单 RFC 单 PR"。

**例外**：若 review 反馈建议拆，按以下顺序：

- PR-A：T1 + T2（shared 模块 + 单测）—— 零产品风险，先合
- PR-B：T7 + T8 + T9 + T10（backend validator + backfill + 端到端）—— 依赖 A
- PR-C：T3 + T4 + T5 + T6（前端组件 + i18n + Inspector wiring + JSDOM 测）—— 依赖 A

PR-A 合后 PR-B/PR-C 可并行评审。

## 4. 验收清单（合并前必过）

按 [CLAUDE.md "Test-with-every-change"] 与 [feedback_post_commit_ci_check]：

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（含新增 13 + 8 + 4 + 3 = 28 case 全绿；既有 595+ 单测零回归）
- [ ] `bun run format:check` 全绿
- [ ] GitHub Actions 全绿（Lint+Typecheck+Test / Static scans / Build single-binary smoke ubuntu+macOS / Playwright e2e / Markdown link check / patch coverage / design link check）
- [ ] 手动跑一次 dev server（[run] skill）→ 打开任意 agent-multi 节点抽屉验证：
  - sourcePort 字段下方出现"分片策略"Select
  - 默认显示 per-file（backfill 工作）
  - 切 per-n-files → 出现 N 输入；输 N=5 → 节点 def 写入 `{kind:'per-n-files',n:5}`
  - 切 per-directory → 出现 depth 输入；空 depth → 写入 `{kind:'per-directory'}`
  - 切回 per-file → 第二行字段消失
  - readOnly 抽屉（task 详情）下所有 input disabled
- [ ] 视觉对齐自查（RFC-035 §4 操作规程第 4 条）：与 sourcePort / retries / timeoutMs 等周边字段的 spacing / 圆角 / 字号一致
- [ ] STATE.md 顶部"进行中 RFC"行更新；plan.md RFC 索引表 RFC-055 状态从 Draft → In Progress → Done
- [ ] commit message：`feat(canvas): RFC-055 agent-multi sharding strategy inspector`

## 5. 回滚预案

单 PR 直接 `git revert` 即恢复 "Inspector 无 sharding 入口、scheduler `undefined → per-file` 兜底" 现状；零 schema / DB 改动，老 workflow / task / runtime 不受影响。

## 6. 显式非目标（不在本 RFC，留给后续 RFC）

- sharding 预览面板（编辑态实时算 shard 数）—— 需要 launcher commit 数据
- 自定义策略（grep filter / size bucket / commit-based）—— v2 能力
- YAML import 时友好错误提示 —— 复用 T1 的 `validateShardingStrategy` 写在 import dialog 即可，本 RFC 不动 import 路径
- 画布 MultiProcessAgentNode 上多印一行 sharding 配置 —— 与 RFC-006 紧凑布局抵触
