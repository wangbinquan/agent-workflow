# RFC-055 Design — Fanout 分片策略 Inspector 表单

> 状态：Draft（2026-05-21）
> 上游：[proposal.md](./proposal.md)
> 下游：[plan.md](./plan.md)

## 1. 目标

把 `agent-multi` 节点的 `shardingStrategy` 字段（schema 早已通过 `.passthrough()` 容纳、scheduler 早已读取并 dispatch 三条策略）暴露到 NodeInspector 抽屉，让用户用公共组件 `<Select>` + `<NumberInput>` 选择三种内置策略，并对老 workflow 做幂等 backfill 让"UI 显示的就是运行时跑的"。

## 2. 不变式

- `node.shardingStrategy` 仅出现在 `kind === 'agent-multi'` 的节点上；其它 kind 写入即忽略（validator 不报错，但 backfill 不会塞进去）。
- 三种 shape 合法集（与 `packages/backend/src/services/scheduler.ts:1673-1700` 完全对齐）：
  - `{ kind: 'per-file' }`
  - `{ kind: 'per-n-files', n: number }`，`n >= 1` 且为整数
  - `{ kind: 'per-directory' }` 或 `{ kind: 'per-directory', depth: number }`，`depth >= 1` 且为整数
- 没有第四种合法形态；任何额外字段在 backfill / normalize 时被丢弃（只保留 kind / n / depth 三个键）。
- scheduler `undefined → per-file` 兜底**保留**，作为 yaml 手改 / 老 fixture 的最后防线。
- backfill 是**幂等的纯函数**：第二次跑必须返回同一引用。

## 3. 数据流

```
   workflow GET /api/workflows/:id
   ──────────────────────────────────────────────
   backend services/workflow.ts loads row
      └─► applyShardingBackfill(def)   ← NEW (this RFC)
            (for each agent-multi node:
                if no shardingStrategy → set DEFAULT_SHARDING_STRATEGY)
      └─► returns def to frontend
                                ▼
   frontend WorkflowCanvas renders
      └─► NodeInspector opens for agent-multi node
            ├─► <SourcePortField> (existing, RFC-015)
            └─► <ShardingStrategyField> (NEW)
                  ├─► <Select kind=per-file|per-n-files|per-directory>
                  └─► (cond) <NumberInput n>  or  <NumberInput depth>
                  │
                  └─► onChange → normalizeShardingStrategy(prev, nextKind)
                                 → update({ shardingStrategy: ... })
                                ▼
   frontend autosave PUT /api/workflows/:id  (RFC-016 debounce)
      └─► backend services/workflow.validator.ts
            ├─► existing agent-multi-source-port-* rules
            └─► NEW agent-multi-sharding-missing (warning)
                NEW agent-multi-sharding-invalid (error)
                                ▼
   task launch → scheduler.runAgentMulti
      └─► reads node.shardingStrategy directly (unchanged path)
            └─► GitHelper.split(diff, strategy)
```

## 4. 接口契约

### 4.1 新文件 `packages/shared/src/sharding.ts`

```ts
import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'

export type ShardingStrategy =
  | { kind: 'per-file' }
  | { kind: 'per-n-files'; n: number }
  | { kind: 'per-directory'; depth?: number }

export const DEFAULT_SHARDING_STRATEGY: ShardingStrategy = { kind: 'per-file' }

export const SHARDING_KINDS = ['per-file', 'per-n-files', 'per-directory'] as const
export type ShardingKind = (typeof SHARDING_KINDS)[number]

export type ShardingValidationError =
  | { ok: false; code: 'kind-invalid' }
  | { ok: false; code: 'n-missing' }
  | { ok: false; code: 'n-out-of-range' }
  | { ok: false; code: 'depth-out-of-range' }

export function validateShardingStrategy(
  v: unknown,
): { ok: true; value: ShardingStrategy } | ShardingValidationError

/**
 * Pure transformation when the user flips the Select kind. Preserves
 * previously-typed `n` / `depth` when flipping back to the same kind so the
 * user does not lose their value via accidental clicks.
 */
export function normalizeShardingStrategy(
  prev: ShardingStrategy | undefined,
  nextKind: ShardingKind,
): ShardingStrategy

/**
 * Returns the same definition reference if no agent-multi node needed
 * backfill; otherwise a new definition with DEFAULT_SHARDING_STRATEGY filled
 * onto each missing agent-multi node. Idempotent (second call returns the
 * same reference).
 */
export function applyShardingBackfill(def: WorkflowDefinition): WorkflowDefinition
```

实现要点：

- `validateShardingStrategy`：先判 `kind`，再判 n（per-n-files）/ depth（per-directory 可选）。`Number.isInteger(n) && n >= 1` 才通过；负 / 非整数 / 缺失分别走 `n-missing` / `n-out-of-range`。
- `normalizeShardingStrategy`：切到 `per-file` → 永远 `{ kind: 'per-file' }`；切到 `per-n-files` → 若 `prev?.kind === 'per-n-files' && prev.n >= 1` 保留 prev.n、否则用 5；切到 `per-directory` → 若 prev 有合法 depth 保留、否则不写 depth（让 backend 用默认 1）。
- `applyShardingBackfill`：遍历 def.nodes；只对 `kind === 'agent-multi'` 且 `node.shardingStrategy` 没通过 validateShardingStrategy 的节点替换为 DEFAULT；否则保留原节点（ref-equality）。整个 def 也短路（若没改任何节点返回原 def）。

### 4.2 新组件 `packages/frontend/src/components/canvas/ShardingStrategyField.tsx`

```tsx
import { Select, type SelectOption } from '../Select'
import { Field } from '../Form'
import { NumberInput } from '../Form'
import {
  type ShardingStrategy,
  type ShardingKind,
  SHARDING_KINDS,
  DEFAULT_SHARDING_STRATEGY,
  normalizeShardingStrategy,
} from '@aw/shared/sharding'

interface Props {
  value: ShardingStrategy | undefined
  onChange: (next: ShardingStrategy) => void
  disabled?: boolean
}

export function ShardingStrategyField({ value, onChange, disabled }: Props) {
  const v = value ?? DEFAULT_SHARDING_STRATEGY
  const options: SelectOption<ShardingKind>[] = SHARDING_KINDS.map((k) => ({
    value: k,
    label: t(`inspector.shardingKind.${camelCase(k)}`),
  }))
  return (
    <>
      <Field label={t('inspector.fieldShardingStrategy')} required hint={t('inspector.fieldShardingStrategyHint')}>
        <Select<ShardingKind>
          value={v.kind}
          options={options}
          onChange={(k) => onChange(normalizeShardingStrategy(value, k))}
          disabled={disabled}
        />
      </Field>
      {v.kind === 'per-n-files' && (
        <Field label={t('inspector.fieldShardingN')} required hint={t('inspector.fieldShardingNHint')}>
          <NumberInput
            value={v.n}
            min={1}
            step={1}
            onChange={(n) => onChange({ kind: 'per-n-files', n: n ?? 1 })}
            disabled={disabled}
          />
        </Field>
      )}
      {v.kind === 'per-directory' && (
        <Field label={t('inspector.fieldShardingDepth')} hint={t('inspector.fieldShardingDepthHint')}>
          <NumberInput
            value={v.depth}
            min={1}
            step={1}
            onChange={(d) =>
              onChange(d == null ? { kind: 'per-directory' } : { kind: 'per-directory', depth: d })
            }
            disabled={disabled}
          />
        </Field>
      )}
    </>
  )
}
```

接入 NodeInspector：在 `packages/frontend/src/components/canvas/NodeInspector.tsx:948` 紧跟现有 SourcePortField 关闭标签后插入：

```tsx
{node.kind === 'agent-multi' && (
  <ShardingStrategyField
    value={rec.shardingStrategy as ShardingStrategy | undefined}
    onChange={(sp) => update({ shardingStrategy: sp })}
    disabled={readOnly}
  />
)}
```

### 4.3 backend validator 规则（追加到 `packages/backend/src/services/workflow.validator.ts`）

在现有 agent-multi-source-port-* 规则（`:403-435`）下方追加：

```ts
import { validateShardingStrategy } from '@aw/shared/sharding'

// agent-multi-sharding-missing  (warning)
if ((node as Record<string, unknown>).shardingStrategy === undefined) {
  issues.push({
    severity: 'warning',
    code: 'agent-multi-sharding-missing',
    nodeId: node.id,
    message: `agent-multi node '${node.id}' missing shardingStrategy (will fall back to per-file)`,
  })
} else {
  const r = validateShardingStrategy((node as Record<string, unknown>).shardingStrategy)
  if (!r.ok) {
    issues.push({
      severity: 'error',
      code: 'agent-multi-sharding-invalid',
      nodeId: node.id,
      message: shardingInvalidMessage(node.id, r.code),
    })
  }
}
```

`shardingInvalidMessage(nodeId, code)` 是同文件内的小 helper，给四种 code 各自映射人类可读字符串（中英不做——validator message 在 UI 已被 i18n 包裹）。

### 4.4 workflow GET 路径接 backfill

`packages/backend/src/services/workflow.ts` 的 GET row → response 路径在现有 schema upgrade（v1→v2→v3）之后追加：

```ts
def = applyShardingBackfill(def)
```

PUT 路径**不跑** backfill（接受任意合法形态，包括用户主动写 `{ kind: 'per-file' }`）；前端 autosave 永远显式带值，import YAML 经 validator → 缺字段进 warning（用户可选 fix）。

## 5. 改动文件矩阵

| 路径                                                                          | 改动           | 说明                                                  |
| ----------------------------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| `packages/shared/src/sharding.ts`                                             | **新增**       | 类型 + 4 个纯函数                                     |
| `packages/shared/src/index.ts`                                                | export 追加    | re-export sharding 模块                               |
| `packages/frontend/src/components/canvas/ShardingStrategyField.tsx`           | **新增**       | UI 组件                                               |
| `packages/frontend/src/components/canvas/NodeInspector.tsx`                   | 编辑 ~10 行    | agent-multi 段挂载 ShardingStrategyField              |
| `packages/frontend/src/i18n/en-US.ts`                                         | 新增 8 个 key  | label / hint / 三个 kind 文案                         |
| `packages/frontend/src/i18n/zh-CN.ts`                                         | 同上           | 中文 + type 接口同步                                  |
| `packages/backend/src/services/workflow.validator.ts`                         | 新增 2 条规则  | sharding-missing (warning) / sharding-invalid (error) |
| `packages/backend/src/services/workflow.ts`                                   | GET 路径加 1 行 | `def = applyShardingBackfill(def)`                    |
| `packages/shared/tests/sharding.test.ts`                                      | **新增**       | 13 case（validate 6 + normalize 4 + backfill 3）      |
| `packages/frontend/tests/canvas-sharding-inspector.test.ts`                   | **新增**       | JSDOM Inspector 集成 + 源代码层兜底                   |
| `packages/backend/tests/workflow-validator-sharding.test.ts`                  | **新增**       | validator 4 case                                      |
| `packages/backend/tests/scheduler-fanout-sharding.test.ts`                    | **新增**       | 端到端 split 路径 3 case                              |

## 6. 错误处理 / UI 提示

- **客户端实时校验**：NumberInput 的 `min={1}` 已 prevent 用户输 0 / 负；切 kind 时 normalizeShardingStrategy 总产出合法形态。常规路径下 invalid 不会被写入。
- **保存被 validator 拒**：autosave PUT 拿到 `agent-multi-sharding-invalid` 时复用既有 ErrorBanner（NodeInspector 顶部已有，RFC-021 落地）显示 message；warning 走既有 lint 区 chip。**不**新加专门组件。
- **可访问性**：Select / NumberInput 公共组件已带 ARIA；ShardingStrategyField 本体只是 `<Field>` 包装，不引入新 ARIA roles。

## 7. 测试策略

按 [CLAUDE.md "测试用例随每次需求落地"]：

### 7.1 纯函数单测 `packages/shared/tests/sharding.test.ts`

- `validateShardingStrategy`：6 case
  1. `{ kind: 'per-file' }` → ok
  2. `{ kind: 'per-n-files', n: 5 }` → ok
  3. `{ kind: 'per-directory' }` → ok（depth optional）
  4. `{ kind: 'per-directory', depth: 2 }` → ok
  5. `{ kind: 'wrong' }` → kind-invalid
  6. `{ kind: 'per-n-files', n: 0 }` → n-out-of-range；`{ kind: 'per-n-files' }` → n-missing
- `normalizeShardingStrategy`：4 case
  1. `prev=undefined, next='per-file'` → `{ kind: 'per-file' }`
  2. `prev={kind:'per-n-files',n:10}, next='per-n-files'` → 保留 n=10
  3. `prev={kind:'per-file'}, next='per-n-files'` → n=5（默认）
  4. `prev={kind:'per-directory',depth:3}, next='per-directory'` → 保留 depth=3
- `applyShardingBackfill`：3 case
  1. 含 agent-multi 节点无 shardingStrategy → 返回新 def，节点被 backfill 成 per-file
  2. 含 agent-multi 节点已有 shardingStrategy → 返回同一 def 引用（ref equality）
  3. 含其它 kind 节点（agent-single / wrapper-git）→ 不被 backfill

### 7.2 NodeInspector 集成测 `packages/frontend/tests/canvas-sharding-inspector.test.ts`

- agent-multi 节点抽屉打开 → 默认 Select 显示 per-file（先经 backfill）
- Select onChange 切到 per-n-files → def.nodes[i].shardingStrategy = `{kind:'per-n-files',n:5}`、NumberInput 渲染
- NumberInput onChange 改 n=10 → def 写回 n=10
- Select 切到 per-directory → NumberInput depth 显示空值；改 depth=2 → 写回 `{kind:'per-directory',depth:2}`；再清空 depth → 写回 `{kind:'per-directory'}`
- readOnly 模式：Select / NumberInput 都 disabled；onChange 不触发 onCommitDef
- 源代码层兜底：fs.read `NodeInspector.tsx` 包含 `inspector.fieldShardingStrategy` 字面量、`<ShardingStrategyField`；`ShardingStrategyField.tsx` 包含 `<Select` / `<NumberInput`（不是原生标签）

### 7.3 后端 validator 测 `packages/backend/tests/workflow-validator-sharding.test.ts`

- def 含 agent-multi 节点无 shardingStrategy → 1 个 warning code=`agent-multi-sharding-missing`
- def 含 agent-multi 节点 `{kind:'wrong'}` → 1 个 error code=`agent-multi-sharding-invalid`
- def 含 agent-multi 节点 `{kind:'per-n-files',n:0}` → 1 个 error
- def 含 agent-multi 节点 `{kind:'per-directory',depth:2}` → 无 issue

### 7.4 scheduler 端到端测 `packages/backend/tests/scheduler-fanout-sharding.test.ts`

- 注入 fake diff（10 文件、3 目录）
  - 节点 shardingStrategy = `{kind:'per-n-files',n:3}` → 跑 `runAgentMulti` 期望 splitDiffPerNFiles 被调用、子 node_run 数 = ceil(10/3) = 4
  - 节点 shardingStrategy = `{kind:'per-directory',depth:1}` → 子 node_run 数 = 3
  - 节点 shardingStrategy = `undefined`（兜底）→ 子 node_run 数 = 10（per-file fallback 仍工作）

### 7.5 三件套

- `bun run typecheck && bun run test && bun run format:check` 全绿
- push 后查 GitHub Actions（按 [feedback_post_commit_ci_check]）含 build-binary smoke / Playwright e2e 全绿
- 测试 case 标头注释链回本 RFC（"// LOCKS: RFC-055 sharding strategy inspector"）

## 8. 性能 / 兼容

- backfill 是纯 O(N nodes) 遍历，单 workflow 几十节点级别零感知。
- 所有改动均向后兼容：老 def（无 shardingStrategy）打开 + backfill = `{kind:'per-file'}`，与 scheduler 兜底语义完全一致；老 backend 接收新前端 PUT（含 shardingStrategy 字段）通过 `.passthrough()` 透传不报错。
- workflow `$schema_version` 不 bump（理由见 proposal §1.3 末条）。
