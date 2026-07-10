# RFC-166 design——Agent 能力层技术设计

> 配套 proposal.md（拍板 5 条）。所有对现有代码的断言经调研核实，file:line 基于 2026-07-10 工作树。
> 前置于 RFC-167；本 RFC 只落「schema + 能力卡 + leader 接入 + 编辑器」，不动执行引擎。

## 0. 总览

> **现状 vs 新增**（措辞澄清，回应设计门）：下面三块全部是 RFC-166 **要新建的物**——当前
> `shared/src/schemas/agent.ts` 无 `inputs` 字段、`workgroupContext.renderRosterBlock` 只输出
> roleDesc、无能力卡纯函数。「当前代码没有」正是本 RFC 要做的原因，不是「文档宣称已存在」的
> 断言不一致（设计门把 RFC 目标误读为现状断言，此处统一澄清；本节的 file:line 引用是**落点**
> 而非「已实现」证据）。

三块，全部**纯叠加**（零回归）：

1. `agents.inputs` 可选声明式输入端口（与 `outputs` 对称）——新增字段。
2. `renderAgentCapabilityCard` 纯函数——能力卡投影（shared，供后端注入 + 前端预览共用）——新增。
3. leader 花名册接入能力卡（补强 RFC-164 `services/workgroupContext.ts` 的 roleDesc-only）——改造。

| 抉择                   | 方案                                                                                                                                      | 理由                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| inputs 存哪            | `agents.inputs` JSON 列（照 `outputs` schema.ts:26 先例）+ kind 存 `inputKinds`（照 `outputKinds`/`frontmatter_extra` 先例，agent.ts:82） | 与 outputs 完全对称，最小认知负担                             |
| 是否强校验 inputs↔edge | v1 **不强校验**（validator 现 prompt-template 规则不动）                                                                                  | 存量兼容（决策 #4）；强校验作为叠加留后续，避免卡住存量工作流 |
| 能力卡放哪             | shared 纯函数（`shared/src/prompt.ts` 旁或新 `agentCapability.ts`）                                                                       | 后端注入（leader/编排 agent）+ 前端预览共用一份，杜绝漂移     |
| prompt 隔离            | 能力卡只含 agent 自身声明字段（name/description/inputs/outputs/role/bodyMd 摘要）；**绝不含 user_id**                                     | 沿 RFC-099 不变式；human 成员无能力卡（仍 displayName）       |

## 1. 数据模型

### 1.1 `agents.inputs`（可选声明式输入端口）

```
// shared/src/schemas/agent.ts — 与 outputs / outputKinds 对称
export const AgentInputPortSchema = z.object({
  name: PortNameSchema,           // 复用端口名规则（与 outputs 端口名同源）
  kind: z.string().default('string'),  // kindParser 文法：string|markdown|signal|path<ext>|list<T>
  required: z.boolean().optional(),
  description: z.string().optional(),
})
export type AgentInputPort = z.infer<typeof AgentInputPortSchema>
```

- `AgentSchema` 增 `inputs: z.array(AgentInputPortSchema).default([])`（响应恒有，缺省 `[]`）。
- `CreateAgentSchema`/`UpdateAgentSchema` 增 `inputs: z.array(AgentInputPortSchema).default([])`
  （agent.ts:158 outputs 同款）。
- DB：`agents` 加 `inputs text NOT NULL DEFAULT '[]'`（JSON string[]，照 `outputs` schema.ts:26）。
  kind 若与 outputs 一样想独立存，可并入 `inputs` 每项的 `kind` 字段（不必单开 `inputKinds` 列——
  outputs 因历史原因把 kind 拆到 `outputKinds`/frontmatter，inputs 是新字段可直接内联 kind）。
- 校验：`kind` 走 `parseKind`（kindParser.ts）——非法 kind 在 CRUD 层 422；端口名组内唯一。
- **存量兼容**：不声明 = `[]`，运行时 `renderUserPrompt`/`prepareNodeRunInjection` 路径完全不读
  `inputs`（隐式 `{{token}}` 接入不变）——`inputs` 目前**只被能力卡消费**，不进 spawn 逻辑。

### 1.2 agent.md frontmatter round-trip

`inputs` 随 agent.md frontmatter 存取（照 outputs：DB 列 + frontmatter 双向，agent-md.ts）。
frontmatter 形态：

```yaml
inputs:
  - name: audit_report
    kind: markdown
    required: true
    description: the auditor's findings
```

## 2. 能力卡（shared 纯函数）

`shared/src/agentCapability.ts`（新）：

```
export interface CapabilityCardOptions {
  /** system prompt 摘要字符预算（0 = 不含 prompt）。默认 600。 */
  promptBudget?: number
}

export function renderAgentCapabilityCard(
  agent: Pick<Agent, 'name'|'description'|'inputs'|'outputs'|'outputKinds'|'role'|'bodyMd'>,
  opts?: CapabilityCardOptions,
): string
```

渲染（markdown 块，english headers 沿 prompt.ts 约定）：

```
### <name>
<description>
- role: aggregator | normal
- inputs: audit_report (markdown, required), context (string)   // 空 → "inputs: (none declared)"
- outputs: diff (markdown), summary (string)                     // outputs + outputKinds 合成 kind
- prompt: <bodyMd 首 N 字符摘要，clipByBudget 同思路 memoryInject.ts:286>
```

- outputs 的 kind 从 `outputKinds`（agent.ts:82）合成，缺省 `string`。
- inputs 的 kind 内联。
- prompt 摘要预算裁剪（`promptBudget=0` 时省略——leader 精简场景可关）。
- **纯投影**：不读 DB、不含 user_id/ACL/时间戳——只 agent 自身能力字段。
- 配套 `renderRosterCapabilityCards(agents[])` 批量渲染（编排 agent 一次注入整池）。

**字段与脱敏契约（设计门 medium）**：能力卡的**白名单字段**恒定为
`{name, description, inputs[], outputs[], role, promptSummary}`——**不含**任何 `ownerUserId`/
`visibility`/`createdAt` 等 ACL/审计字段（`renderAgentCapabilityCard` 的入参类型用
`Pick<Agent, ...>` 把可见字段钉死在类型层，杜绝误传）。长度约束：`description` 原样、
`promptSummary` ≤ `promptBudget`（默认 600 字符）、单卡总长有软上限（多成员 leader 花名册
按 `rosterBudget` 再裁）。**prompt 隔离双层锁**（rfc099-prompt-isolation 扩展）：① 类型层
Pick 不含 userId；② 运行期文本断言——渲染输出不含任何 user id 子串。

## 3. leader 花名册接入（补强 RFC-164）

`services/workgroupContext.ts` 的 `renderRosterBlock`（RFC-164）当前每成员一行
`@displayName (type) — roleDesc`。改为：

- **agent 成员**：`@displayName` + roleDesc（组内职责）叠加**能力卡**（description/inputs/outputs/
  role/prompt 摘要）——leader 看到真实能力。能力卡经 `getAgent(db, member.agentName)` 载入
  agent 后 `renderAgentCapabilityCard` 渲染（花名册渲染处需要 agent 对象，故 workgroupContext
  的花名册渲染改为异步/预载 agent map）。
- **human 成员**：无能力卡（仍 `@displayName (human) — roleDesc`）——沿 prompt 隔离（human 无
  agent 能力，且不泄 user_id）。
- roleDesc 保留语义：「本组内的角色定位」（用户手填），叠加在能力卡之上——能力卡说「这个 agent
  能干什么」，roleDesc 说「在这个组里它负责什么」。

改动面：

- `renderRosterBlock` 签名加 `agentCards: Map<memberId, string>`（预渲染的能力卡）或改为接收
  已载入的 agent map；工作组引擎（workgroupRunner.ts composeLeaderPrompt/composeMemberPrompt）
  在组 prompt 前预载成员 agent 并渲染卡。
- 注入预算：能力卡 prompt 摘要用较小 budget（leader 花名册可能多成员，控 token）。
- **测试**：花名册块含成员 agent 的 description/outputs（纯函数断言）；prompt 隔离双层锁扩展
  （rfc099-prompt-isolation：能力卡无 user_id）。

## 4. 前端

### 4.1 agent 编辑器输入端口

`agents.detail`/`agents.new` 的 outputs 端口编辑区旁，新增**对称的 inputs 端口编辑**
（复用 outputs 的端口行组件：name + kind Select + required Switch + description）。端口名/kind
前端预校验（组内唯一、kind 合法）。

### 4.2 能力卡预览组件

`components/agent/AgentCapabilityCard.tsx`（新，公共原语）：把能力卡渲染成 UI 卡片（复用
`renderAgentCapabilityCard` 的结构化数据或直接结构化组件）。复用点：

- 工作组建组成员选择（RFC-164 WorkgroupMemberCards 的 agent 选择器旁显示候选能力）。
- RFC-167 动态 workflow 空间选 agent 池。
- agent 详情页自身预览。

## 5. 迁移与测试

- migration NNNN：`agents ADD inputs text NOT NULL DEFAULT '[]'`；journal +1；upgrade-rolling
  计数锁 bump；agents 全字段锁 +1。纯 additive、无 backfill。
- 测试：
  - shared：`AgentInputPortSchema`/`AgentSchema.inputs` zod 正反例；`renderAgentCapabilityCard`
    逐字段（空 inputs/outputs、prompt 预算裁剪、kind 合成、role）。
  - backend：agent CRUD round-trip inputs（DB↔frontmatter）；kind 非法 422；端口名重名；
    workgroupContext 花名册含能力卡 + prompt 隔离无 user_id；migration 行锁。
  - frontend：inputs 端口编辑器（增删/校验）；AgentCapabilityCard 渲染；工作组建组能力预览。
  - 零回归锁：validator prompt-template 规则不变（既有测试全绿）；存量 agent（inputs=[]）
    spawn 路径不读 inputs（源码/行为锁）。

## 6. 与 RFC-167 的接口

RFC-167 内置编排 agent 消费：`renderRosterCapabilityCards(池内 agents)` 注入 prompt → 编排 agent
据此生成 workflow。RFC-167 依赖本 RFC 的能力卡 + inputs（编排时按 inputs/outputs kind 做产出/
消费匹配的确定性部分，语义推断兜底）。本 RFC 不含任何 workflow 生成/执行逻辑。
