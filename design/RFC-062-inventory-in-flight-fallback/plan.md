# RFC-062 — Task Plan

单 PR 落地（commit message 前缀：`feat(backend+shared+frontend): RFC-062 in-flight inventory fallback`）。范围足够小（shared union 1 字面量 / backend service 一个分支 / 前端 2 个 i18n key + 测试），强行拆 PR 反而不利评审。

## 子任务编号

按 RFC workflow 约定 `RFC-NNN-TM` 编号。

### RFC-062-T1 — shared union 扩 + schema 测试

- 文件：`packages/shared/src/inventory.ts` —— `InventoryReasonCode` z.enum 追加 `'in-flight'`
- 文件：`packages/shared/tests/inventory-reason-code.test.ts`（新建）—— C-S1 / C-S2 / C-S3 三 case
- 依赖：无
- 验收：`bun test --filter "inventory-reason-code"` 全绿；既有 `InventorySnapshot*` 测试零退化

### RFC-062-T2 — backend service in-flight fallback + runRootFor helper

- 文件：`packages/backend/src/services/inventory.ts`
  - 顶部加 `import { homedir } from 'node:os'`、`import { join } from 'node:path'`（如未引入）
  - 新增 `export function runRootFor(taskId, nodeRunId)` 纯函数（design §2.2.1）
  - `getInventorySnapshot` 内 `run.inventorySnapshotJson === null` 分支改造（design §2.2.2）
- 文件：`packages/backend/src/services/runner.ts`
  - 把现有 `join(homedir(), '.agent-workflow', 'runs', opts.taskId, opts.nodeRunId)` 调用点（runner.ts 内通常 1-2 处）替换为 `runRootFor(opts.taskId, opts.nodeRunId)`
  - import 新 helper
- 文件：`packages/backend/tests/inventory-in-flight-fallback.test.ts`（新建）—— C-B1 ~ C-B10 case
- 文件：`packages/backend/tests/inventory-run-root-helper.test.ts`（新建）—— C-B11 env override 测试
- 文件：`packages/backend/tests/inventory-grep-guards.test.ts`（新建或追加）—— C-B12 / C-B13
- 依赖：T1
- 验收：
  - `bun test --filter "inventory"` 全绿
  - `bun test --filter "runner"` 既有套件零退化
  - typecheck 全绿

### RFC-062-T3 — frontend i18n + 渲染 + 测试

- 文件：`packages/frontend/src/i18n/zh-CN.ts` —— `nodeDrawer.inventory.reason` 节点追加 `'in-flight': '正在运行，清单生成中…'`
- 文件：`packages/frontend/src/i18n/en-US.ts` —— 对应位置 `'in-flight': 'Run in progress, inventory generating…'`
- 文件：`packages/frontend/src/components/inventory/RuntimeInventorySection.tsx` —— **零代码改动**（reason key 已经按 `snap.reason` 动态拼），确认即可
- 文件：`packages/frontend/tests/runtime-inventory-section-in-flight.test.tsx`（新建）—— C-F1 / C-F2 / C-F3 / C-F4
- 依赖：T1（i18n 文案不依赖 shared 但 schema 接受 reason 需要 T1）
- 验收：
  - `bun test --filter "runtime-inventory"` 全绿
  - 既有 `runtime-inventory-section.test.tsx` 零退化

### RFC-062-T4 — STATE.md / plan.md 索引 + 收尾

- 文件：`design/plan.md` —— RFC 索引表追加 RFC-062 行（"Done" 状态）
- 文件：`STATE.md` —— 顶部追加 RFC-062 完工条目（commit hash + 一段 summary）
- 文件：`design/RFC-062-inventory-in-flight-fallback/proposal.md` —— 顶部状态从 `Draft → In Progress` 改为 `Done`
- 依赖：T1 / T2 / T3 全绿、commit 落地
- 验收：
  - `bun run typecheck && bun run test && bun run format:check` 三件套全绿
  - git 工作树整洁；push 后 GitHub Actions 全 jobs 绿（按 [feedback_post_commit_ci_check] memory 强制 post-commit CI check）

## 顺序

T1 → T2 → T3（并行写也行，但 T2 / T3 都依赖 T1 union 扩）→ T4。

## PR 拆分建议

**默认单 PR**（含 T1 ~ T4 全部）。理由：

1. shared union 单字面量 + backend service 一个分支 + 2 个 i18n key，单文件 diff 都很小，合并评审。
2. 测试与生产代码同 PR 落地，符合 CLAUDE.md `test-with-every-change` 强制原则。
3. STATE.md / plan.md 索引收尾合并进同一 PR，避免后续单独整改 commit。

**例外**：若审阅者要求拆 PR，可按 T1+T2（后端 / shared）→ T3（前端）→ T4（docs/索引）切三次。届时 STATE.md 顶部"进行中 RFC"状态从 In Progress 到第三个 PR 才改 Done。

## 验收清单 (PR Check)

- [ ] `bun run typecheck` 绿
- [ ] `bun run test` 绿（含新增 ≥ 15 case：shared 3 / backend 10 / frontend 4）
- [ ] `bun run format:check` 绿
- [ ] 既有 RFC-029 inventory 套件零退化（C-B5/B6/B7 守门 + 直接重跑 `bun test inventory`）
- [ ] 既有 runner 套件零退化（路径常量改 `runRootFor` 后 `bun test runner` 全绿）
- [ ] 手工验证：本机起 daemon + frontend，跑一个 agent task 卡在 running 状态，打开 task detail 抽屉看 "运行时清单"，能立刻看到 chips（验 US-1）；停止 dump 插件输出（临时改 `OPENCODE_AW_INVENTORY_OUT` 到只读路径）后看到 "正在运行，清单生成中…"（验 US-2）
- [ ] GitHub Actions push 后全 jobs 绿（强制 post-commit CI check，CI failure → 修不绕）

## 风险与回滚

**风险**：

- Runner 那两处 runRoot 字符串改成 helper 后，若 helper 路径拼接出现 off-by-one（多/少 `/`），inventory 写盘和读盘路径都会同时错位、但行为对外仍一致（写在哪读在哪），单测覆盖不到；通过 `inventory-run-root-helper.test.ts` 直接断言"`AGENT_WORKFLOW_HOME=/foo` + taskId=`T` + nodeRunId=`N` → `/foo/runs/T/N`"防御。
- in-flight 兜底每次 GET 都现场读盘，若 frontend 抽屉打开后 useQuery 设了短 refetchInterval（实际 RFC-029 useQuery 没设）会成为 N×NodeRun 量级的小 IO 风暴。**当前默认无 refetchInterval**，本 RFC 不引入；未来若加 polling 需要单独评估。

**回滚**：单 PR 形态下直接 git revert 即可，无 DB schema / migration 变更，回滚零数据风险。
