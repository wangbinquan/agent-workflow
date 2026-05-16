# RFC-022 Design — Agent 依赖其他 Agent：技术设计

> 状态：Draft（2026-05-16）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 修订基线：design/design.md §3（agents 表 schema）+ §4.3（OPENCODE_CONFIG_CONTENT 注入） + §4.4（写入串行 / 只读并发）

## 1. 总览

RFC-022 在不改变 opencode 子进程进入点、不改变 workflow.definition、不改变 envelope / outputs 语义的前提下，让 agent 能在自身声明 `dependsOn: string[]`，运行期框架递归解析闭包、把闭包内所有 agent 的 inline 定义一起塞进 `OPENCODE_CONFIG_CONTENT`，并把闭包内所有 agent.skills 的并集注入 `OPENCODE_CONFIG_DIR/skills/`。

### 1.1 数据流（运行期）

```
node_run start
  ├─ agent = getAgent(node.agentName)                    [scheduler.ts]
  ├─ closure = resolveDependsClosure(db, agent)          [新 services/agentDeps.ts]
  │    └─ BFS over agents.depends_on, cycle-guard
  ├─ skillsUnion = unique([
  │      ...agent.skills,
  │      ...closure.dependents.flatMap(a => a.skills)
  │    ])
  ├─ resolvedSkills = resolveSkills(db, appHome, skillsUnion)  [scheduler.ts:1058]
  ├─ runner.runNode({
  │      agent,
  │      dependents: closure.dependents,                 [新增字段]
  │      skills: resolvedSkills,
  │      ...
  │    })
  ├─ prepareSkills(runDir, resolvedSkills, log)          [runner.ts:339, 无改动]
  ├─ inlineConfig = buildInlineConfig(agent, overrides, dependents)
  │                                                       [runner.ts:360 改签名]
  └─ spawn opencode … env=OPENCODE_CONFIG_CONTENT=<JSON>
```

### 1.2 保存期校验

```
PUT /api/agents/:name
  ├─ validateDependsOn(db, name, patch.dependsOn)        [新 services/agentDeps.ts]
  │    ├─ each name must exist                           → agent-dependency-not-found
  │    ├─ name !== self                                  → agent-dependency-self
  │    └─ traverse closure                               → agent-dependency-cycle
  ├─ (existing) workflow-references guard
  └─ DB update agents.depends_on JSON-string

DELETE /api/agents/:name  &  POST /api/agents/:name/rename
  ├─ (existing) workflow-references guard
  ├─ (new) dependents-references guard                   → agent-dependency-still-referenced
  └─ proceed
```

## 2. Schema 变更

### 2.1 DB（agents 表）

新增列：

```sql
-- migrations/0006_agents_depends_on.sql
ALTER TABLE agents ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
-- TEXT, JSON-string of string[]; consistent with existing `skills` / `outputs` columns.

-- down:
ALTER TABLE agents DROP COLUMN depends_on;
```

约束：值必须是合法 JSON `string[]`，每个元素 match `AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/`，去重保序；超长（>64 项）拒绝（保存时校验，DB 不做 CHECK）。

### 2.2 Shared schemas（`packages/shared/src/schemas/agent.ts`）

在 `AgentSchema` / `CreateAgentSchema` 中并列 `skills` 字段后追加：

```ts
export const AgentSchema = z.object({
  ...
  skills: z.array(z.string()),
  dependsOn: z.array(AgentNameSchema).max(64),  // 新增
  ...
})

export const CreateAgentSchema = z.object({
  ...
  skills: z.array(z.string()).default([]),
  dependsOn: z.array(AgentNameSchema).max(64).default([]),  // 新增
  ...
})

export const UpdateAgentSchema = CreateAgentSchema.omit({ name: true }).partial()
// → dependsOn 自动继承为 optional
```

注意：

- 校验"名字存在 / 自引用 / 环"**不**在 zod 层做（zod 没有 DB 上下文），只校验长度与字符集；语义校验在 service 层。
- max(64) 是兜底硬上限，正常用例远低于此（用户层不暴露）。
- API 响应永远返回 dependsOn 字段（缺省 `[]`）；与 skills 完全平行。

### 2.3 错误码（`packages/shared/src/error-codes.ts` 若存在 enum，否则在调用处用字面量）

新增：

- `agent-dependency-not-found` —— body: `{ notFound: string[] }`
- `agent-dependency-self` —— body: `{ name: string }`
- `agent-dependency-cycle` —— body: `{ cyclePath: string[] }`（如 `['A','B','C','A']`）
- `agent-dependency-still-referenced` —— body: `{ referencedBy: string[] }`（agent name 列表）

错误层级：DomainError（400），与现有 skill 系列错误码并列。

## 3. 新增模块：`services/agentDeps.ts`

唯一职责：解析 dependsOn 闭包 + 校验。被 agent.ts（保存/删除/改名）、scheduler.ts（spawn 前）、workflow.validator.ts（节点校验）共用。

```ts
// packages/backend/src/services/agentDeps.ts
import type { Agent } from '@agent-workflow/shared'
import type { DbClient } from '../db'

export interface DependsClosure {
  /** Includes the root agent at index 0, then dependents in BFS order. */
  agents: Agent[]
  /** True if traversal completed without finding a cycle. */
  ok: true
}

export interface DependsClosureCycle {
  ok: false
  cyclePath: string[]  // e.g. ['A','B','C','A']
}

export type DependsClosureResult = DependsClosure | DependsClosureCycle

/**
 * BFS over agent.depends_on. Stops and returns `ok:false` with the cycle path
 * if any node is revisited along the current DFS path. Missing names are NOT
 * an error here — caller decides (save-time → reject; run-time → skipped
 * silently + handled by separate validation).
 */
export async function resolveDependsClosure(
  db: DbClient,
  root: Agent,
  opts?: { allowMissing?: boolean },  // default false → throw on missing
): Promise<DependsClosureResult>

/**
 * Save-time validation: name must exist (allowMissing=false), no self ref,
 * no cycle.  Throws DomainError with the matching code.
 *
 * Called from agent.ts createAgent / updateAgent before persisting.
 */
export async function validateDependsOn(
  db: DbClient,
  selfName: string,
  dependsOn: string[],
): Promise<void>

/**
 * "Who depends on me?" — used by delete / rename guards in agent.ts.
 * Implementation: SELECT name FROM agents WHERE depends_on LIKE '%"<name>"%'
 * then JSON.parse + exact match (LIKE is the filter, JSON.parse is the
 * authoritative include test to avoid substring false-positives).
 */
export async function findAgentsDependingOn(
  db: DbClient,
  name: string,
): Promise<string[]>
```

### 3.1 闭包算法（BFS）

```ts
async function resolveDependsClosure(db, root, opts) {
  const visited = new Map<string, Agent>([[root.name, root]])
  const order: Agent[] = [root]
  const queue: Array<{ name: string; path: string[] }> = []

  for (const dep of root.dependsOn) {
    queue.push({ name: dep, path: [root.name] })
  }

  while (queue.length > 0) {
    const { name, path } = queue.shift()!

    // cycle detection: name reappears on the path back to root
    if (path.includes(name)) {
      return { ok: false, cyclePath: [...path.slice(path.indexOf(name)), name] }
    }

    if (visited.has(name)) continue  // already loaded via different path

    const agent = await getAgentByName(db, name)
    if (agent === null) {
      if (opts?.allowMissing) continue
      throw new DomainError('agent-dependency-not-found', `agent '${name}' not found`, {
        notFound: [name],
      })
    }
    visited.set(name, agent)
    order.push(agent)

    for (const next of agent.dependsOn) {
      queue.push({ name: next, path: [...path, name] })
    }
  }

  return { ok: true, agents: order }
}
```

复杂度：O(N · D) where N=闭包 agent 数 / D=平均出度；典型 N<10 D<5 → < 50 次 DB SELECT，远低于 P-1-08 测试集 < 30ms 预算。

### 3.2 `validateDependsOn` 保存校验

```ts
async function validateDependsOn(db, selfName, dependsOn) {
  if (dependsOn.length === 0) return

  // 1. de-dup with order preserved (also done at schema level for defense in depth)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const n of dependsOn) {
    if (!seen.has(n)) {
      seen.add(n)
      unique.push(n)
    }
  }

  // 2. self-reference
  if (unique.includes(selfName)) {
    throw new DomainError('agent-dependency-self', `agent cannot depend on itself`, {
      name: selfName,
    })
  }

  // 3. each name must exist (BFS will surface this too, but we want a
  //    crisper error code for the direct-level case)
  const missing: string[] = []
  for (const n of unique) {
    if ((await getAgentByName(db, n)) === null) missing.push(n)
  }
  if (missing.length > 0) {
    throw new DomainError(
      'agent-dependency-not-found',
      `agent dependsOn references unknown agent(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }

  // 4. cycle: build a synthetic Agent-like root with the proposed dependsOn,
  //    run BFS. If selfName already exists in DB with old depends_on, BFS
  //    uses the proposed (in-memory) list for root and DB values for dependents.
  const syntheticRoot: Agent = {
    ...(await getAgentByName(db, selfName)) ?? { name: selfName, dependsOn: [], ...emptyAgentDefaults() },
    name: selfName,
    dependsOn: unique,
  }
  const closure = await resolveDependsClosure(db, syntheticRoot, { allowMissing: false })
  if (closure.ok === false) {
    throw new DomainError(
      'agent-dependency-cycle',
      `agent dependsOn forms a cycle: ${closure.cyclePath.join(' → ')}`,
      { cyclePath: closure.cyclePath },
    )
  }
}
```

边界：**新建 agent**（selfName 尚不在 DB）时 syntheticRoot 走"内存中根 + DB 中依赖"路径，BFS 不会回到 selfName（除非 self-ref，已被步骤 2 拦下），自然无环。

### 3.3 `findAgentsDependingOn` 反向查找

```ts
async function findAgentsDependingOn(db, name) {
  const candidates = await db
    .select({ name: agents.name, dependsOn: agents.dependsOn })
    .from(agents)
    .where(like(agents.dependsOn, `%"${name}"%`))  // LIKE 是过滤器，不是断言
  return candidates
    .filter((c) => {
      try {
        const parsed = JSON.parse(c.dependsOn) as string[]
        return Array.isArray(parsed) && parsed.includes(name)
      } catch {
        return false
      }
    })
    .map((c) => c.name)
}
```

50 条 agent / 平均 dependsOn 3 项时 < 5ms（SQLite LIKE 走索引扫描，JSON.parse 仅 N 次）。

## 4. 改动点：服务层

### 4.1 `services/agent.ts`

四处：

1. **createAgent** —— 落 DB 前 `await validateDependsOn(db, body.name, body.dependsOn ?? [])`。
2. **updateAgent** —— 同上，selfName 用 path 参数；patch.dependsOn 缺省 = 现 DB 值（不强制传整列表）。
3. **deleteAgent** —— 在现有"被 workflow 引用拒绝"检查后追加：

   ```ts
   const referencedBy = await findAgentsDependingOn(db, name)
   if (referencedBy.length > 0) {
     throw new DomainError(
       'agent-dependency-still-referenced',
       `agent '${name}' is referenced by other agents' dependsOn`,
       { referencedBy },
     )
   }
   ```

4. **renameAgent** —— 同 deleteAgent 的守卫；考虑到"rename 也可以选择把所有依赖方同步改名"——本 RFC 不实现自动级联（与 workflow 引用 rename 现行策略一致：拒绝、让用户先 deref）。

### 4.2 `services/scheduler.ts`

两处（对应主路径与 multi-process 子 shard 路径）：

1. **节点 spawn 前**（scheduler.ts:395 附近）：

   ```diff
    const agent = await getAgentByName(db, node.agentName)
    if (agent === null) { ... existing handle ... }
   +const closure = await resolveDependsClosure(db, agent, { allowMissing: false })
   +if (closure.ok === false) {
   +  return { kind: 'failed', summary: `agent-dependency-cycle`,
   +           message: closure.cyclePath.join(' → ') }
   +}
   +const dependents = closure.agents.slice(1)  // [0] 是 root；后面的是依赖
   +const skillsUnion = uniqueByName([
   +  ...agent.skills,
   +  ...dependents.flatMap((a) => a.skills),
   +])
   -const resolvedSkills = await resolveSkills(db, opts.appHome, agent.skills)
   +const resolvedSkills = await resolveSkills(db, opts.appHome, skillsUnion)
   ```

2. **multi-process 子 shard spawn 前**（scheduler.ts:823 附近）：同样改动。提取一个内联 helper `prepareNodeRunInjection(db, agent, appHome)` 给两处复用，返回 `{ dependents, resolvedSkills }`。

### 4.3 `services/runner.ts`

唯一改动点：`buildInlineConfig` 签名 + 调用。

```diff
 export interface RunNodeOptions {
   agent: Agent
+  /** Dependent agents resolved by scheduler.resolveDependsClosure (excluding root). */
+  dependents: Agent[]
   skills: ResolvedSkill[]
   ...
 }

-function buildInlineConfig(agent: Agent, overrides?: AgentOverrides) {
+function buildInlineConfig(
+  agent: Agent,
+  overrides: AgentOverrides | undefined,
+  dependents: Agent[],
+) {
   const ov = overrides ?? {}
   const primaryInline = buildInlineAgentEntry(agent, ov)
+  const depInline: Record<string, unknown> = {}
+  for (const dep of dependents) {
+    // dependents do NOT receive node-level overrides
+    depInline[dep.name] = buildInlineAgentEntry(dep, {})
+  }
-  return { agent: { [agent.name]: primaryInline } }
+  return { agent: { [agent.name]: primaryInline, ...depInline } }
 }

+function buildInlineAgentEntry(agent: Agent, ov: AgentOverrides): Record<string, unknown> {
+  const entry: Record<string, unknown> = {
+    prompt: agent.bodyMd,
+    description: agent.description,
+    permission: agent.permission,
+    options: { outputs: agent.outputs, readonly: agent.readonly },
+  }
+  const model = ov.model ?? agent.model
+  if (model !== undefined) entry.model = model
+  const variant = ov.variant ?? agent.variant
+  if (variant !== undefined) entry.variant = variant
+  const temperature = ov.temperature ?? agent.temperature
+  if (temperature !== undefined) entry.temperature = temperature
+  if (agent.steps !== undefined) entry.steps = agent.steps
+  return entry
+}
```

`runNode` 调用处：

```diff
-const inlineConfig = buildInlineConfig(opts.agent, opts.overrides)
+const inlineConfig = buildInlineConfig(opts.agent, opts.overrides, opts.dependents ?? [])
```

`opts.dependents` 默认 `[]`（runner 直接被旧测试调用的兜底路径，保持向后兼容）。

**没有其它改动**：spawn 命令仍 `opencode run … --agent <主 agent.name>`；envelope 解析仍按主 agent.outputs；prompt 拼接仍只用主 agent.bodyMd 模板。32KB warn：

```ts
const serialized = JSON.stringify(inlineConfig)
if (serialized.length > 32 * 1024) {
  log.warn('inline-config-large', { bytes: serialized.length, agents: Object.keys(inlineConfig.agent) })
}
```

### 4.4 `services/workflow.validator.ts`

现有循环（validator.ts:259 附近）对节点扫 `agent-not-found` + `skill-not-found`。扩展为：

```ts
for (const node of nodes) {
  if (node.kind === 'agent-single' || node.kind === 'agent-multi') {
    const agent = agentByName.get(name)
    if (agent === undefined) { ...existing... continue }

    // Existing: agent.skills must resolve
    for (const s of agent.skills) {
      if (!skillNames.has(s)) issues.push({ code: 'skill-not-found', ... })
    }

    // NEW: closure agents and their skills must resolve
    const seen = new Set<string>([agent.name])
    const queue = [...agent.dependsOn]
    while (queue.length > 0) {
      const depName = queue.shift()!
      if (seen.has(depName)) continue
      seen.add(depName)
      const dep = agentByName.get(depName)
      if (dep === undefined) {
        issues.push({
          code: 'agent-dependency-not-found',
          message: `agent '${agent.name}' (used by node '${node.id}') depends on unknown agent '${depName}'`,
          pointer: node.id,
        })
        continue
      }
      for (const s of dep.skills) {
        if (!skillNames.has(s)) {
          issues.push({
            code: 'skill-not-found',
            message: `dependent agent '${dep.name}' references unknown skill '${s}'`,
            pointer: node.id,
          })
        }
      }
      queue.push(...dep.dependsOn)
    }
  }
}
```

注意：环检测**不在 workflow validator 里重做**——保存阶段已拒绝，validator 看到的 agentByName 一定无环；但 BFS 用 `seen` set 兜底防外部 SQL 篡改产生的环导致死循环。

### 4.5 `services/agent-md-parser`（RFC-018 落地的 parser，所在路径以代码为准）

frontmatter 解析时把 `dependsOn` 视为已知字段：

```diff
 const known = ['name', 'description', 'model', 'variant', 'temperature',
                'permission', 'steps', 'maxSteps', 'outputs', 'readonly',
-               'skills', 'syncOutputsOnIterate']
+               'skills', 'syncOutputsOnIterate', 'dependsOn']
```

校验：`dependsOn` 必须是 string[]；非则落 frontmatterExtra 兜底（与现有 outputs/skills 兜底逻辑一致），不报错——保存阶段 zod + service 层再做强校验。

## 5. 改动点：前端

### 5.1 Agent 编辑表单（`pages/AgentDetail.tsx` / `pages/AgentNew.tsx`）

在 "Skills" chips 区段下方插入并列区段：

```tsx
<FormField label="Depends on agents">
  <ChipsInput
    candidates={otherAgents.map((a) => a.name)}  // 列表 \ self
    value={form.dependsOn}
    onChange={(v) => setForm({ ...form, dependsOn: v })}
    placeholder="Select agents to load alongside this one…"
  />
  {form.dependsOn.length > 0 && (
    <Hint>
      At runtime, these agents (and their dependencies recursively) will be
      injected into the same opencode process, with all their skills merged
      into the staging dir.
    </Hint>
  )}
</FormField>
```

下拉候选数据：直接复用 `/api/agents` 列表 query；过滤自身 name。

服务端错误回显：保存按钮失败时，捕获 `code in {agent-dependency-not-found, agent-dependency-self, agent-dependency-cycle, agent-dependency-still-referenced}`，渲染到该字段下方红字。`cycle` 时多渲染一个 path 箭头 string。

### 5.2 Agent 列表页（`pages/Agents.tsx`）

可选：在 agent 行展示 "Depends on" 列（chips 浓缩展示前 3 个 + "…")。本 RFC 不强制，留给 UI 微调；列表行已经较满，先以详情页为主。

### 5.3 节点 Stats tab（`components/StatsTab.tsx`）

在底部追加"Dependency tree"只读区段（共享 §5.5 `<DependencyTree>` 组件）：

```tsx
{closure.tree.children.length > 0 && (
  <Section label="Dependency tree">
    <DependencyTree
      tree={closure.tree}
      onNodeClick={(name) => router.navigate(`/agents/${name}`)}
    />
  </Section>
)}
```

数据来源：调 `GET /api/agents/:name/closure` 现场展开（详见 §5.6 endpoint），返回扁平 list + 嵌套 tree 两个视图。本 RFC **不新增 DB 列**做闭包快照——这与"node_run 跑过时闭包定义"可能微弱偏离（agent 之后被改），但对用户而言"当前依赖关系是什么"足够，复杂度低。如未来确需快照，另开 RFC。

### 5.4 Agent 编辑表单 `<DependencyTree>` 预览面板

在 "Depends on agents" chips 字段下方插入折叠面板（默认展开）：

```tsx
<FormField label="Dependency tree (preview)">
  {closurePreview.ok === false ? (
    <Error code={closurePreview.code} payload={closurePreview} />
  ) : closurePreview.tree.children.length === 0 ? (
    <Hint muted>
      No dependent agents declared. Add agents above to see the closure here.
    </Hint>
  ) : (
    <DependencyTree
      tree={closurePreview.tree}
      onNodeClick={(name) => router.navigate(`/agents/${name}`)}
    />
  )}
</FormField>
```

数据获取：表单 `dependsOn` 字段每次变更 → debounce 200ms → 调 `POST /api/agents/closure-preview { name: form.name, dependsOn: form.dependsOn }`（endpoint 详见 §5.6）。**不**落库；服务端只读 DB 里其它 agent 的 dependsOn 配合 draft 跑闭包。该 endpoint 也是后端校验环 / not-found 的最佳兜底面：与保存阶段同一路径，差别仅在不写入。

错误分支渲染：

- `agent-dependency-not-found` → "Unknown agent(s): foo, bar" 红字 + 指回 chips
- `agent-dependency-self` → "An agent cannot depend on itself."
- `agent-dependency-cycle` → 红色 banner + 渲染环路径作 ASCII 折线（如 `A → B → C → A`）

### 5.5 `<DependencyTree>` 共享组件

新文件 `packages/frontend/src/components/agents/DependencyTree.tsx`，纯展示组件，被 §5.3 / §5.4 共用。

输入：

```ts
interface DependencyTreeNode {
  name: string
  description: string
  skillCount: number
  readonly: boolean
  /** true 表示该节点是更上层已展开过的引用，children 不再递归（防止视觉刷屏） */
  duplicateRef: boolean
  children: DependencyTreeNode[]
}

interface DependencyTreeProps {
  tree: DependencyTreeNode  // 根（主 agent）
  onNodeClick?: (name: string) => void
}
```

渲染：纯 CSS 缩进 + ASCII 连接线（不引图形库），每行：

```
code-fixer  [2 skills, writes]
├─ code-auditor  [1 skill, readonly]
│  └─ code-explainer  [0 skills, readonly]
└─ unit-test-runner  [1 skill, readonly]
```

- 连接线 `├─` / `└─` / `│` 用 `<span class="dep-tree__guide">` 渲染，等宽字体 + 用 CSS 控件兜底（不依赖 box-drawing 字体）。
- 节点 label 部分用 `<button>`（visual button） + `onNodeClick(name)` 跳转 `/agents/:name`；可访问性 `aria-label`。
- chips：`[N skill(s), readonly|writes]`，与节点 list 视觉语言一致（复用既有 `.canvas-node__chip` 样式 token）。
- `duplicateRef === true` 行末追加 muted 文字 `↑ see above`，children 不再渲染（视觉不递归 → 否则同名 agent 重复展开多次很烦人；闭包本身在数据层已去重）。
- 环路径（仅 closure-preview 错误 banner 用）：横向单行 ASCII `A → B → C → A`，单独 `<DependencyCycleHint cyclePath={...} />` 渲染，不复用 tree 组件。

styles 落在 `frontend/src/styles.css` 新增 `.dep-tree` 系列（~20 行 CSS），不影响其它组件。

### 5.6 新增 endpoint：closure 查询与预览

两个 endpoint，挂在现有 `routes/agents.ts`：

```ts
// GET /api/agents/:name/closure
// 用于节点详情 Stats tab —— 取 DB 当前状态展开
// 200 响应：
{
  ok: true,
  flat: AgentSummary[],   // BFS 顺序，[0] = root
  tree: DependencyTreeNode,
}
// 404 响应（root agent 不存在）：
{ ok: false, code: 'agent-not-found', ... }
// 200 响应中 flat 内任一 agent 若有 missing dependsOn 引用（仅在用户跨进程改坏 DB 时可能），
// 该 agent 的 children 里出现一个 placeholder：{ name: '<missing>', children: [], ... }，
// duplicateRef:false skillCount:0 readonly:false —— 让 UI 显式画出缺失。
```

```ts
// POST /api/agents/closure-preview
// body: { name: string (self, may not yet exist for new-agent flow), dependsOn: string[] }
// 200 ok=true 响应：同 GET closure 的 flat + tree
// 200 ok=false 响应：
//   { ok: false, code: 'agent-dependency-not-found', notFound: string[] } |
//   { ok: false, code: 'agent-dependency-self', name: string } |
//   { ok: false, code: 'agent-dependency-cycle', cyclePath: string[] }
//
// 注意：preview 不返回 HTTP 400 而是 200 + ok:false，避免每次输入抖一抖都触发浏览器 4xx
// 网络面板红色；服务端写库路径（POST/PUT /api/agents）仍走 400。
```

实现：复用 §3 `resolveDependsClosure` + `validateDependsOn`，preview endpoint 内部包一层把 throw 收成 `{ ok: false, ... }` 返回。tree 构造单独一个小函数 `buildDependencyTree(flat: Agent[], rootName: string): DependencyTreeNode`，BFS 同一遍即可顺手 build。

### 5.7 Prompt Preview tab（`components/PromptPreview.tsx`）

dependsOn 不进 prompt，preview 拼接公式不变。仅在表单顶部 banner 文案里加一行："Runtime will also load N dependent agents (see Depends on field below)."

## 6. 测试策略

### 6.1 backend / shared 单元（bun:test）

| 文件                                                | 锁定语义                                                  | C-编号 |
| --------------------------------------------------- | --------------------------------------------------------- | ------ |
| `tests/agent-depends-on-save.test.ts`               | A2 四分支：not-found / self / cycle / de-dup 保留顺序     | C1     |
| `tests/agent-depends-on-cascade-guard.test.ts`      | A3：delete / rename 被引用拒绝；referencedBy 内容正确      | C2     |
| `tests/scheduler-depends-closure.test.ts`           | A5 闭包 BFS 顺序 + 去重 + 无环时 ok=true                  | C3     |
| `tests/runner-build-inline-config-multi.test.ts`    | inline JSON 含全部 entry；override 不渗透；32KB warn      | C4     |
| `tests/workflow-validator-depends.test.ts`          | A4 闭包内缺 agent / skill 都报；环不死循环                | C5     |
| `tests/agent-md-import-depends-on.test.ts`          | A8 frontmatter 解析 + 非数组兜底 frontmatterExtra         | C6     |
| `tests/agent-deps-find-depending-on.test.ts`        | findAgentsDependingOn 抗 LIKE 假阳性（子串 `foo` vs `foobar`） | 新增   |
| `tests/scheduler-skills-union.test.ts`              | skillsUnion 按 name 去重；prepareSkills 收到正确并集       | 新增   |
| `tests/agents-closure-endpoint.test.ts`             | `GET /api/agents/:name/closure` flat + tree 形态 / 404 root / missing dep placeholder | 新增   |
| `tests/agents-closure-preview-endpoint.test.ts`     | `POST /api/agents/closure-preview` 200+ok:true / 200+ok:false 三错误码（preview 不返 4xx）+ self-name 不在 DB（新建 agent draft） | 新增   |
| `tests/build-dependency-tree.test.ts`               | `buildDependencyTree` 纯函数：BFS 已展开节点二次出现 duplicateRef=true 且 children=[]；root.duplicateRef=false | 新增   |

### 6.2 frontend（vitest）

- `<AgentForm>` "Depends on agents" chips 渲染 + 选择 + 自身被过滤掉
- 保存失败时四种错误码 → 字段下方红字正确显示
- `<DependencyTree>` 渲染：单层 / 多层 / duplicateRef 行不递归子节点 / onNodeClick 触发跳转
- `<AgentForm>` dependsOn 改变 → debounce 后调 closure-preview → 渲染 tree（mock fetch）
- `<AgentForm>` closure-preview 返 `agent-dependency-cycle` → 渲染 `DependencyCycleHint` 带 path
- `<StatsTab>` 调 `GET /api/agents/:name/closure` → 渲染同一 `<DependencyTree>` 组件 + 空 children 走 "no dependents" 文案

### 6.3 集成 / e2e（Playwright 现有套件 + 1 条新 case）

- 现有 main.spec.ts 不退化
- 新增 case：创 3 个 agent（A→B→C）→ 编辑 A 表单加 dependsOn=[B] → 保存 → 启 task → 节点详情 Stats tab 出现 "Loaded dependent agents: B, C"

### 6.4 stub 验证

`tests/fixtures/stub-opencode.sh` 已支持读 env。新增一个 stub 模式：echo `OPENCODE_CONFIG_CONTENT` 解析出的 agent map 的 keys 到 stdout 一行 JSON event，便于 runner 测试断言 inline 注入的 agent map。

## 7. 兼容性 / 版本号

- **agents.$schemaVersion**：当前 v1。本 RFC 不改 schemaVersion（dependsOn 是**可选新字段，默认值不破坏旧 agent**）。如未来加 v2 字段，迁移函数 stub 已在 P-X-04 规划。
- **agent.md 导出**（如有；当前 RFC-018 主要做 import）：未来如增 export，frontmatter 直接打印 `dependsOn: [...]` 即可。
- **workflow YAML**：完全不涉及（agent 不出现在 workflow YAML 里，只通过 agentName 引用）。
- **opencode 兼容性**：opencode 接受 `OPENCODE_CONFIG_CONTENT` 里 agent map 含多 entry 是 v1 早已验证的能力（design.md §4.3 引用的 opencode `config.ts:641` merge 行为，对 map 任意 key 都按相同优先级 merge）。本 RFC 不改最低版本号。

## 8. 风险与缓解（design.md §17 风险表追加）

| 风险                                              | 概率 | 影响                  | 缓解                                                                              |
| ------------------------------------------------- | ---- | --------------------- | --------------------------------------------------------------------------------- |
| 闭包过大导致 inline JSON 超大（>32KB / OS env 限） | 低   | spawn 失败            | 32KB warn；64 项上限 hard cap；body 长度沿用 agents 表既有约束（无新增）           |
| LIKE 假阳性（name="foo" 在 "foobar" 的 dependsOn 里命中） | 中   | findAgentsDependingOn 误报      | C6 兜底 + JSON.parse 精确包含测；测试覆盖"foo" / "foobar" 子串场景           |
| 闭包内同名 skill 但 source 不同（managed vs external 同名） | 极低 | prepareSkills 后行为不确定          | 同名 skill DB 唯一约束（skills 表 PK），不存在真实歧义；测试 `tests/scheduler-skills-union.test.ts` 锁去重     |
| 用户删 agent 时直接 SQL 跳过守卫造成 dependsOn 死引用    | 低   | 运行期节点 fail | 运行期 `resolveDependsClosure(allowMissing: false)` 抛 `agent-dependency-not-found`；UI 已有 "node failed: <code>" 横幅 |
| 多并发写 agents 表造成 dependsOn 与 self 同时改坏    | 极低 | 短暂出现"指向我但我已改名"中间态 | agent.ts 已对 CRUD 串行（无显式锁，但 SQLite WAL + 单 daemon 自然串行）；本 RFC 不改并发模型 |

## 9. 编号清单（给 plan.md 对应）

- T1 — 落 migration 0006 + shared schema dependsOn
- T2 — `services/agentDeps.ts` 新模块（resolveDependsClosure / validateDependsOn / findAgentsDependingOn）+ 单元测试
- T3 — `services/agent.ts` 在 create / update / delete / rename 接入 deps guard + 测试
- T4 — `services/scheduler.ts` 两处接入闭包展开 + skills 并集 + 测试
- T5 — `services/runner.ts` buildInlineConfig 改签名 + 32KB warn + 测试
- T6 — `services/workflow.validator.ts` 闭包扫描 + 测试
- T7 — agent.md parser dependsOn 字段 + 测试
- T8 — 前端 AgentForm "Depends on agents" chips + 错误回显 + 测试
- T9 — `<DependencyTree>` 共享组件 + `buildDependencyTree` 纯函数 + styles + 单测
- T10 — `GET /api/agents/:name/closure` + `POST /api/agents/closure-preview` endpoints + 测试；前端 AgentForm 接 closure-preview（debounce + tree 渲染 + cycle banner）；前端 StatsTab 接 closure GET 渲染 tree
- T11 — e2e Playwright A→B→C 闭包 case（含编辑表单里看到 tree + Stats tab 看到同一 tree）+ 全套门槛（typecheck + test + format:check）

每个 Tn 默认对应一个 commit，整体一个 PR（与 RFC workflow 默认对齐）。
