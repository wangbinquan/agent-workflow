# RFC-348 技术设计：Intent 能力全景注册表与 INTENT.md 派生（r12）

对应 [proposal.md](./proposal.md)（裁决 D1～D12）。写本文前已读 RFC-294 `proposal.md §1/§3` 与 `design.md §1/§2/§3`；
r2 折入设计门 r1 的 23 条，r3 折入 r2 的 9 条，r4 折入 r3 的 6 条，r5 折入 r4 的 4 条，r6 折入 r5 的 5 条，r7 折入 r6 的 5 条，
r8 折入 r7 的 4 条，r9 折入 r8 的 3 条并附编译探针验证，r10 折入 r9 的 3 条（`fieldSources` 合同入探针、T1.6 时序、门记录四文件；另清除了与 §1.1
矛盾的旧声明），r11 折入 r10 的 4 条（探针扩到全部 8 种 strict kind 并与 §1.1 逐字一致、`AuthorableAvailability`、清单补 `position`）；r12 折入用户
批准时的三项另裁（sidecar 省略即保留、mcp `oauth` 可创作、九类只读真实行）（见 proposal §8）。

## 0. 落位（RFC-294）

| 改动 | bounded context / 层 | 说明 |
| --- | --- | --- |
| `modules/intent/domain/teaching/{types,nodeKinds,resourceTypes,workflowParts,platformMap,reconciliation,render}.ts` | `intent` / **domain** | 纯数据 + 纯函数；只 import `@agent-workflow/shared` 与 `zod` 类型。受 `rfc294-review-module-layer-rules` 的 domain 禁令约束（不得 import `@/db`、`node:fs`、`@/routes`、`@/ws`、`@/server`、drizzle、hono）。 |
| `services/intent/intentDoc.ts` | `intent` / services 过渡层 | 由「500 行字面量」收成「按节调用 domain 渲染器 + 会话态拼接」；不再持有任何 kind / 类型清单。 |
| `services/intent/turnEngine.ts`、`dispatcher.ts` | `intent` / services 过渡层 | 首轮 hint 读取 → `requestedArtifactType`；`IntentTurnConfig` 增 `effectiveDefaultRuntime: {name, protocol}`；`RunIntentTurnDeps.platformInventory?` 注入 seam；draft 校验带 `dump.agentBranchPorts`（`dispatcher.ts` 未改动）。 |
| `services/intent/dumpBuilder.ts`、`manifest.ts`、新 `services/intent/platformInventory.ts` | `intent` / services 过渡层（RFC-345 §4 范围内） | agent dump 顶层 `branchPorts`；`inventory/runtimes.md`（`listRuntimes` 在 dump 内读）；agent 行端口名（默认投影 `loadAgentPortsFromDb` 在 dump 内对截断后的 id 执行，`IntentDumpInput.loadAgentPorts` 可注入）；`inventory/platform/<type>.md` 九类只读行；if-else 链改 `satisfies Record` 表。 |
| `services/intent/resolveChangeset.ts`、`applyChangeset.ts` | `intent` / services 过渡层（RFC-345 T4b/T7 cohort） | `branchPorts` 透传；update presence-aware 保留；`never` 穷尽守卫。 |
| `packages/shared/src/schemas/{workflow,agent,intentChangeset,intentSession}.ts` | shared 合同 | `LOOP_EXIT_CONDITION_KINDS`；`OPENCODE_PERMISSION_{KEYS,ACTIONS,WILDCARD_KEY}`；`IntentAgentPayloadSchema.branchPorts`；`hint` 枚举化。 |
| `modules/task-execution/domain/loopExitCondition.ts`、`modules/task-execution/public/queries.ts`、`services/workflow.validator.ts`、`services/runtime/opencode/boundary.ts`、`services/runtime/claudeCode/permissionMap.ts` | 各自现有层 | 改为消费 shared 常量（类型与运行时行为、错误码不变）。 |
| 前端 `components/intent/*`、`IntentMountDialog.tsx`、`IntentEntryButton.tsx`、`IntentProvenanceBadge.tsx`、`routes/intent.tsx`、`canvas/inspector/WrapperGitLoopEdit.tsx`、`i18n/{en-US,zh-CN}.ts` | frontend | 从 shared roster / 常量派生。 |
| `packages/backend/tests/intent-teaching-exhaustive.test.ts` | 测试（普通 `*.test.ts`，随 tsconfig `tests/**/*` 进 typecheck） | 常驻编译期负例（仓内先例：`tests/rfc148-adt-contracts.test.ts:32-35` 的 `@ts-expect-error` 断言）。 |

跨模块 import 检查：intent domain **不** import `task-execution` 或 `services/runtime` 的任何路径（退出条件 kinds 与权限词表
下沉 shared 正是为此）；`services/intent/*` 对 `modules/intent/domain/*` 的 import 与既有 `workflowCreateLayout` 精确同形
（RFC-302 先例，`turnEngine.ts:60`）。不新增 `routes/` / `services/` 横向耦合，不新增 facade。

## 1. 注册表模型

### 1.1 通用类型与 zod 键提取（`teaching/types.ts`）

```ts
/** 形态片段规则：**外层字段名不预带 `?`**（渲染器按 `required` 在首个标识符后插入）；片段内部描述子字段的 `?`
 *  （如 `exitCondition:{kind:…,value?,n?}`）属于子字段说明，原样输出；渲染后断言不含 `??`。
 *  字段条目的类型（`FieldTeachingFor` / `TeachingFieldsOf` / `IntentVariantTeaching`）见下方**经编译验证的原文**，这里不再重复声明。 */

export type IntentNodeAvailability =
  | { kind: 'public' }
  | { kind: 'privileged'; permission: 'scripts:author' | 'code-host-calls:author'; redactedFields: readonly string[]; overviewLabel: string; nestedRedactionHint: string; untouchableFields: string }
  | { kind: 'synthesized-only' }

/** passthrough 字段的来源声明：`readPoint` 指向真实读点（后端或前端文件，仓根相对路径）；`intentOnly` 指向 resolve seam。 */
export type IntentPassthroughFieldSource =
  | { readonly readPoint: { readonly file: string; readonly identifier: string } }
  | { readonly intentOnly: { readonly resolvedIn: 'packages/backend/src/services/intent/resolveChangeset.ts' } }
```

zod 键提取与字段表派生（zod ^3.23，**已用 `tsc 5.9.3` + 仓内 `zod 3.25.76` 对真实 shared schema 编译验证**：r8 设计门后写了一份
探针——与本节**逐字相同**的类型 + 六类真实资源表 + **全部 8 种 strict kind**（字段按真实 schema 填写）+ 五种 passthrough kind
（含 `fieldSources`）+ `code-round` + 八个 `@ts-expect-error` 负例（`type-probe.md`）——
`tsc --noEmit` 零错误；再对探针做五处变异（A object 字段去掉 `nested`、B plugin 表删 `optionsJson`、C mcp remote 子表删 `timeoutMs`、
D passthrough kind 去掉 `fieldSources`、E strict kind 加上 `fieldSources`）分别得到 TS2322 / TS2741 / TS2741 / TS2561 / TS2322。探针随实现进 `tests/intent-teaching-exhaustive.test.ts`，探针文本附实现报告）。两个关键点：
**TypeScript 对对象联合做 `keyof` 得到的是交集**，所以 `KeysOf` 必须在裸类型参数上分配；**`keyof never` 是
`string | number | symbol`**，所以终止分支只允许 `ZodObject` 贡献键；zod 的 `ZodObject<Shape, UnknownKeys, Catchall>` 在
`.strict()` / `.passthrough()` 下 `UnknownKeys` 不是默认值，模式匹配必须写成 `z.ZodObject<infer Shape, any, any>`：

```ts
type Unwrap<S> =
  S extends z.ZodEffects<infer I, any, any> ? Unwrap<I>
  : S extends z.ZodOptional<infer T> ? Unwrap<T>
  : S extends z.ZodDefault<infer T> ? Unwrap<T>
  : S extends z.ZodNullable<infer T> ? Unwrap<T>
  : S
type ShapeOf<S> = Unwrap<S> extends z.ZodObject<infer Shape, any, any> ? Shape : never
type OptionsOf<S> =
  Unwrap<S> extends z.ZodDiscriminatedUnion<any, infer O> ? O[number]
  : Unwrap<S> extends z.ZodUnion<infer O> ? O[number]
  : never
/** 在裸参数 S 上分配：union 得到键的并集，不是交集 */
type KeysOf<S> = S extends unknown ? KeysOfInner<Unwrap<S>> : never
type KeysOfInner<U> =
  U extends z.ZodDiscriminatedUnion<any, infer O> ? KeysOf<O[number]>
  : U extends z.ZodUnion<infer O> ? KeysOf<O[number]>
  : U extends z.ZodArray<infer E, any> ? KeysOf<E>
  : U extends z.ZodObject<infer Shape, any, any> ? keyof Shape & string
  : never                                                                     // 原始类型 / record / literal 不贡献键
type DiscriminatorOf<S> = Unwrap<S> extends z.ZodDiscriminatedUnion<infer D, any> ? D : never
type VariantValues<S> = OptionsOf<S> extends infer O ? (O extends z.ZodTypeAny ? z.infer<O>[DiscriminatorOf<S> & keyof z.infer<O>] & string : never) : never
type OptionFor<S, V extends string> = OptionsOf<S> extends infer O ? (O extends z.ZodTypeAny ? (z.infer<O> extends Record<DiscriminatorOf<S>, V> ? O : never) : never) : never
type FieldSchemaAt<S, K extends string> = ShapeOf<S> extends infer Shape ? (K extends keyof Shape ? Shape[K] : never) : never
type ElementOf<F> = Unwrap<F> extends z.ZodArray<infer E, any> ? Unwrap<E> : Unwrap<F>
type IsObjectLike<F> = [KeysOf<F>] extends [never] ? false : true
type ObjectOptionsOf<U> = U extends z.ZodUnion<infer O> ? Extract<O[number], z.ZodObject<any, any, any>> : never

/** discriminatedUnion 的按变体子表：`variants` 以判别值联合键控（新增变体未建表 ⇒ 红），每个变体的字段表由其 option 派生 */
export interface IntentVariantTeaching<S> {
  readonly discriminator: DiscriminatorOf<S>
  readonly variants: { readonly [V in VariantValues<S>]: TeachingFieldsOf<OptionFor<S, V>> }
}
type NestedFor<F> =
  ElementOf<F> extends z.ZodDiscriminatedUnion<any, any> ? IntentVariantTeaching<ElementOf<F>>
  : ElementOf<F> extends z.ZodUnion<any> ? TeachingFieldsOf<ObjectOptionsOf<ElementOf<F>>>     // 普通 union：只对对象 option 建表（agent skills）
  : TeachingFieldsOf<ElementOf<F>>
type ScalarTeaching = { readonly form: string; readonly required: boolean; readonly note?: string; readonly mistake?: string; readonly nested?: never }
type ObjectTeaching<F> = { readonly form: string; readonly required: boolean; readonly note?: string; readonly mistake?: string; readonly nested: NestedFor<F> }
type Omitted = { readonly omit: true; readonly why: string }
/** 对象 / 对象数组 / 变体字段**强制**带 schema 键控的 `nested`；标量字段禁止 `nested` */
export type FieldTeachingFor<F> = Omitted | (IsObjectLike<F> extends true ? ObjectTeaching<F> : ScalarTeaching)
/** 由 schema 形状派生的字段表：键 = `KeysOf<S>`，值 = 按该字段 zod 类型条件化的教学条目 */
export type TeachingFieldsOf<S> = { readonly [K in KeysOf<S>]: FieldTeachingFor<FieldSchemaAt<S, K>> }
/** 资源根：mcp 这类 discriminatedUnion 根直接用变体表（doc 今日也按 `{type:'local',…}` OR `{type:'remote',…}` 两形态教） */
type ResourceFieldsOf<S> = Unwrap<S> extends z.ZodDiscriminatedUnion<any, any> ? IntentVariantTeaching<S> : TeachingFieldsOf<S>

// ── 两张注册表的 satisfies 目标：由 schema 派生的 mapped type ──
type IntentPayloadSchemaOf = { agent: typeof IntentAgentPayloadSchema; skill: typeof IntentSkillPayloadSchema; mcp: typeof IntentMcpPayloadSchema; plugin: typeof IntentPluginPayloadSchema; workflow: typeof IntentWorkflowPayloadSchema; workgroup: typeof IntentWorkgroupPayloadSchema }
export interface IntentResourceTeaching<Fields> { readonly fields: Fields; readonly notes: readonly string[]; readonly mistakes: readonly string[] }
export const INTENT_RESOURCE_TEACHING = { … } satisfies { readonly [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }

type StrictNodeSchemaOf = { review: typeof ReviewNodeSchema; clarify: typeof ClarifyNodeSchema; 'clarify-cross-agent': typeof ClarifyCrossAgentNodeSchema; 'wrapper-fanout': typeof WrapperFanoutNodeSchema; 'call-workflow': typeof CallWorkflowNodeSchema; 'call-workgroup': typeof CallWorkgroupNodeSchema; script: typeof ScriptNodeSchema; 'code-host-call': typeof CodeHostCallNodeSchema }
type NodeBaseKey = 'id' | 'kind' | 'position' | 'title' | 'agentId'                       // 在总说明句里统一教
type IntentOnlyNodeFields<K> = K extends 'call-workflow' ? { readonly workflowRef: ScalarTeaching } : K extends 'call-workgroup' ? { readonly workgroupRef: ScalarTeaching } : {}
/** `Omit` 作用在**派生出的字段表类型**上（r7 finding 2：作用在 schema 实例上会得到 never 键） */
type StrictNodeFields<K extends keyof StrictNodeSchemaOf> = Omit<TeachingFieldsOf<StrictNodeSchemaOf[K]>, NodeBaseKey> & IntentOnlyNodeFields<K>
type PassthroughKeysOf<K> =
  K extends 'wrapper-loop' ? 'nodeIds' | 'maxIterations' | 'exitCondition' | 'outputBindings' | 'continueOnMaxIterations'
  : K extends 'agent-single' ? 'agentRef' | 'promptTemplate' : K extends 'input' ? 'inputKey' : K extends 'output' ? 'ports' : K extends 'wrapper-git' ? 'nodeIds' : never
/** 可创作 kind 的 availability 不含 synthesized-only（r10 finding 1：否则非 code-round 的 kind 也能被标成 synthesized-only） */
type AuthorableAvailability = Exclude<IntentNodeAvailability, { kind: 'synthesized-only' }>
/** strict kind：不得有 `fieldSources`；passthrough kind：`fieldSources` 必须恰好覆盖每个声明字段（探针变异 D/E 验证） */
type AuthorableNodeTeaching<Fields, Sources = undefined> = {
  readonly availability: AuthorableAvailability
  readonly fields: Fields
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
} & (Sources extends undefined ? { readonly fieldSources?: never } : { readonly fieldSources: Sources })
/** synthesized-only 没有 `fields` 属性（`Record<never, never>` 等于 `{}`、挡不住多余键；`fields?: never` 才挡得住） */
type SynthesizedNodeTeaching = { readonly availability: { kind: 'synthesized-only' }; readonly notes: readonly string[]; readonly mistakes: readonly string[]; readonly fields?: never }
type NodeTeachingOf<K extends NodeKind> =
  K extends 'code-round' ? SynthesizedNodeTeaching
  : K extends keyof StrictNodeSchemaOf ? AuthorableNodeTeaching<StrictNodeFields<K>>
  : AuthorableNodeTeaching<{ readonly [P in PassthroughKeysOf<K>]: ScalarTeaching }, { readonly [P in PassthroughKeysOf<K>]: IntentPassthroughFieldSource }>
export const INTENT_NODE_TEACHING = { … } satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }
```

常驻夹具（§9，探针已逐条验证为真错误）：缺登记三向（缺 kind / 缺 IntentResourceType / 缺 AclResourceType）、扩字段三向
（顶层 `ReviewNodeSchema.extend` / 嵌套 `ScriptOutputPortSchema.extend` / variant-only workgroup agent 变体）、新增变体一向
（mcp 第三个 option）、**新增对象字段只登记父字段一向**（`ReviewNodeSchema.extend({policy: z.object(…)})`），共八个；正例：同一
`policy` 带 `nested` 即可编译。形态行由 `fields` 渲染为 `{id,kind:'<kind>',<form>[,<form>?]…}`，`omit` 的不出现；锚点
`{id,kind:'<kind>'` 与现有守卫测试完全一致。

### 1.2 节点形态注册表（`teaching/nodeKinds.ts`）

```ts
export const INTENT_NODE_TEACHING = {
  review: {
    availability: { kind: 'public' },
    fields: {
      inputSource: { form: 'inputSource:{nodeId,portName}', required: true, nested: WORKFLOW_PORT_REF_TEACHING },   // §1.3 的统一 PortRef 子表，边 source/target 与 output bind 同用
      description: { form: 'description', required: false },
      rerunnableOnReject: { form: 'rerunnableOnReject:[nodeId]', required: true },
      rerunnableOnIterate: { form: 'rerunnableOnIterate:[nodeId]', required: true },
      rollbackFilesOnReject: { form: 'rollbackFilesOnReject', required: false },
      rollbackFilesOnIterate: { form: 'rollbackFilesOnIterate', required: false },
      commentInjectTemplate: { form: 'commentInjectTemplate', required: false },
      assignee: { omit: true, why: 'reserved schema slot; UI does not surface it (review.ts)' },
    },
    notes: ['Also add the matching source→review edge targeting `__review_input__`; …'],   // 现句逐字
    mistakes: [],
  },
  script: {
    availability: { kind: 'privileged', permission: 'scripts:author', redactedFields: SCRIPT_REDACTED_FIELDS, … },
    fields: {
      language: { form: "language:'python'|'bash'|'node'", required: true },
      script: { form: 'script', required: true },
      outputs: { form: 'outputs:[{name,kind?,branch?}]', required: false,
        nested: { name: {…}, kind: {…}, branch: { form: 'branch', required: false, note: 'RFC-306 …' } } },
      dependencies: {…}, env: {…}, readonly: {…},
    },
    …
  },
  'code-host-call': { … request: { nested: … satisfies Record<KeysOf<typeof CodeHostCustomRequestSchema>, …> } … },
  'wrapper-fanout': { … inputs: { nested: … satisfies Record<KeysOf<typeof WrapperFanoutPortSchema>, …> } … },
  'call-workflow': {
    fields: {
      workflowName: { form: "workflowName:'<exact target name>'", required: true },
      workflowRef: { form: 'workflowRef', required: false, note: '…handle or $new tempRef…' },
      workflowId: { omit: true, why: 'canonical ULID cache — model-forbidden (RFC-291 面 E)' },
      limits: { form: 'limits:{maxDurationMs?,maxTotalTokens?}', required: false, nested: {…} },
    },
  },
  clarify: {
    fields: { description, sessionMode, clarifyMode, assignee: { omit: true, … } } ,
    notes: [`Fixed ports: inbound \`${CLARIFY_INPUT_PORT_NAME}\` (wire the asking agent's \`${CLARIFY_SOURCE_PORT_NAME}\` port to it), outbound \`${CLARIFY_OUTPUT_PORT_NAME}\` (wire it back to that agent's \`${CLARIFY_RESPONSE_TARGET_PORT_NAME}\` port).`],
  },
  'clarify-cross-agent': { … notes: [ …CROSS_CLARIFY_INPUT_PORT_NAME / CROSS_CLARIFY_OUT_TO_DESIGNER_PORT / CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT… ] },
  'wrapper-loop': {
    fields: {
      nodeIds: { form: 'nodeIds:[nodeId]', required: true },
      maxIterations: { form: 'maxIterations', required: true },
      exitCondition: { form: `exitCondition:{kind:${LOOP_EXIT_CONDITION_KINDS.map(k => `'${k}'`).join('|')},nodeId,portName,value?,n?,separator?}`, required: true },
      outputBindings: { form: 'outputBindings:[{name,bind:{nodeId,portName}}]', required: true },
      continueOnMaxIterations: { form: 'continueOnMaxIterations', required: false, note: 'RFC-236 …' },
    },
    fieldSources: {
      nodeIds: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'nodeIds' } },
      maxIterations: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'maxIterations' } },
      exitCondition: { readPoint: { file: 'packages/backend/src/modules/task-execution/engine/wrapper/loopStrategy.ts', identifier: 'exitCondition' } },   // r3 勘正：domain/loopExitCondition.ts 只在注释里出现该名字
      outputBindings: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'outputBindings' } },
      continueOnMaxIterations: { readPoint: { file: 'packages/shared/src/loopPolicy.ts', identifier: 'continueOnMaxIterations' } },
    },
  },
  'agent-single': {
    fields: { agentRef: {…}, promptTemplate: {…} },   // PassthroughKeysOf<'agent-single'>
    fieldSources: { agentRef: { intentOnly: { resolvedIn: 'packages/backend/src/services/intent/resolveChangeset.ts' } }, promptTemplate: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'promptTemplate' } } },
    // `overrides` 不再出现：RFC-115 已删，零读点
  },
  input:  { fields: { inputKey: {…} }, fieldSources: { inputKey: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'inputKey' } } } },
  output: { fields: { ports: {…} },    fieldSources: { ports:    { readPoint: { file: 'packages/backend/src/modules/task-execution/domain/inboundEdges.ts', identifier: 'ports' } } } },
  'wrapper-git': { fields: { nodeIds: {…} }, fieldSources: { nodeIds: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'nodeIds' } } } },
  'code-round': { availability: { kind: 'synthesized-only' }, notes: [], mistakes: [] },   // 无 fields（`fields?: never`）
} satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }   // mapped type（§1.1，已编译验证）
```

> 示例条目不再逐条标注类型；**实际约束来自末尾的 mapped type**（strict kind 的 `fields` 类型 = `Omit<TeachingFieldsOf<Schema>, 基础键>`，
> 对象字段强制 `nested`；passthrough kind 的 `fields` / `fieldSources` 由 `PassthroughKeysOf<K>` 键控），实现以 §1.1 的类型定义为准。

- **有独立 schema 的 8 种 kind**：顶层与嵌套子表都以 schema 键键控——顶层或嵌套 schema 新增字段即编译红（D1c）。
- **5 种 passthrough kind**：字段以本文件的字面量 union 键控并带 `fieldSources`。测试用 **TypeScript AST**（根 devDependency
  `typescript ^5.7`，`ts.createSourceFile` + 节点遍历；注释天然不在 AST 里）：
  - 正向：`readPoint.file` 的 AST 中存在 `Identifier` / `StringLiteral` / `PropertyAccessExpression.name` 文本等于 `identifier`；
    `intentOnly` 的在 `resolveChangeset.ts` 存在同名标识符。
  - 反向：遍历 `workflow.validator.ts` 的 `CallExpression`，callee 为 `readString | readNumber | readStringArray | readBindings`
    时收集第二个实参**子树内所有** `StringLiteral`（条件表达式 `isCallWorkgroup ? 'goalTemplate' : 'promptTemplate'`，`:3159`，
    自然覆盖）；每个字面量必须属于：某个 kind（strict 或 passthrough）的 `fields`（含嵌套子表）键 ∪ `WORKFLOW_INPUT_TEACHING`
    的键 ∪ 显式 allowlist。**当前源码的完整初始集合与归属**（AST 扫描的预期基线，作为测试夹具常驻；r3 已由 Codex 对照
    `:830,876,1309,1566,1576,1721,1723,1881,1923,2052,2103,2291,2309,2310,2645,2888,2961,3054,3095,3159,3210` 全部核对）：
    `nodeIds`（wrapper-loop / wrapper-git / wrapper-fanout）、`ports`（output）、`maxIterations` / `outputBindings`（wrapper-loop）、
    `inputKey`（input）、`promptTemplate`（agent-single）、`goalTemplate` / `workgroupName`（call-workgroup）、`workflowName`
    （call-workflow）、`provider` / `action`（code-host-call）、`rerunnableOnReject` / `rerunnableOnIterate` / `commentInjectTemplate`
    （review）、`targetDir`（upload 输入教学）、**allowlist**：`agentName` / `agentId`（平台身份缓存字段；intent 侧以 `agentRef`
    表达，`intentChangeset.ts:collectIntentWorkflowAgentRefs` 拒绝模型写它们）。反向自检把一段含 `readNumber(node, 'zzzFake')`
    的样本源码喂给同一扫描器，必须报。裸读 `(node as Record<string, unknown>).x` 不在扫描语法内——记债，并在 dev-gotchas
    写明「validator 读 passthrough 字段一律走 `read*` helper」。
- **`availability` 与外部 SSOT 的一致性由测试锁**：`synthesized-only` ⇔ `isSynthesizedOnlyNodeKind(kind)`；
  `privileged.permission` 集合 ⇔ `privilegedNodeLensFor` 读的两个权限点；`redactedFields` 直接引用 shared 常量。
- `code-host-call` 的动作目录仍由 `renderCodeHostActionCatalog()` 派生，作为该条目 `notes` 的动态尾部（渲染时求值）。

### 1.3 资源类型注册表（`teaching/resourceTypes.ts`）与 workflow 部件表（`teaching/workflowParts.ts`）

```ts
// 键不再手写别名：每类的字段表类型 = ResourceFieldsOf<IntentPayloadSchemaOf[K]>（§1.1），嵌套 / 变体由 TeachingFieldsOf 递归派生

export const INTENT_RESOURCE_TEACHING = {
  agent: {
    fields: {
      name, description, outputs,
      bodyMd: { form: 'bodyMd', required: true, note: '`bodyMd` is the agent\'s full markdown body (its system prompt).', mistake: 'There is NO `systemPrompt`/`ports`/`outputPorts` field.' },
      outputKinds: { form: 'outputKinds:{port:kind}', required: false },
      branchPorts: { form: 'branchPorts:[port]', required: false, note: 'RFC-306 — subset of `outputs` … Omit it on an update to keep the stored value; send `[]` to clear.' },
      inputs: { form: 'inputs:[{name,kind,required?,description?}]', required: false,
        nested: {…} },
      skills: { form: "skills:[ref|{kind:'project',name}]", required: false,
        note: 'a `res#skill#n` handle / `$new:` tempRef for a managed skill, or `{kind:\'project\',name}` for a skill that lives in the repository',
        nested: { kind: {…}, name: {…} } },   // KeysOf 分配到 union 的对象 option（project），字符串 option 贡献 never
      permission: { form: 'permission:{key:action}', required: false, note: renderPermissionGrammar() },   // §1.7
      runtime: { form: 'runtime', required: false, note: 'a runtime profile NAME from inventory/runtimes.md — choose an ENABLED row; rows marked (disabled) are listed only so you can recognise an existing pin (creating or re-pointing an agent to one is rejected with `runtime-disabled`, `services/agent.ts:987-1009`). Omit to inherit the effective default named there.' },
      frontmatterExtra, syncOutputsOnIterate, role, outputWrapperPortNames, dependsOn, mcp, plugins,
    },   // 类型由 mapped type 派生
    notes: […], mistakes: [],
  },
  mcp: {   // 根是 discriminatedUnion ⇒ `fields` 直接是 IntentVariantTeaching<typeof IntentMcpPayloadSchema>（每个变体各自含 type/name/description/enabled/config）
    fields: {
      discriminator: 'type',
      variants: {
        local:  { type: {…}, name: {…}, description: {…}, enabled: {…},
                  config: { form: 'config', required: true, nested: { command: {…}, env: {…}, timeoutMs: {…} } } },
        remote: { type: {…}, name: {…}, description: {…}, enabled: {…},
                  config: { form: 'config', required: true, nested: { url: {…}, headers: {…}, timeoutMs: {…},
                    oauth: { form: "oauth:false|{clientId?,clientSecret?:'‹secret›',scope?,redirectUri?}", required: false, nested: { clientId: {…}, clientSecret: {…}, scope: {…}, redirectUri: {…} } } } } },   // r12：与 McpOAuthConfigSchema 同键
      },
    },
    notes: ['`oauth` (remote only): omit it on create to let the runtime auto-discover OAuth, set `false` to disable, or give `{clientId?,clientSecret?:\'‹secret›\',scope?,redirectUri?}` for an explicit client (`clientSecret` may be omitted when the client has none) — the confirm UI collects the real secret. On an update, omitting `oauth` keeps the stored configuration.'],   // 实现门 r1 #3 / r5 #2：与 IntentMcpOAuthConfigSchema 一致，clientSecret 可选
    mistakes: [],
  },
  plugin: { fields: { …, optionsJson: { form: 'optionsJson', required: false, mistake: 'the key is exactly `optionsJson`, never `options`' } } },
  workflow: { fields: { name, description, definition: { form: 'definition:{$schema_version,inputs,nodes,edges,outputs?}', required: true,
      nested: { $schema_version, inputs, nodes, edges, outputs } satisfies Record<KeysOf<typeof IntentWorkflowDefinitionSchema>, …> } } },
  workgroup: { fields: { …, members: { nested: { discriminator: 'memberType', variants: {
        agent: {…} satisfies Record<KeysOf<(typeof IntentWorkgroupMemberSchema.options)[0]>, …>,   // memberType | agentRef | displayName | roleDesc
        human: {…} satisfies Record<KeysOf<(typeof IntentWorkgroupMemberSchema.options)[1]>, …>,   // memberType | displayName | roleDesc
      } } satisfies IntentVariantTeaching<typeof IntentWorkgroupMemberSchema> }, switches: { nested: … } } satisfies TeachingFieldsOf<typeof IntentWorkgroupPayloadSchema> },
  skill: { fields: { name, description, bodyMd, frontmatterExtra,
      files: { form: 'files:[{path,content}]', required: false, nested: { path: {…}, content: {…} } } } },
} satisfies { readonly [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }   // mapped type（§1.1，已编译验证）
```

> 示例里保留的逐条 `satisfies` 仅为可读性；六类根表与全部嵌套 / 变体子表的实际约束由 mapped type 经 `ResourceFieldsOf` /
> `TeachingFieldsOf` 递归派生（§1.1 原文）。

`teaching/workflowParts.ts`——intent 侧 `definition.inputs[] / nodes[] / edges[] / outputs` 是 `unknown` / passthrough，教学与对账
**委托**到这里：

- `WORKFLOW_INPUT_TEACHING satisfies Record<WorkflowInputKind, { base; extra; extraSources }>`：`base` 以
  `KeysOf<typeof WorkflowInputSchema>`（kind / key / label / required / description）键控；`extra` 是每种 kind 的**扩展字段表**——
  `upload` 以 `Exclude<KeysOf<typeof UploadInputSchema>, KeysOf<typeof WorkflowInputSchema>>` 键控（有 strict schema）；其余四种
  kind 的扩展字段是 passthrough（r3 finding 1），以字面量键控并带 `extraSources`（与 §1.2 的 `fieldSources` 同形）：
  `text{multiline, maxLength}`、`files{minCount, maxCount, accept}`、`enum{choices, multiSelect, allowOther}`、`git{gitKind}`。
  读点（`readPoint`）取自 `packages/backend/src/services/workflowLaunchInputs.ts`（`numberField(def,'minCount'|'maxCount'|'maxLength')`、
  `stringField(def,'gitKind')`、`(def as Record<string, unknown>).multiSelect|choices|allowOther`）与下文固定清单里的前端文件
  （`multiline` / `accept` 只有前端读点）。
  **归属表**（r4 finding 2）：`INPUT_FIELD_OWNERSHIP satisfies Record<InputExtraField, { kinds: readonly WorkflowInputKind[]; authorable: boolean; why?: string }>`
  写死每个扩展字段属于哪些 kind——`multiline:[text]`、`maxLength:[text]`、`minCount:[files,upload]`、`maxCount:[files,upload]`、
  `accept:[files,upload]`、`choices:[enum]`、`multiSelect:[enum]`、`allowOther:[enum]`、`gitKind:[git]`、`targetDir:[upload]`、
  `maxFileSize:[upload]`、`onConflict:[upload]`（均 `authorable:true`），以及 r5 finding 3 补入的两个**派生字段**
  `presentation:[text]`、`agentKind:[text,upload]`（`authorable:false`：`packages/shared/src/agentLaunchForm.ts:34-42,95-130` 的
  `DerivedLaunchInput` 由平台在直接启动 agent 时合成——`agentKind` 同时进入 text 与 upload 派生输入——`DynamicInput.tsx:38,67`
  与 `components/webhooks/webhookAgentAuthoring.ts:17-18,56` 读取，不是工作流作者字段，**不教**但纳入归属与前端反向扫描）；
  前端反向扫描的文件清单是测试内的常量（r7 复核补齐）：**创作面** `components/canvas/inspector/InputEdit.tsx`（工作流作者在画布
  里编辑输入声明的唯一 UI，今日读 `targetDir / choices / onConflict / multiSelect / minCount / maxFileSize / maxCount / allowOther /
  accept`）+ **启动面** `components/launch/{DynamicInput,FilesPicker,EnumPicker,GitPicker,UploadPicker}.tsx`、
  `components/webhooks/webhookAgentAuthoring.ts`、`routes/tasks.new.tsx`、`lib/task-wizard.ts`（AST 收集这些文件里对输入声明形参
  的 `PropertyAccessExpression.name`，减去 `base` 五键）；每个文件必须至少命中一个字段、总集非空（空扫描 = 红），预期集合
  作为第三份基线常驻；测试三向：① 归属表里每个 `authorable` 的 `(field, kind)` 都出现在该 kind 的 `extra`，`authorable:false` 的
  不出现在任何教学表；② 每个 kind 的 `extra` 字段都在归属表里属于该 kind（从 `files.extra` 删掉 `minCount` 会红，即使 upload
  也有同名字段）；③ 后端与前端反向扫描得到的名字都在归属表里。反向扫描：AST 遍历 `workflowLaunchInputs.ts`，收集 `numberField | stringField` 调用第二实参
  子树的字符串字面量，以及 `(<expr> as Record<string, unknown>).<name>` 形态（`AsExpression` 被 `ParenthesizedExpression` 包裹后的
  `PropertyAccessExpression.name`）的属性名；**基线只含实际能扫出的七个 passthrough 名**
  `{minCount, maxCount, maxLength, gitKind, multiSelect, choices, allowOther}`（`key / required / kind` 是 typed 属性访问，
  由 `WorkflowInputSchema` 键控保证，不进扫描基线）；反向自检样本 `numberField(def, 'zzzFake')` 必须报。
- `WORKFLOW_PORT_REF_TEACHING satisfies Record<KeysOf<typeof PortRefSchema>, …>`：**唯一**的 PortRef 子表，review `inputSource`、边
  `source/target`、output `bind` 三处以引用复用（测试断言三处引用同一对象）。
- `WORKFLOW_EDGE_TEACHING satisfies Record<KeysOf<typeof WorkflowEdgeSchema>, …>`（`source/target` 引用 `WORKFLOW_PORT_REF_TEACHING`、`boundary`）。
- `WORKFLOW_OUTPUT_TEACHING satisfies Record<KeysOf<typeof WorkflowOutputBindingSchema>, …>`。
- `nodes[]` 引用 §1.2。边与 boundary 说明句逐字保留。

### 1.4 平台字段对账表（`teaching/reconciliation.ts`）

r3/r4 两轮证明「递归路径集合双向包含」在今日源码上对不齐：intent 用 handle / tempRef 表达平台的 id 字符串（`dependsOn[] / mcp[] /
plugins[] / skills[kind=managed].skillId / members[].agentId`），`$schema_version` 一侧是五个 literal 的联合、一侧是 number……这些
都是**叶子类型**差异，属于 resolve seam 的职责，不是「平台有字段而 intent 不教」的漂移。因此对账改为**只比键名、逐层比、
对象级覆盖棘轮**：

```ts
export interface ReconciliationEntry {
  id: string                                    // 'agent.root' | 'agent.inputs[]' | 'mcp.remote.config' | …
  resourceType: IntentResourceType
  /** 平台侧对象节点及其在 create schema 树中的路径；一条 entry 可认领多条同 schema 的路径（PortRefSchema 出现在
   *  edges[].source / edges[].target / outputs[].bind）；`paths: []` 表示树外的额外平台对象（UploadInputSchema、各 strict
   *  node kind schema——它们不在 CreateWorkflowSchema 的 zod 树里，只经 validator 生效） */
  platform: { paths: readonly string[]; schema: ZodObjectLike }
  /** intent 侧**键视图**，三选一，且同样带 `paths`（intent 树的对象路径；树外教学表为 `[]`）：
   *  - `{ paths, schema }`：一个 ZodObject（含 discriminatedUnion 某变体）；
   *  - `{ paths, table, select }`：一张教学表的键（`WORKFLOW_INPUT_TEACHING[kind]` 的视图固定为 `base ∪ extra`；
   *    `INTENT_NODE_TEACHING[kind]` 的视图 = 该 kind 的 `fields` 键 **减去** 已由 `workflow.nodes[]` 条目承接的三个通用引用键——
   *    `agentRef` 由该条目的 `renamed`（`agentId → agentRef`）承接，`workflowRef / workgroupRef` 由其 `intentOnly` 承接）；
   *  - `{ variants: Record<discriminatorValue, { paths, schema, renamed, excluded }> }`：平台单对象 ⇔ intent 多变体时逐变体映射。 */
  intent:
    | { paths: readonly string[]; schema: ZodObjectLike }
    | { paths: readonly string[]; table: 'INTENT_NODE_TEACHING' | 'WORKFLOW_INPUT_TEACHING' | 'WORKFLOW_EDGE_TEACHING' | 'WORKFLOW_OUTPUT_TEACHING' | 'WORKFLOW_PORT_REF_TEACHING'; select?: string }
    | { variants: Readonly<Record<string, { paths: readonly string[]; schema: ZodObjectLike; renamed: Readonly<Record<string, string>>; excluded: Readonly<Record<string, string>> }>> }
  renamed: Readonly<Record<string, string>>      // platform key → intent key
  excluded: Readonly<Record<string, string>>     // platform key → why（整棵子树随之排除）
  intentOnly: Readonly<Record<string, string>>   // intent key → why（整棵子树随之排除）
}
export const INTENT_PLATFORM_FIELD_RECONCILIATION: readonly ReconciliationEntry[] = [
  { id: 'agent.root',        platform: { paths: [''], schema: CreateAgentSchema }, intent: { paths: [''], schema: IntentAgentPayloadSchema }, renamed: {}, excluded: { network: 'RFC-276 tombstone (`z.never()`)' }, intentOnly: {} },
  { id: 'agent.inputs[]',    platform: { paths: ['inputs[]'], schema: AgentInputPortSchema }, intent: { paths: ['inputs[]'], schema: IntentAgentPayloadSchema.shape.inputs 元素 }, … },
  { id: 'agent.skills[project]', platform: { paths: ['skills[]<project>'], schema: AgentSkillRefSchema.options[1] }, intent: { paths: ['skills[]<project>'], schema: IntentProjectSkillSchema }, … },
  { id: 'plugin.root',       platform: { paths: [''], schema: CreatePluginSchema }, intent: { paths: [''], schema: IntentPluginPayloadSchema }, renamed: { options: 'optionsJson' }, … },
  { id: 'skill.root',        platform: { paths: [''], schema: CreateManagedSkillSchema }, intent: { paths: [''], schema: IntentSkillPayloadSchema }, intentOnly: { files: 'auxiliary skill files (RFC-234 T1)' }, … },
  { id: 'mcp.local.root',    platform: { paths: ['<local>'], schema: CreateMcpSchema.options[0] }, intent: { paths: ['<local>'], schema: IntentMcpPayloadSchema.options[0] }, … },
  { id: 'mcp.remote.root',   platform: { paths: ['<remote>'], schema: CreateMcpSchema.options[1] }, intent: { paths: ['<remote>'], schema: IntentMcpPayloadSchema.options[1] }, … },
  { id: 'mcp.local.config',  platform: { paths: ['<local>.config'], schema: McpLocalConfigSchema }, intent: { paths: ['<local>.config'], schema: 本地 config 变体 }, … },        // command / env / timeoutMs
  { id: 'mcp.remote.config', platform: { paths: ['<remote>.config'], schema: McpRemoteConfigSchema }, intent: { paths: ['<remote>.config'], schema: 远程 config 变体 }, renamed: {}, excluded: {}, intentOnly: {} },
  { id: 'mcp.remote.config.oauth', platform: { paths: ['<remote>.config.oauth'], schema: McpOAuthConfigSchema }, intent: { paths: ['<remote>.config.oauth'], schema: intent oauth 对象 option（`z.union([oauthObject, z.literal(false)])` 经 ObjectOptionsOf 取对象） }, renamed: {}, excluded: {}, intentOnly: {} },   // r12：oauth 可创作，不再排除
  { id: 'workflow.root',     platform: { paths: [''], schema: CreateWorkflowSchema }, intent: { paths: [''], schema: IntentWorkflowPayloadSchema }, … },
  { id: 'workflow.definition', platform: { paths: ['definition'], schema: WorkflowDefinitionSchema }, intent: { paths: ['definition'], schema: IntentWorkflowDefinitionSchema }, … },
  { id: 'workflow.inputs[]', platform: { paths: ['definition.inputs[]'], schema: WorkflowInputSchema }, intent: { paths: [], table: 'WORKFLOW_INPUT_TEACHING', select: 'base' }, … },
  { id: 'workflow.inputs[upload]', platform: { paths: [], schema: UploadInputSchema }, intent: { paths: [], table: 'WORKFLOW_INPUT_TEACHING', select: 'upload' }, … },   // 视图 = base ∪ extra
  { id: 'workflow.nodes[]',  platform: { paths: ['definition.nodes[]'], schema: WorkflowNodeSchema }, intent: { paths: ['definition.nodes[]'], schema: IntentWorkflowNodeSchema }, renamed: { agentId: 'agentRef' }, excluded: { position: 'taught in the common node sentence (every node may carry position/title); its XY object is an excluded subtree', title: 'same' }, intentOnly: { workflowRef: 'call-node precise binding (RFC-291 面 E)', workgroupRef: 'same' } },
  { id: 'workflow.nodes[<kind>]' × 8, platform: { paths: [], schema: 该 strict kind schema }, intent: { paths: [], table: 'INTENT_NODE_TEACHING', select: kind }, excluded: { id/kind/position/title/agentId: 'node base fields (see workflow.nodes[])' }, intentOnly: {} },   // 视图已剔除 agentRef/workflowRef/workgroupRef
  { id: 'workflow.portRef',  platform: { paths: ['definition.edges[].source', 'definition.edges[].target', 'definition.outputs[].bind'], schema: PortRefSchema }, intent: { paths: [], table: 'WORKFLOW_PORT_REF_TEACHING' }, … },   // review.inputSource / edge / output bind 三处子表都引用这一张
  { id: 'workflow.edges[]',  platform: { paths: ['definition.edges[]'], schema: WorkflowEdgeSchema }, intent: { paths: [], table: 'WORKFLOW_EDGE_TEACHING' }, … },
  { id: 'workflow.outputs[]', platform: { paths: ['definition.outputs[]'], schema: WorkflowOutputBindingSchema }, intent: { paths: [], table: 'WORKFLOW_OUTPUT_TEACHING' }, … },
  { id: 'workgroup.root',    platform: { paths: [''], schema: CreateWorkgroupSchema }, intent: { paths: [''], schema: IntentWorkgroupPayloadSchema }, … },
  { id: 'workgroup.members[]', platform: { paths: ['members[]'], schema: WorkgroupMemberInputSchema },
    intent: { variants: {
      agent: { paths: ['members[]<agent>'], schema: IntentWorkgroupMemberSchema.options[0], renamed: { agentId: 'agentRef' }, excluded: { userId: 'agent members carry no userId' } },
      human: { paths: ['members[]<human>'], schema: IntentWorkgroupMemberSchema.options[1], renamed: {}, excluded: { agentId: 'human members carry no agentId', userId: 'human members are placeholders in intent (never real usernames); resolved at apply' } },
    } }, renamed: {}, excluded: {}, intentOnly: {} },
  { id: 'workgroup.switches', platform: { paths: ['switches'], schema: WorkgroupSwitchesSchema }, intent: { paths: ['switches'], schema: IntentWorkgroupPayloadSchema.shape.switches }, … },
]
/** 平台树里既不由任何 entry 认领、也不落在某 entry `excluded` 子树内的对象节点，逐个带理由（r6：已被子树覆盖的节点**不得**重复列入；
 *  r12：`<remote>.config.oauth` 已由 entry 认领） */
export const RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS = {
  'agent.skills[]<managed>': 'intent expresses a managed skill as a bare handle string (IntentRefSchema); resolved to {kind:managed, skillId} at the resolve seam',
} as const
/** intent 树同理；今日为空（`skill.files[]` 已由 skill.root 的 intentOnly 子树覆盖；其字段教学由 §1.3 的 files 子表编译期保证） */
export const RECONCILIATION_UNCOVERED_INTENT_OBJECTS = {} as const
```

**清单规模**（r5 walk 基线，实现时作为夹具常驻；r12 因 oauth 可创作而 +1）：平台树对象节点 **24**（agent 4、skill 1、plugin 1、mcp 5、
workflow 10（含 `definition.nodes[].position` 的 `XYSchema`）、workgroup 3），intent 树对象节点 **18**（+ `<remote>.config.oauth`），
树外配对 **9**（upload + 8 strict kind），entry **29**（按上表展开，`workflow.nodes[<kind>]` 计 8 条）。

测试 `intent-teaching-reconciliation.test.ts`：

1. **逐层键比较**（每个 entry）：`keys(platform) ⊆ keys(intent) ∪ keys(renamed) ∪ keys(excluded)` 且
   `keys(intent) ⊆ keys(platform) ∪ values(renamed) ∪ keys(intentOnly)`。`keys()` 只取该对象一层的键（`ShapeOf` 剥离
   effects / optional / default），**不比叶子类型**——id vs handle、literal union vs number 等差异落在 resolve seam
   （`resolveChangeset.ts`）的既有测试里，不在本表。
2. **对象级覆盖棘轮**：遍历六个平台 create schema 的 zod 树（对象 → 子键；数组 → 元素；union / discriminatedUnion → 各 option；
   effects / optional / default / nullable → 剥离；`z.record` 与其他叶子不是对象节点），枚举全部对象节点路径；每条路径必须**恰好满足一种**：
   被恰一个 entry 的 `platform.paths` 覆盖 / 落在某 entry `excluded` 键的子树内 / 列在 `RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS`
   （重复认领同样红）。
   **今日的平台对象节点**（实现时以此为夹具基线）：agent `root / inputs[] / skills[]<managed> / skills[]<project>`
   （`permission / frontmatterExtra / outputKinds / outputWrapperPortNames` 是 record，`dependsOn / mcp / plugins` 是字符串数组，
   都不是对象节点）；skill `root`；plugin `root`（`options` 是 record）；mcp `local root / remote root / config<local> /
   config<remote> / config<remote>.oauth`；workflow `root / definition / definition.inputs[] / definition.nodes[] /
   definition.nodes[].position（XYSchema，落在 workflow.nodes[] 的 excluded 子树）/ definition.edges[] / definition.edges[].source /
   definition.edges[].target / definition.outputs[] / definition.outputs[].bind`；
   workgroup `root / members[] / switches`。树外额外平台对象（`paths: []`）不参与棘轮，但其键比较照常执行。
   intent 侧同样遍历六个 payload schema，对象节点必须被 entry 覆盖、落在 `intentOnly` 子树内或列在
   `RECONCILIATION_UNCOVERED_INTENT_OBJECTS`。平台新增一个嵌套对象（例如给 agent 加 `retryPolicy:{…}`）⇒ 父层多一个键（规则 1 红）
   且多一个未覆盖对象（规则 2 红）。
3. **反向自检**：给副本 schema 顶层 / 嵌套 / 变体各注入 `zzzFake` 键必须报；注入一个未登记嵌套对象必须报；把一个真实 entry
   去掉必须由规则 2 报。
4. **以 T1.2 落地后的 schema 为基准**（intent `branchPorts` 进 `IntentAgentPayloadSchema` 之前，`agent.root` 的规则 1 会因平台
   `branchPorts` 无对应键而红——这正是本 RFC 要修的漂移），全部 entry 与两张 uncovered 表**恰好**让测试绿（实现 T2.5 的退出门；
   AC-8 的「T1.2 之后为绿」）。r5～r7 设计门已对 24 + 17 个节点逐一 walk 确认归属。

### 1.5 平台能力地图（`teaching/platformMap.ts`）

```ts
export type IntentPlatformResourceTeaching =
  | { stance: 'intent-creatable' }
  | { stance: 'platform-only'; purpose: string; managedAt: { kind: 'route'; path: string } | { kind: 'api-only'; note: string } }
export const INTENT_PLATFORM_RESOURCE_MAP = {
  agent … workgroup: { stance: 'intent-creatable' },
  capability_template:  { stance: 'platform-only', purpose: 'code-capability template: the frozen stage sequence a code round runs', managedAt: { kind: 'api-only', note: 'no dedicated page; created by code missions (/code/missions) via /api/capability-templates' } },
  digital_employee:     { stance: 'platform-only', purpose: 'digital employee type configuration', managedAt: { kind: 'route', path: '/code/config/employees' } },
  action_template:      { stance: 'platform-only', purpose: 'digital-employee action template', managedAt: { kind: 'route', path: '/code/config/action-templates' } },
  verification_profile: { stance: 'platform-only', purpose: 'verification program profile applied to employee results', managedAt: { kind: 'route', path: '/code/config/verification-profiles' } },
  automation_policy:    { stance: 'platform-only', purpose: 'when and how digital employees act automatically', managedAt: { kind: 'route', path: '/code/policies' } },
  development_adapter:  { stance: 'platform-only', purpose: 'executor / development adapter connecting employees to code hosts and tooling', managedAt: { kind: 'route', path: '/digital-employees' } },
  employee_definition:  { stance: 'platform-only', purpose: 'digital-employee OS employee definition', managedAt: { kind: 'route', path: '/digital-employees' } },
  employee_tool:        { stance: 'platform-only', purpose: 'digital-employee OS tool registration', managedAt: { kind: 'route', path: '/digital-employees' } },
  employee_job_template:{ stance: 'platform-only', purpose: 'digital-employee OS job template', managedAt: { kind: 'route', path: '/digital-employees' } },
} satisfies Record<AclResourceType, IntentPlatformResourceTeaching>
```

`purpose` 文案在实现 T2 对照各 RFC proposal §1 逐条校对。测试：`stance==='intent-creatable'` 的键集合严格等于
`INTENT_RESOURCE_TYPES`（两向）；每个 `route` 型 `managedAt.path` 都能匹配前端路由表（读取 `packages/frontend/src/routes/*.tsx`
的 `path:` 声明，`/code/config/$kind` 以 `CONFIG_KINDS` 展开）；`api-only` 型 note 非空。

### 1.6 `LOOP_EXIT_CONDITION_KINDS` 下沉 shared（D1b）

`packages/shared/src/schemas/workflow.ts` 新增
`export const LOOP_EXIT_CONDITION_KINDS = ['port-empty','port-not-empty','port-equals','port-count-lt','port-inactive'] as const`
与 `LoopExitConditionKind`。消费者：`modules/task-execution/domain/loopExitCondition.ts`（`ExitCondition['kind']` 由常量派生，
`parseExitCondition` 的逐 variant 字段校验**保持**，只把 kind 判定改为查常量）、`modules/task-execution/public/queries.ts`
`isValidLoopExitCondition`（`workflow.validator.ts:855` 的合法性判定，不变）、`workflow.validator.ts:797-804`
`readExitConditionKind`（只服务 `:2006` 的 `port-inactive` 特例）、intent 教学、前端 `WrapperGitLoopEdit.tsx:163-168`
下拉改由常量 map 生成、`i18n/en-US.ts:6307` / `zh-CN.ts:12550` 帮助文案补 `port-inactive` 一句（组件测试断言五个选项）。

### 1.7 `OPENCODE_PERMISSION_{KEYS,ACTIONS,WILDCARD_KEY}` 下沉 shared（D5d）

`packages/shared/src/schemas/agent.ts` 紧邻 `AgentPermissionSchema` 新增 `OPENCODE_PERMISSION_ACTIONS = ['allow','deny','ask']`、
`OPENCODE_PERMISSION_KEYS`（从 `services/runtime/opencode/boundary.ts:152` 原样搬入）与 `OPENCODE_PERMISSION_WILDCARD_KEY = '*'`
（`boundary.ts:127-139` 把作者的 `'*'` 展开为全部已知键；`permissionMap.ts:103-126` 用 `'*'` 设 Claude 基线）；boundary 与
permissionMap 改 import；intent 教学 `renderPermissionGrammar()` 派生：
`Keys: '*' (baseline for every key) or one of <keys>; each value is 'allow' | 'deny' | 'ask' or a {pattern: action} map. In headless runs 'ask' is treated as 'deny'; unknown keys grant nothing.`

## 2. INTENT.md 渲染器与文档结构

`teaching/render.ts` 导出纯函数：

- `renderPlatformModel()` → 「## Platform model (essentials)」：资源类型句由 `INTENT_RESOURCE_TYPES` 派生
  （"Resource types you may create or update (6): agent, skill, …"），节点 kind 概览由 `INTENT_NODE_TEACHING` 过滤
  `availability` 后派生（privileged 的 `overviewLabel` 只在持权时出现——与现有 `privilegedOverview` 语义一致）。
- `renderPlatformCapabilityMap()` → 「## Platform capability map (exists, but not yours to create)」：九类逐行
  `- capability_template — <purpose>. <Managed at /path | No dedicated page; …>. Cannot be created, updated, mounted or referenced in a changeset; if the user needs one, say where to configure it and offer what you CAN build.`
- `renderRequestedArtifactType(type | null)` → 「## Requested artifact type」（§3 文案，D33 语义）。
- `renderCapabilityLimits(privileges)` → 现「## Capability limits (hard)」，per-kind 行改由 privileged 条目派生，句子逐字保留。
- `renderPayloadSchemas(privileges)` → 现「## Payload schemas (STRICT …)」：Common rules 与 webhook 段逐字保留；
  `- **<type>**:` 六行由 §1.3 渲染（字段旁 `mistake` 渲染在同一行）；「Supported node forms」由 §1.2 渲染（`synthesized-only`
  渲染为现有 NOT AVAILABLE 句；`privileged` 未持权时不渲染形态）；`inputs[]`（五种 kind 的 `base + extra`）/ 边 / outputs 由
  `workflowParts` 渲染；worked example / JSON closure check 逐字保留。
- `renderWorkingDirectoryLayout()` / `renderOutputContract(langDirective)` → 工作目录布局段与「## Output contract」（实现门 r4 #1：op / question / mount-request 的字段名以 `KeysOf<typeof IntentOpSchema | IntentQuestionSchema | IntentMountRequestSchema>` 键控，`INTENT_ENVELOPE_PORTS` 四端口常量；`intentDoc.ts` 由源码级测试锁为零 kind / 类型 / 字段 / 清单文件名字面量）。
- `renderReferenceRules()` → 「## Reference rules (hard)」（实现门 r1 #4：句子逐字保留，call 节点的 kind 与 `workflowName|workgroupName` /
  `workflowRef|workgroupRef` / `workflowId|workgroupId` 经 `CALL_SELECTORS satisfies {… keyof (typeof INTENT_NODE_TEACHING)['call-workflow']['fields'] …}`
  类型化查表，`intentDoc.ts` 内不再出现任何 kind / 字段字面量）。
- `renderOutputDeclarations()` → workflow 段末尾的根级 `outputs:[{name,bind:{nodeId,portName}}]` 句（实现门 r3 #1，从 `WORKFLOW_OUTPUT_TEACHING` 派生）。
- `renderCommonMistakes()` → 「## Common mistakes (hard)」（实现按此标题落地；只收各条目的跨字段 `mistakes`）：只收集各条目的**跨字段** `mistakes`
  （`never nest an \`ops\` array inside an op`、JSON 闭合、redaction 省略规则等）。字段旁反例（`optionsJson` / `systemPrompt`）
  **不**在此出现，测试以「与所属字段同行」断言。

`services/intent/intentDoc.ts` 保留 `buildIntentDoc(input)` 签名，`IntentDocInput` 新增
`requestedArtifactType: IntentResourceType | null`；节顺序：

1. `# Intent session` + 工作目录布局（新增一行 `inventory/runtimes.md`）
2. Platform model → Platform capability map → Requested artifact type
3. Reference rules (hard) → Secrets (hard) → Capability limits (hard)（条件）
4. Single-turn delivery budget
5. Payload schemas
6. Common mistakes
7. Output contract（含 langDirective）
8. Conversation history → Pending questions → Current draft → BLOCKING validation errors → Access notes

契约面：`rfc234-intent-doc.test.ts` 149 处、`intent-doc-validator-contract.test.ts` 51 处、
`intent-privileged-node-capability.test.ts` 9 处、`rfc291-unavailable-mount.test.ts` 9 处（四文件 218 条 `toContain/toMatch`），
加 `docs-node-kind-coverage.test.ts` 4 处（五文件 222 条；其 `:131-132` 锁 `- **${type}**:` bullet）；另
`rfc234-intent-doc.test.ts:634-638` 锁「无孤立 `-` 行 / 不出现四连换行 / 文末单换行」。锁住的句子**全部逐字迁入**注册表条目或
渲染器常量；实现 T3 完成后这五个文件不改断言即须绿（AC-9）。

## 3. 请求的资源类型（hint）数据流

```
Composer(hint∈六类|auto) ──POST /api/intent-sessions {hint?}──► CreateIntentSessionSchema.hint: z.enum(INTENT_RESOURCE_TYPES).optional()
   └► session.ts createIntentSession：首轮 user turn contentJson = {message, hint?}（现状不变，durable、不可变）
turnEngine.fireTurn（每轮）：allTurns 已加载（按 seq）→ firstUserTurn = 首个 role='user' & kind='message'
   → requestedArtifactType = z.enum(INTENT_RESOURCE_TYPES).safeParse(parse(contentJson).hint)   // 接受 unknown：存量自由文本 / 非字符串 ⇒ null
                              .success ? data : null
   → buildIntentDoc({ …, requestedArtifactType })
```

- 不加列、不迁移（D4）。收窄用 `z.enum(INTENT_RESOURCE_TYPES).safeParse(unknown)`——`asIntentResourceType` 只接受已是
  `AclResourceType` 的值（`resourceAcl.ts:132-135`），对历史自由文本不可用。`turnDisplayText` 仍只返回 `message`（历史区不重复 hint）。
- 文案（渲染器常量，与 RFC-235 D33 对齐）：
  - 有值：`The user pre-selected **<type>** in the composer. Prefer it when the goal fits: make a <type> the primary resource and add supporting resources it needs. If the user's message — on any turn — explicitly asks for a different kind, follow the message; do not ask for confirmation just because it differs from the pre-selection.`
  - 无值：`No type requested (Auto): choose the resource mix yourself from the goal.`
- 校验：`hint` 非枚举 ⇒ 现有 zod 422 路径；e2e / 前端不受影响（只发六类）。

## 4. dump 侧变化

- **agent 顶层 `branchPorts`**：`dumpBuilder.ts` agent 分支把 `agent.branchPorts` 交给 `serializeAgentMarkdown`
  （`agent-md-serialize.ts:35,95` 已支持，首类字段优先于 `frontmatterExtra` 同名键）。
- **`inventory/runtimes.md`（D5b）**：`buildIntentDump` 新增输入 `effectiveDefaultRuntime?: {name, protocol}`；runtime 行由 dump 内部
  `listRuntimes(db)` 读取（无 effective default 输入时回退 `resolveRuntimeByName(db, null)`）。**传递路径**（r3 finding 5，实现门 r1 勘正）：
  `resolveIntentTurnConfig(db, cfg)` 已经拿到 `cfg.defaultRuntime`（`turnEngine.ts:889-908`），在其中调用 agent 启动同一语义的
  `resolveAgentRuntime(db, null, cfg.defaultRuntime)`（`runtimeRegistry.ts:472-480` → `resolveRuntimeByName`：有行取行；内建名无行取内建；
  未知名回退 opencode）并把 `{name, protocol}` 放进 `IntentTurnConfig.effectiveDefaultRuntime`（与 Intent Builder 自己用的 `runtime` 字段并列）；
  `dispatcher.ts:82-83` 原样把 config 传给 `runIntentTurn`，无需改动调用形状；`runIntentTurn` 再注入 dump。渲染：
  `# runtimes (N)\nEffective default: <name> (<protocol>)\n- <name> — protocol <protocol>[ (default)][ (disabled)]…`；
  默认名若无 profile 行，追加一行 `- <name> — protocol <protocol> (built-in, no profile row) (default)`；不含 binaryPath /
  configDir / extraArgs。`(default)` 标记恰出现一次（AC-6）。文件头固定一句
  `Choose an enabled row for a new or re-pointed agent; (disabled) rows are listed only so you can recognise an existing pin.`
  （与 `validateRuntimeReference` 的 `runtime-disabled` 规则一致，`services/agent.ts:987-1009`；锁文本）。
- **agent 行端口名（D5c）**：投影在 `buildIntentDump` **内部**执行——它拥有可见 catalog 与排序、截断后的 `kept` agent id
  （`dumpBuilder.ts:728-756`）；默认投影 `loadAgentPortsFromDb` 就在 `dumpBuilder.ts` 内（一次 `select id, inputs, outputs from agents where id in (…)`，
  `db/schema.ts:32,36` 两列，≤ `INTENT_INVENTORY_CAP` 个 id），`IntentDumpInput.loadAgentPorts?: (ids) => Promise<Map<id, {inputs, outputs}>>`
  为可注入 seam（测试 spy 锁「恰一次、只收截断后 id、空端口行渲染 `inputs:[] outputs:[]`」；实现门 r1/r2 勘正：无独立 `agentPortsProjection.ts`，`turnEngine` 不注入）。`ResourceSummary`（RFC-345 合同）**不扩字段**。行渲染为
  `- res#agent#3 \`auditor\` — <description first line> · inputs:[diff] outputs:[findings,summary]`。
- **remote MCP 的 `oauth` 投影（r12）**：`projectMcpForDump`（`intentSecretSlots.ts:106-117`）今日把 `oauth` 整体投影为 ‹redacted›；改为
  `false` 原样、对象 → `{clientId, clientSecret: ‹redacted›, scope, redirectUri}`（只有 `clientSecret` 脱敏），让模型能回显并按需改动。
- **九类 platform-only 的只读清单（D3 ★）**：新 `services/intent/platformInventory.ts` 导出
  `PLATFORM_ONLY_INVENTORY_LOADERS satisfies Record<PlatformOnlyResourceType, (ctx: PlatformInventoryContext) => Promise<PlatformInventoryRow[]>>`
  （实现门 r5 #3 勘正：`PlatformInventoryContext = { db, actor, employeeReads: IntentEmployeeAuthoringReads, employeeToolCatalog }`，由
  `createDefaultIntentPlatformInventory(db, overrides?)` 组装成 `IntentPlatformInventory { listRows(type, actor) }` 端口）
  （`PlatformOnlyResourceType = Exclude<AclResourceType, IntentResourceType>`，与 `INTENT_PLATFORM_RESOURCE_MAP` 的 `platform-only`
  键集合以类型相等断言互锁）；每个加载器 = 该类型既有行加载 + resource-catalog 公共 `filterVisibleRows(db, actor, type, rows)`
  （`modules/resource-catalog/public/operations.ts:41`），与各自 REST 列表判据一致：capability_template ← `listTemplateRows`
  （`routes/capabilityTemplates.ts:113` 同源）；action_template / verification_profile ← dev-automation `templateStore.list()` /
  `profileStore.list()`（`configOperations.ts:138,222` 同源）；digital_employee ← `listDigitalEmployees`；automation_policy ←
  `listAutomationPolicies`；development_adapter ← integration adapter store `list()`（`developmentAdapterConfigOperations.ts:67-68`
  同源）；employee_definition ← digital-employee 模块 employees 列表（`routes/digitalEmployees.ts:101-107` 同源）；employee_tool /
  employee_job_template ← 按 `listTypePackages()` 迭代各 type 的 `listTools` / `listJobTemplates`（employee_tool 另合并
  `composeDigitalEmployeeBuiltinToolCatalog` 的平台内建工具，DB 注册项同 id 优先）。注入链：`RunIntentTurnDeps.platformInventory?` →
  `IntentDumpInput.platformInventory?`，缺省为 `createDefaultIntentPlatformInventory(db)`；`buildIntentDump` 生成 `inventory/platform/<type>.md`：
  `# <type> (N visible; read-only — cannot be referenced)` + `- <name> — <description first line>`，每类 ≤ 200 行、截断标注；
  这些行**不进 manifest、不发 handle**。不动 RFC-345 的 `ResourceSummary` / selector；加载器表记为待 RFC-345 落地后折入 catalog 的债。
- **表驱动**（D7 可跳过档）：`dumpBuilder.ts` 的 detail loader 选择（`:281-289`、`:425-433`）、inventory 列表（`:467-474`）、
  `summarizeInventoryRow`（`:812-826`）改为一张 `satisfies Record<IntentResourceType, { rows(catalog); loadDetail; fence }>`
  表；`manifest.ts` 的 `IntentFence` union 与 `buildXFence` 保持，`fenceEquals` 不变。行为逐字节不变。

## 5. changeset schema 与 apply seam 变化

- `IntentAgentPayloadSchema` 增 `branchPorts: AgentBranchPortsSchema.optional()`；`resolveChangeset.ts` agent case 增
  `...(p.branchPorts === undefined ? {} : { branchPorts: p.branchPorts })`；create 走 `prepareAgentCreate`
  （`assertBranchPortsDeclared` 校验 ⊆ outputs，错误映射为现有 draft 校验错误）。
- **update presence-aware（D5，修 bug）**：`applyChangeset.ts` agent update 在 `UpdateAgentSchema.parse(patchBody)` 前，
  若 `patchBody.branchPorts === undefined` 且 `existing.branchPorts !== undefined` 则填入 `existing.branchPorts`
  （`getAgentById` 已读出顶层值），使 `prepareAgentUpdate` 的「显式 `frontmatterExtra` ⇒ 跳过 sidecar 保留」路径
  （`services/agent.ts:496-498`）在 `:538-545` 重新写回；`branchPorts: []` 按同段清除。`prepareAgentUpdate` 本身不动。
- **sidecar 三项 presence-aware（r12，用户另裁 ①）**：同一 seam 对 `outputKinds / role / outputWrapperPortNames` 做同样的
  「省略 ⇒ 从 `existing` 回填」；清除语义 `outputKinds: {}` / `role: 'normal'` / `outputWrapperPortNames: {}` 按 `services/agent.ts:524-537`
  既有分支生效。
- **remote MCP `oauth`（r12，用户另裁 ②）**：`IntentMcpPayloadSchema` remote 变体 `config` 增
  `oauth: z.union([z.object({clientId?, clientSecret?, scope?, redirectUri?}).strict(), z.literal(false)]).optional()`；
  `findNonSentinelSecretCarriers` 增 `/payload/config/oauth/clientSecret`（非 `''` / 非哨兵即 `intent-secret-value-forbidden`）；
  `deriveIntentSlots` 为哨兵发 `secret` 槽（pointer `/config/oauth/clientSecret`）；resolve 的 mcp case 按 pointer 回填；
  `applyChangeset.ts:646-653` 的「update 省略 oauth 则沿用既有」保留，显式 `false` / 对象则覆盖。
- `IntentWorkflowNodeSchema` 保持 passthrough（`continueOnMaxIterations` / `port-inactive` / `branch` 只需教学）。
- `CreateIntentSessionSchema.hint` 枚举化（§3）。

## 6. 前端派生（D6，六处）

- `IntentCreateComposer.tsx`：删除本地 `ArtifactHint` union；`type ArtifactHint = IntentResourceType`；图标表
  `RESOURCE_TYPE_ICONS satisfies Record<IntentResourceType, ReactNode>` + `RESOURCE_TYPE_LABELS satisfies Record<IntentResourceType, (t) => string>`，options = `[auto, ...INTENT_RESOURCE_TYPES.map(…)]`。
- `IntentMountDialog.tsx`：`MOUNT_TYPES = INTENT_RESOURCE_TYPES`。
- `IntentOpPreview.tsx`：`OP_PREVIEW_RENDERERS satisfies Record<IntentResourceType, (input) => ReactElement | null>`（mcp / plugin 显式 `() => null`，保持此前只展示 raw JSON 的行为）。
- `IntentEntryButton.tsx:16-19`、`IntentProvenanceBadge.tsx:17`：props 类型改 `IntentResourceType`。
- `routes/intent.tsx:27-36,76-78`：`IntentArtifactHint = IntentResourceType`，`ARTIFACT_TYPES = INTENT_RESOURCE_TYPES`。
- i18n：`intent.resourceType.*` 六键不变；新增类型时由 `satisfies` 表逼加键，缺键由既有 i18n 覆盖测试抓。
- 源码文本锁：上述六个文件与 `services/intent/**` 不得再出现「六个类型字面量以 `,` 或 `|` 相连（任意顺序）」的序列
  （白名单 `resourceAcl.ts`）；反向自检样本用 `|` union。

## 7. 与 RFC-345 的并发规避（D7）

RFC-345 `plan.md` §4 预计范围含 `services/intent/**`（named consumer）、`intent/dumpBuilder.ts`、
`services/intent/resourceCatalog.ts`（legacy compatibility）与 `modules/task-execution/**`。分档：

| 档 | 文件 | 规则 |
| --- | --- | --- |
| 必做、需协调 | `resolveChangeset.ts`（branchPorts 透传）、`applyChangeset.ts`（presence-aware） | 实现前 `git status --porcelain -- <file>` + `git log --since` 核对；有他人未提交改动 ⇒ 停下问用户协调；未落地不得标 Done |
| 必做、低冲突 | `intentDoc.ts`、`turnEngine.ts`、`dispatcher.ts`、`session.ts`、`dumpBuilder.ts`（branchPorts / runtimes / 端口行 / 九类只读清单 / oauth 投影 / `agentBranchPorts`）、新 `platformInventory.ts` | 同上核对；改动集中在渲染 / 注入区，与 RFC-345 的 ACL/catalog import 区不重叠，可合并；`platformInventory.ts` 只 import resource-catalog **public** 的 `filterVisibleRows` 与各类型既有加载函数 |
| 可跳过 | `dumpBuilder.ts` / `manifest.ts` 表驱动、两处 `never` 守卫 | 撞上在制品即跳过并记债 |
| 无重叠 | shared、`modules/intent/domain/teaching/**`、前端、`loopExitCondition.ts` / `queries.ts` 常量消费、`boundary.ts` / `permissionMap.ts` import、新测试文件 | 可先行 |

## 8. 失败模式

| 场景 | 处理 |
| --- | --- |
| 首轮 turn `contentJson` 解析失败 / hint 非枚举（存量） | `requestedArtifactType=null`，渲染 Auto 句，不报错 |
| `listRuntimes` / `resolveRuntimeByName` / agent 端口投影查询抛错 | 与现有 dump 其他查询同级：整轮失败并记 durable error turn（不吞） |
| 注册表 `fields` 与 schema 不一致（顶层 / 嵌套 / 变体 / 新增变体） | 编译失败（strict-schema kind）或 `intent-teaching-registry.test.ts` 红（passthrough kind / input kind） |
| validator 经 `read*` helper 新读一个未登记字段；launch 经 `numberField/stringField/as-cast` 新读一个未登记 input 字段 | AST 反向扫描红 |
| 平台 create schema（含嵌套 / 变体 / 委托部件）新增字段未登记 | `intent-teaching-reconciliation.test.ts` 红 |
| 新增 ACL 类型未声明立场 / `managedAt` 路径不存在 | 编译失败于 `platformMap.ts` / 路由对照测试红 |
| `INTENT.md` 超过 32 KB | 既有尺寸守卫红 |
| 模型仍输出 `overrides` | passthrough，validator 忽略，行为同今日 |
| 模型省略 `branchPorts` 更新 agent | 保留既有值（修复前：清空） |
| 模型对 platform-only 类型发 `requests` / op | 六类枚举的现有拒绝路径（platform-only 行只读，无 handle） |
| 模型给 remote mcp `oauth.clientSecret` 写字面量 | 与 header 值同一条闭合载体路径：`intent-secret-value-forbidden`（r12 P3：沿用既有诊断名，不新增 `intent-secret-value-forbidden`） |
| 模型 update 时显式给 `oauth:false` / 对象 | apply 以 payload 为准替换（r12 P1#1：仅 `oauth === undefined` 时沿用旧值） |

## 9. 测试策略（必写）

| 文件 | 覆盖 |
| --- | --- |
| `tests/intent-teaching-registry.test.ts`（新） | 每个非 synthesized kind：渲染形态含每个非 omit 字段名（含嵌套 / 变体子表字段）、不含 omit 字段名、不含 `??`；`availability` ⇔ `isSynthesizedOnlyNodeKind`；privileged 权限点集合 = `privilegedNodeLensFor` 读点；passthrough 字段与 input 扩展字段的 `readPoint` AST 正向 + validator / launch / 前端 AST 反向扫描（含条件字面量与 as-cast 属性）+ **三份**初始集合基线（validator 15 名、launch 7 名、前端集合）+ 每文件 ≥1 命中与总集非空 + 反向自检样本；clarify notes 含全部端口常量；资源类型每个字段名（含 agent `skills` project 子表、skill `files` 子表）出现在该类型行；runtime 教学句含 `ENABLED` 与 `runtime-disabled`；`WORKFLOW_PORT_REF_TEACHING` 三处引用同一对象；字段旁 `mistake` 与该字段同行且**不**出现在 Common mistakes、跨字段 `mistakes` 出现在 Common mistakes 节；mcp 行含 `oauth` 创作句（omit = 自动发现 / `false` = 禁用 / 对象 = 显式客户端，update 省略即保留）；platform map 互补 + `route` 路径对照前端路由表；`LOOP_EXIT_CONDITION_KINDS` 每项出现在 wrapper-loop 形态；permission 语法句含全部 actions 与 `'*'` |
| `tests/intent-teaching-reconciliation.test.ts`（新） | §1.4 规则 1（每条 entry 一层键名两向包含，含 `variants` 逐变体、教学表键视图）+ 规则 2（平台 24 / intent 18 个对象节点各被恰一条 entry、`excluded` / `intentOnly` 子树或 uncovered 表认领；基线常驻）+ 规则 3 反向自检（副本 schema 顶层 / 嵌套 / 变体各注入 `zzzFake` 键、注入未登记嵌套对象、删掉一条真实 entry 各必须报） |
| `tests/intent-teaching-exhaustive.test.ts`（新，普通测试文件，随 tsconfig 进 `tsc --noEmit`；先例 `rfc148-adt-contracts.test.ts:30-46`） | 常驻 `// @ts-expect-error — <说明>` **八个**，**一律写成声明**（`const _missingKind = {…} satisfies {…mapped type…}` / `const _bad: … = {…}`），并在同一 `test()` 里以 `expect([_a, _b, …].length).toBe(8)` 引用——`tseslint.configs.recommended` 的 `@typescript-eslint/no-unused-expressions: error`（`eslint.config.js:59`）会拒绝裸 `satisfies` 表达式语句，`_` 前缀满足 `varsIgnorePattern`（`eslint.config.js:73`）：缺 kind / 缺 IntentResourceType / 缺 AclResourceType 的注册表字面量；`ReviewNodeSchema.extend({zzz})` 后旧 fields 表不满足 `TeachingFieldsOf<…>`（顶层扩字段）；`ScriptOutputPortSchema.extend({zzz})` 后旧子表不满足（嵌套扩字段）；`IntentWorkgroupMemberSchema` agent 变体扩字段后旧变体子表不满足（variant-only）；给 `IntentMcpPayloadSchema` 追加第三个 option 后旧 `variants` 表不满足（新增变体）；`ReviewNodeSchema.extend({policy: z.object({mode: z.string()})})` 后只登记 `policy:{form,required}` 而无 `nested` 的表不满足 `TeachingFieldsOf<…>`（新增对象字段只登记父字段） |
| `tests/rfc234-intent-doc.test.ts`（扩） | AC-1/2/3/5/11：`branchPorts` / `continueOnMaxIterations` / `port-inactive` / `branch` / `permission` / mcp `timeoutMs` 正断言，`overrides` 负断言；Requested artifact type 三态 + 「follow the message」句锁；Platform capability map 九类；尺寸守卫保留；五种 input kind 的扩展字段全部出现 |
| `tests/rfc234-turn-engine.test.ts`（扩） | 首轮 hint → 第 1 轮与第 2 轮 doc；存量自由文本 hint 忽略；`inventory/runtimes.md`（≥2 profile、header 的 effective default 与 `resolveRuntimeByName` 一致、默认名无行时合成行、Intent Builder runtime ≠ 全局默认、disabled 标记、不含 binaryPath、`(default)` 恰一次）；`inventory/agents.md` 行含端口名（截断后的 id 集合恰被投影一次） |
| `tests/rfc234-intent-routes.test.ts`（扩） | `hint` 枚举：六类 201，`'foo'` 422 |
| `tests/intent-agent-branch-ports.test.ts`（新） | AC-4 + AC-18：create 落库；省略保留（`branchPorts` 与三个 sidecar）；`[]` / `{}` / `'normal'` 清除；`⊄ outputs` draft 报错；挂载后下一轮 dump 顶层 `branchPorts`（`rfc234-dump-builder.test.ts` 同批加带 `branchPorts` 夹具） |
| `tests/intent-mcp-oauth.test.ts`（新） | AC-17：`clientSecret` 槽发出与回填、非哨兵字面量拒绝、`oauth:false` 落库、update 省略沿用、dump 投影只脱敏 `clientSecret` |
| `tests/intent-platform-inventory.test.ts`（新） | AC-16：九个文件、两 actor 可见性对照（与各 REST 列表同判据）、无 handle、截断标注、`PLATFORM_ONLY_INVENTORY_LOADERS` 键集合 = 能力地图 platform-only 键集合（类型相等 + 运行期断言）、九类 op / requests 仍被六类枚举拒绝 |
| `tests/docs-node-kind-coverage.test.ts` | 不改（继续兜底） |
| `tests/architecture/rfc294-review-module-layer-rules.test.ts` | 不改；新 domain 文件必须零违规 |
| shared `tests/rfc348-loop-exit-condition-kinds.test.ts` + backend `tests/rfc348-loop-exit-kind-roster.test.ts`（新） | 常量与 `parseExitCondition` / `isValidLoopExitCondition` 一致（双向编译锁 `_exitKindRosterLock`）；`port-inactive` 被接受 |
| shared / backend 既有 `boundary` / `permissionMap` 测试 | import 改动后不改断言即绿；`'*'` 语义测试仍绿 |
| frontend `tests/intent-list-inline.test.tsx`（扩）、`intent-op-preview.test.tsx`（扩）、新 `intent-roster-derivation.test.tsx` | 选项数 = 6 + 1；mount dialog 类型集 = roster；op preview 六类各有 renderer；`/intent?hint=…` 解析以 roster 夹具覆盖；entry button / provenance badge 接受 roster 全部值 |
| frontend `tests/rfc348-exit-kind-roster-consumers.test.ts`（新，源码级锁） | 下拉由 `LOOP_EXIT_CONDITION_KINDS.map(` 生成且无手写 kind 列表；两处帮助文案含全部 roster kind |
| 源码文本锁（`intent-teaching-registry.test.ts`） | §6 的六类字面量序列扫描（正向 + 反向样本） |

AC-7 由八个常驻 `@ts-expect-error` 夹具覆盖；实现报告的红屏证据按 §T7 的程序取得，两种诊断要分清：**去掉指令**暴露的是
被压制的底层类型错误（如 TS2741 缺属性）；**让表达式合法而保留指令**（例如临时把缺的键补上）得到的是 TS2578「未使用的
@ts-expect-error」——两者都证明夹具在起作用，报告各截一次，然后恢复并再截一次绿。

## 10. 偏离项与债（呈用户确认）

1. **5 种 passthrough kind 与 4 种 passthrough input kind 的字段只有测试级保护**：为它们建 typed schema 属于 workflow 合同
   （validator / launch / inspector / runtime 多方消费者），超出本 RFC；本 RFC 用 `readPoint` AST 正向 + helper / as-cast AST 反向
   扫描兜底，其他裸读形式不在扫描内。实现勘误：`wrapper-loop.exitCondition` 的读点登记为
   `modules/task-execution/engine/wrapper/loopStrategy.ts`（`record.exitCondition`）——`domain/loopExitCondition.ts` 只在注释里
   出现该名字，AST 扫描（注释不在 AST 内）会正确地拒绝它。
2. **`turnEngine` / `dumpBuilder` 仍在 `services/`**：intent application/engine 层由 RFC-294 后续波次授权，本 RFC 只抽纯域；
   不建半截 application。
3. **platform-only 九类的真实行（D3，用户另裁③）由 `services/intent/platformInventory.ts` 直接组装**：capability_template 走
   `services/capabilityTemplates`；其余八类直接调用各模块自己的 store / composition 工厂（`development-automation` 的
   `sqliteDigitalEmployeeStore` / `sqliteConfigResourceStore`、`integration` 的 `sqliteDevelopmentAdapterStore`、`digital-employee`
   的 `sqliteAuthoringStore`，employee_tool 另加 `task-execution/composition/digitalEmployeeBuiltinToolCatalog` 取平台内建工具，
   与 `server.ts` 同一组装），再经 resource-catalog public 的 `filterVisibleRows` 过滤。这是 RFC-294 意义上的**跨模块
   infrastructure 引用（债）**：正解是 bootstrap 用组合好的模块 query port 实现 `IntentPlatformInventory` 并经
   `IntentDispatchDeps → RunIntentTurnDeps → IntentDumpInput` 注入（端口已就位、注入链已留 `platformInventory?` seam）；
   之所以本 RFC 不落这一步，是 `server.ts` / `routes/intentSessions.ts` / `services/intent/dispatcher.ts` 三个文件此刻承载着
   RFC-347 并行 session 的未提交半截重构（`identityAccess` 接线），本 RFC 不得把他人的中间态一并推上 main。RFC-347 落地后
   把默认实现换成 bootstrap 注入、删除本文件里对 infrastructure 的直接引用，记为 RFC-348 后续单独一提。
4. **`resolveChangeset` / `applyChangeset` 的 `switch` 只加穷尽守卫**（D7；实现门 r3 落地：`resolveIntentBundle` 的 payload switch 与
   `applyInner` 的 create / update 两个 switch 各加 `default: { const _exhaustive: never = op; throw … }`），表驱动重构等 RFC-345 T4b/T7 收口。
5. ~~`outputKinds / role / outputWrapperPortNames` 的省略语义不动~~ → **用户另裁①：三者与 `branchPorts` 一致改为「省略即保留」**，
   在 apply seam（`applyChangeset.ts` agent update 分支）从现有行回填缺失 sidecar；显式 `[]` / `{}` / `'normal'` / `{}` 仍清除
   （`tests/intent-agent-branch-ports.test.ts`）。
6. ~~mcp remote `oauth` 不可由意图创作~~ → **用户另裁②：可创作**（D2）：`IntentMcpOAuthSchema = object | false`、
   `clientSecret` 闭合载体 + confirm 槽、dump 只脱敏 `clientSecret`、update 省略即沿用、显式值替换（r12 P1#1）；对账表新增
   `mcp.remote.config.oauth` entry（`tests/intent-mcp-oauth.test.ts`）。
7. **`hint` 的历史自由文本**：`z.enum(INTENT_RESOURCE_TYPES).safeParse` 失败即视为「未选择」，不迁移不报错。
8. 不涉及任何安全类改动；本设计不含安全检视项。
