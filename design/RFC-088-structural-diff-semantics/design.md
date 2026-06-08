# RFC-088 技术设计

## 1. 总览与数据流

全部在前端、纯静态、零后端、零 schema 变更。数据流：

```
StructuralDiff (现有，含 SymbolChange[*].{changeType,before,after,signatureChanged,
                bodyDelta,renamedFrom,hunkAnchor} + SymbolNode.visibility[RFC-087])
        │
        ▼  纯函数（lib/structureView.ts 或新 lib/structureSemantics.ts）
classifyBreaking(change) ── severity ('breaking'|'risky'|'safe')
explainChange(change)    ── { key, vars } → i18n 句子
sortFileChanges(file, by) / filterChanges(changes, pred)
        │
        ▼  UI（StructuralDiffView.tsx）
[导览卡: Top-N by severity → onJumpToHunk/openCallChain]   ← G4 (PR-C)
[汇总卡: 数字可点即筛 + 新增"破坏性"计数]                  ← G2/G3
[排序/筛选 .segmented 控件]                                ← G3
[tree: 每行 severity chip + explainChange 句子]            ← G1/G2
```

## 2. 接口契约（纯函数，新增于 `lib/structureSemantics.ts`）

```ts
import type { SymbolChange } from '@agent-workflow/shared'

export type Severity = 'breaking' | 'risky' | 'safe'

/** diff 内可确定的结构破坏分级（非跨文件影响面，见 proposal 非目标）。
 *  visibility 来自 RFC-087；缺失时按 hasPublicLikeVisibility 保守处理。 */
export function classifyBreaking(change: SymbolChange): {
  severity: Severity
  /** 触发原因的稳定 key（用于 explain + 测试断言，非展示文案）。 */
  reason:
    | 'removed-public'
    | 'signature-param-change'   // public 符号参数删/改
    | 'visibility-narrowed'      // public → 更窄
    | 'renamed-public'
    | 'added'
    | 'body-only'
    | 'private-change'
    | 'unknown-visibility'       // 缺 visibility，保守 risky
  /** true 当 reason 依赖了缺失的 visibility（UI 标"可见性未知"）。 */
  uncertain: boolean
}

/** 一句确定性自然语言解释，返回 i18n key + 插值变量（组件用 t() 渲染）。 */
export function explainChange(change: SymbolChange): { key: string; vars: Record<string, string> }

export type SortBy = 'name' | 'severity'
export interface ChangeFilter {
  changeTypes?: ReadonlySet<SymbolChange['changeType']>
  severities?: ReadonlySet<Severity>
}

/** 复用现有 groupFileChanges 的分组，再按 by 排序（severity 用 breaking>risky>safe，
 *  同级回落字典序）。filter 为空表示不过滤。 */
export function orderAndFilterChanges(
  changes: SymbolChange[],
  by: SortBy,
  filter?: ChangeFilter,
): SymbolChange[]

/** 取 Top-N 最该先看的改动（severity 降序 + 文件内顺序），供导览卡。 */
export function walkthroughItems(
  files: ReadonlyArray<{ filePath: string; changes: SymbolChange[] }>,
  limit: number,
): Array<{ filePath: string; change: SymbolChange; severity: Severity }>
```

### 2.1 classifyBreaking 判定（自上而下，先命中先返回）

| 条件（基于现有字段 + visibility）                                    | severity | reason                |
| ------------------------------------------------------------------- | -------- | --------------------- |
| `changeType==='removed'` 且 before 是 public-like                   | breaking | removed-public        |
| `changeType==='modified'` 且 signatureChanged 且 after public-like 且 `diffSignatureTokens` 含 removed token | breaking | signature-param-change |
| visibility 由 public → 更窄（before public-like，after 非）          | breaking | visibility-narrowed   |
| `changeType∈{renamed,moved}` 且 public-like                         | risky    | renamed-public        |
| 命中破坏类条件但 before/after 缺 visibility                          | risky    | unknown-visibility（uncertain=true） |
| `changeType==='added'`                                              | safe     | added                 |
| 仅 bodyChanged / bodyDelta（签名没变）                              | safe     | body-only             |
| 其余（private 符号的增改删）                                         | safe     | private-change        |

`public-like`：`visibility===undefined`（语言未提供 → 视调用方可见，保守）或
`visibility∈{public, protected, package, default}`；`private`/`#private` 视为不可见。
"缺 visibility 时保守"：removed/signature 类改动在 visibility 缺失时**不降为 safe**，而是 risky +
uncertain（避免把真破坏静默吞掉），UI 标"可见性未知"。

### 2.2 explainChange → i18n

句子由 `(changeType, kind, severity.reason)` 选 key，插值 `name` / `from`（renamed）/ `kind`。
key 前缀 `tasks.structExplain*`，例：

- `removed-public` → `structExplainRemovedPublic`：`删除了 public {{kind}} {{name}} —— 可能破坏调用方`
- `signature-param-change` → `structExplainSigParam`：`{{name}} 的签名参数变了 —— 检查所有调用点`
- `added` → `structExplainAdded`：`新增 {{kind}} {{name}}`
- `body-only` → `structExplainBodyOnly`：`{{name}} 仅函数体改动`
- `renamed-public` → `structExplainRenamed`：`{{name}} 由 {{from}} 重命名 —— 旧名调用会失效`

中英双语，zh-CN `Resources` 接口同步加类型（参照 RFC-083 既有 `structRenamedFrom` 模式）。

## 3. UI 接线（`StructuralDiffView.tsx`）

- **tree 行（G1/G2）**：在每个 `structure__symbol` 行追加
  `<span class="structure__severity structure__severity--{severity}">` chip（breaking 用 danger、
  risky 用 warning、safe 不渲染或极弱）；行下方加 `structure__explain` 一句解释（`t(explain.key, vars)`）。
  `uncertain` 时 chip 加 `title`/后缀"可见性未知"。复用 RFC-083 既有 delta 配色 var。
- **排序/筛选（G3）**：在 `structure__view-toggle` 同排或其下加一个 `.segmented` 排序控件
  （`name` / `severity`）+ 若干筛选 toggle；`StructuralTree` 渲染前用 `orderAndFilterChanges` 处理。
  汇总卡（`StructuralSummaryCards`）数字 `onClick` 设置对应 `changeTypes` 过滤（点"破坏性"计数设
  `severities={breaking}`）。新增一张"破坏性"汇总卡：值 = breaking 计数。
- **导览卡（G4）**：新组件 `WalkthroughCard`，渲染在 `StructuralSummaryCards` 与
  `structure__detail` 之间，仅当 `walkthroughItems(files, N).some(severity!=='safe')`。每行：severity
  chip + 文件名 + 符号名 + explain 摘要 + 跳转按钮。点击：有 hunkAnchor → `onJumpToHunk`；可
  callable 且 callChainAvailable → `openCallChain`；否则选中该文件并切到 tree。N 默认 8，溢出显
  "还有 K 处"。

## 4. 与现有代码的耦合点

- `lib/structureView.ts`：`groupFileChanges` 复用；新增 `orderAndFilterChanges` 可放同文件或新
  `structureSemantics.ts`（倾向新文件，保持 RFC-083 纯函数文件聚焦，cycle-free 同 listWire 纪律）。
- `diffSignatureTokens`（Q1，已在 structureView.ts）：`signature-param-change` 判定复用它检测
  removed token。
- `StructuralDiffView.tsx`：tree 行渲染、汇总卡、视图切换三处；`onJumpToHunk`/`callChainEntry`
  已存在，导览卡直接复用，不新增 prop 链路。
- `tasks.detail.tsx`：宿主无需改（导览卡在 `StructuralDiffView` 内部）。

## 5. 失败模式

- **缺 visibility**（旧 artifact / C++·Scala degraded）：按 §2.1 保守 risky + uncertain，不静默吞真
  破坏，也不误报为 breaking。
- **baseline vs deep**：分级只用 diff 内字段，两引擎下都可用；deep 仅让未来"跨文件影响面"更准。
- **空 / 无破坏**：导览卡不渲染；筛选清空时回落"全部"；与现有 `availableViews` 空回落逻辑一致。
- **i18n 缺 key**：typecheck 卡住（zh-CN `Resources` 接口强约束），不会运行时崩。
- **renamed 的 from**：`renamedFrom` 可能 undefined（非 rename）；explain 对应分支需 guard。

## 6. 测试策略（必写 case）

纯函数（首选可断言面）：

- `classifyBreaking`：§2.1 矩阵逐格——removed public=breaking；removed private=safe；modified+sig
  param removed + public=breaking；modified+body-only=safe；public→private=visibility-narrowed
  breaking；renamed public=risky；removed public 但 visibility 缺失=risky+uncertain；added=safe。
- `explainChange`：5 changeType × 代表 kind 返回正确 key + vars；renamed 带 from；插值 name 出现。
- `orderAndFilterChanges`：severity 排序把 breaking 排前、同级字典序；filter 按 changeType/severity
  正确缩减；空 filter=原集（仅排序）。
- `walkthroughItems`：severity 降序 + limit 截断 + 只在有非 safe 时有内容。

渲染（少量集成断言，语言无关优先 role/class/glyph）：

- tree 行出现 `.structure__severity--breaking` chip + `.structure__explain`。
- 汇总卡"破坏性"数字点击后 tree 只剩 breaking 行。
- 排序切到 severity 后第一条是 breaking。
- 导览卡：有 breaking 时渲染并列在最前；点击触发 `onJumpToHunk`（spy）。
- 无破坏性改动时导览卡不在 DOM。

兜底：保留一条源代码层文本断言（如"`StructuralDiffView.tsx` 必须引用 `classifyBreaking`"）。
