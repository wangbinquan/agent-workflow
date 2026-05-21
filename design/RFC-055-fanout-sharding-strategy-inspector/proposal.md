# RFC-055 Proposal — Fanout（agent-multi）节点分片策略 Inspector 表单

> 状态：Draft（2026-05-21）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：[RFC-015](../RFC-015-fanout-source-port-drag/proposal.md)（fanout sourcePort 拖拽）、[RFC-035](../RFC-035-ux-consistency/proposal.md)（前台 UI 统一）

## 1. 背景

`agent-multi`（fanout / 多进程）节点把上游 `sourcePort` 的内容（典型是 git wrapper 的 `git_diff`）切成多个 shard、并行起子进程，最终按命名端口聚合。`design/design.md:655-658` 定义了三种内置 sharding 策略：

```ts
type ShardingStrategy =
  | { kind: 'per-file' }
  | { kind: 'per-n-files'; n: number }
  | { kind: 'per-directory'; depth?: number }   // depth 默认 1
```

后端 `packages/backend/src/services/scheduler.ts:1673-1700` 已经完整实现这三条策略，`packages/backend/src/util/diffSplit.ts` 三个 split 函数都在跑生产路径。但**前端编辑器从未给用户暴露选项**——

- `packages/frontend/src/components/canvas/NodeInspector.tsx:935-948` 对 `agent-multi` 节点只渲染了 `<SourcePortField>`（RFC-015 落地的两下拉框 + 顶部 handle 拖拽），**整段 agent-multi 表单没有一个字段写 `node.shardingStrategy`**。
- 全仓 `grep -rn "shardingStrategy\|ShardingStrategy" packages/frontend/src` —— **0 处命中**。
- workflow YAML / JSON 编辑能通过 `.passthrough()` schema (`packages/shared/src/schemas/workflow.ts:71-86`) 偷偷塞 `shardingStrategy` 字段进去，但**画布 / 抽屉 UI 完全没入口**。
- scheduler 在 `:1680` 对 `strategy === undefined` 静默回退到 `per-file`：

  ```ts
  if (strategy === undefined || strategy.kind === 'per-file') {
    shards = splitDiffPerFile(sourceContent)
  } else if (strategy.kind === 'per-n-files') { ... }
  else { ... per-directory ... }
  ```

也就是说——**所有走 UI 创建的 agent-multi 节点，运行时都是固定的 `per-file`，`per-n-files` / `per-directory` 这两条策略在前端不可达**。文档（`design/proposal.md:197-199`, `design/design.md:719-720`）正式列了三种分片，验收里也写"单进程节点 + 多进程节点（per-file / per-N-files / per-directory 三种分片）"（`design/proposal.md:681`），但 UI 上只有一种能选。

### 1.1 直接成本

- **产品行为缺斤少两**：用户读了 `proposal.md` / `design.md`，预期能在抽屉里选 per-N-files / per-directory，打开发现没有，要么放弃要么去手改 YAML（重定向到 workflow export / import 路径，门槛高且没有 dialog 引导）。
- **per-file 在大 PR 场景下并发爆炸**：百文件 PR → 100 个 opencode 子进程，远超内部 fanout semaphore 的合理上限。用户的真实修复手段是切到 per-n-files / per-directory，但没入口；只能折中改 `definition.edges[]` / 减小 PR 切片，间接绕行。
- **scheduler 静默 fallback 掩盖了"用户没配置"**：`strategy === undefined` 等同 `per-file`，UI 不展示"当前用的是哪个"，用户无从核对。验收期 4（[design.md §测试策略]）会暴露——只要有人想真的切 per-directory，跑一遍才发现 UI 完全没动它。
- **与 `proposal/init.md` 的 fan-out 模式偏离**：原始 proposal 把"按目录 / 按 N 文件分片"作为 Code→Audit→Fix 工作流的核心分发方式之一，UI 缺位等于把这条产品路径留在文档里跑不通。

### 1.2 为什么是现在

- 后端三条策略**今天就在跑**——`packages/backend/src/util/diffSplit.ts` 三个 split 函数 + scheduler dispatch 早已完成，无需任何 backend / schema / runtime / DB 改动；本 RFC 是纯前端表单缺口的补齐，工作量与风险都极小。
- RFC-035（UX consistency）已经把"新表单必须复用 `<Select>` / `<Field>` / `<NumberInput>` 公共组件，禁止自写原生 `<select>` / chrome"立成强制原则；本 RFC 正好按这条规则走，不会留下风格债。
- RFC-015 已经把 sourcePort 拖拽 + Inspector 表单的双向同步打通，本 RFC 在同一段抽屉表单里**紧跟 sourcePort 字段下方**追加 sharding 字段，认知路径连贯（"先指来源、再选切法"）。
- 用户最近反馈 fanout 配置不完整，正适合把这条遗漏补上。

### 1.3 本 RFC 不动哪些地方

- **不动 schema 字段位置**：`shardingStrategy` 仍在 `WorkflowNode` 顶层（permissive passthrough），与 `sourcePort` 平级。**不**新增独立 schema 表 / DB 列 / migration。
- **不动 backend / scheduler / diffSplit**：三条策略的代码已就绪、走的就是 `node.shardingStrategy`，本 RFC 让前端写入它即可；scheduler 的 `undefined → per-file` 默认回退保留作为旧 workflow 兼容兜底，新写永远显式带值（见 §2.1 第 4 条 backfill）。
- **不引入新策略**：per-file / per-N-files / per-directory 三选一就是 v1 全集；自定义 sharding（grep filter / 体积分桶 / 按 commit 分）留给后续 RFC。
- **不引入"sharding 预览"**：抽屉里不实时算 diff 给用户预览分多少 shard——这要求选 sourcePort 的上游 run 已经有 git_diff 输出，而编辑器是 workflow 静态编辑态，没有 run 数据。预览交给 task 详情 §Stats tab 的"子进程列表"事后展示。
- **不动 task 详情画布的 read-only**：read-only 模式抽屉早已不可编辑，本 RFC 加的字段在 read-only 抽屉里显示为只读文本即可（复用既有 disabled prop）。
- **不动 i18n 命名空间**：仅在 `inspector.*` 现有命名空间下新增 6-8 条 key（`fieldShardingStrategy*` 系列），中英两份齐发。
- **不动 workflow `$schema_version`**：`shardingStrategy` 字段早已被 `.passthrough()` schema 接纳并被 backend 消费——它不是新增字段，而是"原本就允许写入但 UI 没暴露入口"。schema 版本不需要 bump。

## 2. 目标

### 2.1 做

1. **NodeInspector agent-multi 段新增 ShardingStrategy 字段**：紧跟 `<SourcePortField>` 下方，结构：
   - **第一行**：`<Field label="分片策略" required>` 包一个 `<Select>`（公共组件，**禁止原生 `<select>`**，按 RFC-035 §"已存在的公共组件"）。options：`per-file` / `per-n-files` / `per-directory` 三选一，display label 用 i18n（`inspector.shardingKind.perFile` 等）。
   - **第二行（条件渲染）**：
     - 当 kind === `per-n-files`：`<Field label="每分片文件数 (n)" required hint="...">` 包 `<NumberInput min={1} step={1}>`；默认 `n = 5`。
     - 当 kind === `per-directory`：`<Field label="目录深度 (depth)" hint="默认 1，即按 top-level 目录分片">` 包 `<NumberInput min={1} step={1}>`；默认不填（等同 backend 的 1）。
     - 当 kind === `per-file`：不渲染第二行。
2. **写入 `node.shardingStrategy` 字段**：用现有 `update(patch)`（NodeInspector 内 useUpdateNode hook）把 strategy 对象整体写回 definition。
   - 切 kind 时**清空旧 kind 的多余字段**：切到 per-file 直接 `shardingStrategy: { kind: 'per-file' }`；切到 per-n-files 写 `{ kind: 'per-n-files', n: <default 5 或保留旧 n 若上次就是 per-n-files> }`；切到 per-directory 写 `{ kind: 'per-directory' }`（depth 留空，让 backend 用默认 1）或 `{ kind: 'per-directory', depth: <旧 depth> }`。
3. **validator 规则补齐**：在 `packages/backend/src/services/workflow.validator.ts` 现有 `agent-multi-source-port-*` 规则旁追加：
   - `agent-multi-sharding-missing`：`agent-multi` 节点缺 `shardingStrategy` 字段（**warning** 级别——backend 有 per-file fallback，但提示用户显式选）。
   - `agent-multi-sharding-invalid`：`kind` 不在 enum / `per-n-files` 缺 `n` 或 `n < 1` / `per-directory` 的 `depth < 1`（**error** 级别——会让 backend split 失败）。
4. **打开旧 workflow 自动 backfill**：抽 `applyShardingBackfill(def)` 纯函数；workflow GET 路径或编辑器加载时跑一遍，把所有 `agent-multi` 节点缺 `shardingStrategy` 的补成显式 `{ kind: 'per-file' }`（**与 scheduler 默认一致，零行为变化**）。这一步让抽屉打开后立刻显示"当前用的是 per-file"，避免 UI 显示"未选择"造成认知断层。**实现位置**：与 RFC-015 的"打开 workflow 不做 heal"相反——本 RFC 必须 heal，因为目标恰恰是让"运行时实际策略"对编辑器可见。
5. **抽 `validateShardingStrategy` 纯函数**：在 `packages/shared/src/sharding.ts` 新建文件（与 `outputKinds` / `node-kind-behavior` 同级），导出：
   - 类型重出 `ShardingStrategy`（与 backend `diffSplit.ts` / scheduler `:1673` 三种 shape 一致）
   - 常量 `DEFAULT_SHARDING_STRATEGY: ShardingStrategy = { kind: 'per-file' }`
   - `validateShardingStrategy(v): { ok: true } | { ok: false; code: 'kind-invalid' | 'n-missing' | 'n-out-of-range' | 'depth-out-of-range' }`
   - `normalizeShardingStrategy(prev, nextKind): ShardingStrategy` —— 切 kind 时根据上一份 strategy 决定保留 / 重置 n / depth。
   - `applyShardingBackfill(def): WorkflowDefinition` —— 给所有缺字段的 agent-multi 节点补 `DEFAULT_SHARDING_STRATEGY`；ref-equality 短路。
6. **i18n 双语**：`packages/frontend/src/i18n/en-US.ts` + `zh-CN.ts`，新增 key（最终命名见 design.md §4）：
   - `inspector.fieldShardingStrategy` —— Field label
   - `inspector.fieldShardingStrategyHint` —— Field hint
   - `inspector.shardingKind.perFile` / `inspector.shardingKind.perNFiles` / `inspector.shardingKind.perDirectory` —— Select option labels
   - `inspector.fieldShardingN` / `inspector.fieldShardingNHint` —— 第二行 N 字段
   - `inspector.fieldShardingDepth` / `inspector.fieldShardingDepthHint` —— 第二行 depth 字段
7. **read-only 抽屉禁编辑**：task 详情 read-only 抽屉打开时，所有字段已经走 disabled prop；本 RFC 新加的 `<Select>` + `<NumberInput>` 同样接 `disabled={readOnly}`。
8. **回归测试落档**：design.md §测试策略 列全：纯函数单测（validate 6 case + normalize 4 case + applyShardingBackfill 3 case）+ JSDOM Inspector 集成测（切 kind 写字段 + 条件渲染 + read-only disabled）+ validator 后端单测（missing / invalid 各 2 case）+ 源代码层兜底（NodeInspector.tsx 包含 `inspector.shardingKind.perFile` 字面量、用了 `<Select>` 不是 `<select>`）。

### 2.2 不做（明确划出去）

- 不引入"分片预览面板"。理由：编辑态没有 sourcePort 的真实 diff 内容，无法算出 shard 数；预览要在 task 详情 §Stats tab 跑完之后看（已有 RFC-021 子进程列表展示）。
- 不引入"按 commit / 按文件大小 / 按 grep 命中"等额外策略。理由：backend 仅实现三条，新策略要同步 backend 工作；本 RFC 范围明确仅"暴露已有能力"。
- 不动 scheduler `undefined → per-file` 兜底。理由：保留它作为**老 workflow / 漏写 backfill / yaml 手改不带 shardingStrategy** 三种边界场景的最后防线；前端 backfill 后正常用户路径永远显式带值。
- 不动 workflow YAML import / export 行为。理由：导入侧 `.passthrough()` 已接受字段，导出侧自动包含；本 RFC 是 UI 入口补齐，与序列化层无关。
- 不引入 sharding 字段的"高级模式 / JSON 文本编辑"折叠区。理由：三种策略 + 两个数值字段已经足够窄，硬塞 JSON 编辑器与 RFC-035 "禁止自写 chrome" 抵触；后续真要扩展 v2 策略再开折叠区。
- 不改 `<MultiProcessAgentNode>` 画布节点上的视觉信息密度（不在节点上多印一行 "per-directory(depth=2)"）。理由：节点上已经显示了 fan-out 角标 + sourcePort 引用，再叠一行字会撑爆 RFC-006 的紧凑布局；抽屉一打开就能看到，无信息丢失。

## 3. 用户故事

### 3.1 编排作者：百文件 PR 切到 per-directory

> 我配了一个 `git → designer → audit(agent-multi)` 工作流跑代码审计。某次 designer 改了 130 个文件，audit 节点用默认 per-file 起了 130 个 opencode 子进程，OS 直接被打爆。我点开 audit 节点抽屉，**期待**在 sourcePort 字段下方紧跟一个"分片策略"下拉、能切到 `per-directory(depth=1)`，让同一个 top-level 目录的所有改动归并到一个 shard。今天的现实是：抽屉里这字段不存在，要手动 export YAML / 改 `shardingStrategy: { kind: 'per-directory' }` / 再 import 回来——三步操作，且 YAML 手改容易跟其它字段写串行。

### 3.2 编排作者：长尾文件批量化

> audit 节点的 agent 处理单文件很快但启动开销显著（opencode boot 500ms+），per-file 模式下 30 个文件要白白多花 15 秒启动开销。**期待**抽屉里能选 `per-n-files(n=5)`，30 个文件归并成 6 个 shard，启动开销摊平到 1/5。今天的 UI 没这个选项，必须走 YAML。

### 3.3 编排作者：现有 workflow 打开看到 "per-file"

> 我半年前配的 audit 节点没有 shardingStrategy 字段（写在那时候 scheduler 已经默认 per-file）。今天我打开抽屉，**期待**看到分片策略字段显示 "per-file"（而不是空白或"未选择"），让我知道现在运行时跑的就是这个。今天若 UI 不 backfill，新加的 Select 会显示"请选择"，让我误以为还没配。

### 3.4 编排作者：错误立刻可见

> 我切到 `per-n-files`、把 N 改成 0（手抖输错），**期待**抽屉里立刻报"n 必须 ≥ 1"，而不是让任务启动后才在 scheduler 抛 split 错误。今天 backend 有 validator，但 UI 没字段，错也错不到。

### 3.5 编排作者：read-only 抽屉只看不改

> 我在 task 详情打开同一个 audit 节点的只读抽屉看历史配置。**期待**分片策略字段显示当时跑的"per-directory(depth=2)"，但所有输入禁用（Select 灰、NumberInput 灰），跟周围 retries / timeoutMs 字段的 read-only 行为一致。

## 4. 验收标准

每条都写成可在 CI 中跑绿 / 跑红的断言：

1. **抽屉默认渲染**：vitest + JSDOM 打开 NodeInspector for agent-multi 节点（不预设 shardingStrategy）→ 断言 DOM 中存在 `<Select>` 角色控件 + label 文本匹配 i18n key `inspector.fieldShardingStrategy`；初值显示为 `per-file`（来自 backfill 默认）；不渲染 n / depth 输入框。
2. **切到 per-n-files**：触发 Select onChange to `per-n-files` → 断言（a）`def.nodes[i].shardingStrategy = { kind: 'per-n-files', n: 5 }`；（b）DOM 出现 `<NumberInput value={5}>` 标 `inspector.fieldShardingN`；（c）def.edges[] 不变、sourcePort 不变。
3. **切到 per-directory**：触发 Select onChange to `per-directory` → 断言（a）`shardingStrategy = { kind: 'per-directory' }`（不写 depth，让 backend 用 1）；（b）DOM 出现 depth 输入框（空值，hint 显示"默认 1"）；输入 2 → 断言写回 `{ kind: 'per-directory', depth: 2 }`。
4. **N=0 立即报错**：切到 per-n-files、N 输 0 → backend validator 单测断言抛 `agent-multi-sharding-invalid` code；前端 NodeInspector 旁边显示 ErrorBanner 或 Field error 文案（**前端不强制实时校验**，但 validator API 调用必报；具体 UI 提示形式 design.md §6 定）。
5. **打开旧 workflow backfill**：单测加载 `{ nodes: [{ id: 'a', kind: 'agent-multi' /* 无 shardingStrategy */ }] }` 跑 `applyShardingBackfill(def)` → 断言节点变为 `{ ..., shardingStrategy: { kind: 'per-file' } }`；非 agent-multi 节点不变。
6. **read-only 模式禁编辑**：task 详情 read-only 抽屉渲染相同节点 → 断言 Select / NumberInput 都有 `aria-disabled="true"` 或 `disabled` attr；尝试 onChange 不写回 def（mock onCommitDef 验未被调）。
7. **scheduler 零回归**：执行 `bun run --filter @aw/backend test` 既有 `tests/scheduler-*.test.ts` 全绿——backend 路径完全未触碰，只新增 validator 规则的单测文件。
8. **diffSplit 三策略仍可达**：新增端到端单测：把 def 写成 `shardingStrategy: { kind: 'per-n-files', n: 3 }` 调 scheduler 路径 → 断言 split 走 `splitDiffPerNFiles(diff, 3)`；同理 per-directory。
9. **源代码层兜底**：新增 `packages/frontend/tests/canvas-fanout-sharding-inspector.test.ts`：fs.read + 正则锁——`NodeInspector.tsx` 在 agent-multi 分支引用 `inspector.fieldShardingStrategy` 字面量 + 使用 `<Select` 组件（不是原生 `<select`）+ 引用 `validateShardingStrategy` / `normalizeShardingStrategy` from `@aw/shared/sharding`；`packages/shared/src/sharding.ts` 文件存在且 export 4 个符号。
10. **三件套全绿**：`bun run typecheck && bun run test && bun run format:check` 必须过；推 push 后按 [feedback_post_commit_ci_check] 查 GitHub Actions（含 build-binary + Playwright e2e）全绿。

## 5. 风险与回滚

- **风险 1：旧 workflow backfill 不幂等导致 GET 输出与 PUT 输入不对齐**。`applyShardingBackfill` 必须是 ref-equality 短路 + 幂等：第二次跑零变更。**对策**：纯函数单测 case 3 专门验"对已有 shardingStrategy 的 def 跑一次仍是同一引用 / 同样字段值"；GET 路径只用 backfill 输出，PUT 路径接受任何形态（permissive schema）后再跑 validator。
- **风险 2：scheduler `undefined → per-file` 兜底删除会破坏 YAML 手写党**。**对策**：**不删兜底**。本 RFC 仅在 UI 加 backfill，scheduler 路径保留 `undefined → per-file` 作为对老 workflow / yaml 手改 / 测试 fixture 的最后防线。
- **风险 3：切 kind 时丢 n / depth 让用户烦躁**。比如用户在 per-n-files 配了 n=10、误切 per-file、又切回 per-n-files 期望 n 还是 10。**对策**：`normalizeShardingStrategy(prev, nextKind)` 设计为"切到 per-n-files 时若 prev 是 per-n-files 保留 n、否则用默认 5"；用户角度感知到"刚才设过的 n 没丢"。验收增加 1 case 锁这条。
- **风险 4：抽屉里出现两个数字输入字段时与 retries / timeoutMs 视觉混淆**。**对策**：strategy 字段紧贴 sourcePort 下方、与 retries 之间隔一条 `form-grid` 行；NumberInput 的 label 写明 "(n)" / "(depth)" 单位提示。**不**新增分隔线 / accordion——RFC-035 反对自加 chrome。
- **风险 5：validator 加 warning 级别规则会污染既有 task launcher 的"必须无 warning 才能启动"逻辑**。**对策**：sharding-missing 走 **warning** 而非 error，与 launcher 现行规则一致（warning 不阻塞启动）；新写 workflow 经 backfill 后永远不会触发 missing；只对未经 UI 编辑的老 def 触发，且行为与 scheduler 兜底完全等价。
- **风险 6：i18n 漏译**：新加 6-8 个 key 必须中英两份齐发。**对策**：测试 9 顺带 grep 两份 i18n 文件的 key 数量必须相等；CI 既有 i18n 一致性测试已覆盖此模式。
- **回滚**：本 RFC 单 PR，主要是前端 Inspector + 一个 shared 纯函数模块 + 后端 validator 两条新规则。出问题 `git revert` 即恢复"UI 无 sharding 入口、scheduler 走 per-file 兜底"现状；老 workflow 0 影响（backfill 路径不存在等于不跑，行为回到今天）。

## 6. 工业参考

- **Dify**：iterator 节点的 batch 分片策略（按行 / 按 N / 按段）通过抽屉里的 Select + 条件 NumberInput 暴露，与本 RFC 同构。
- **n8n**：SplitInBatches 节点 batchSize 是必填 NumberInput；本 RFC 在 per-n-files 上完全对齐这条体验。
- **Langflow**：sharding-like 节点的 strategy 选择走 dropdown，切换后下方动态展开附加参数；与本 RFC §2.1 第 1 条"条件渲染第二行"同形。
- **Apache Beam ParDo / Spark partitionBy**：sharding 配置永远显式（partitionBy / coalesce 必须给数），不允许"系统默认"；本 RFC backfill `per-file` 默认是对用户的 UI 显式化，与这些大数据框架"显式优于隐式"理念一致。

## 7. 后续 RFC 衔接

- **RFC-（候选）sharding 预览**：task 启动前对 sourcePort 的真实 git_diff 跑一次 `GitHelper.split(diff, strategy)`，在抽屉里实时显示"将分成 N 个 shard"。要求 launcher 阶段已选好 base / head commit；本 RFC 不阻塞。
- **RFC-（候选）扩展策略**：grep-filter / size-bucket / commit-based 等 v2 策略；本 RFC 的 Select + 条件渲染骨架直接扩 enum + 多一行条件即可，零结构改动。
- **RFC-（候选）yaml 手改字段防呆**：在 import dialog 里跑 `validateShardingStrategy` 给出友好错误（今天 import 失败只显示 zod raw error），本 RFC 抽出的纯函数直接复用。
