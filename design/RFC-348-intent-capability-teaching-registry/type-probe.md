# RFC-348 类型探针（设计门 r9～r11 附件；**历史记录**）

> r12 勘误：本探针是 r9～r11 的编译证据，**不再是实现蓝本**——活的蓝本是 `packages/backend/src/modules/intent/domain/teaching/types.ts`
> 与 `packages/backend/tests/intent-teaching-exhaustive.test.ts`（八个 `@ts-expect-error` 常驻夹具）。探针里的 agent 表缺 T1.2 之后新增的
> `branchPorts`、mcp remote 子表缺 r12 另裁②的 `oauth`，以实现文件为准。

以下探针在 2026-08-30 用 `node_modules/.bin/tsc`（5.9.3）与 `packages/shared/node_modules/zod`（3.25.76）对仓内真实 schema 编译：
覆盖六类资源 payload、**全部 8 种 strict node kind**（字段按真实 schema 填写）、5 种 passthrough kind（含 `fieldSources`）、`code-round`，
类型定义与 design §1.1 **逐字相同**（含 `export` 修饰与 `AuthorableAvailability` / `AuthorableNodeTeaching<Fields, Sources>`）。
`tsc -p tsconfig.json` **零错误**（八个 `@ts-expect-error` 负例均为真错误，否则会报 TS2578）；五处变异——A object 字段去 `nested`、
B plugin 表删 `optionsJson`、C mcp remote 子表删 `timeoutMs`、D passthrough kind 去 `fieldSources`、E strict kind 加 `fieldSources`——各自报错（输出见文末）。
实现时以此为 `tests/intent-teaching-exhaustive.test.ts` 与 `modules/intent/domain/teaching/types.ts` 的蓝本（探针里 `import` 走绝对路径）。

## tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "skipLibCheck": true, "noUnusedLocals": false,
    "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022", "types": [],
    "baseUrl": "<repo>",
    "paths": { "zod": ["packages/shared/node_modules/zod"] }
  },
  "files": ["probe.ts"]
}
```

## probe.ts

```ts
import { z } from 'zod'
import {
  IntentAgentPayloadSchema, IntentMcpPayloadSchema, IntentWorkgroupMemberSchema, IntentWorkgroupPayloadSchema,
  IntentSkillPayloadSchema, IntentPluginPayloadSchema, IntentWorkflowPayloadSchema, IntentWorkflowNodeSchema,
} from '<repo>/packages/shared/src/schemas/intentChangeset'
import { ReviewNodeSchema } from '<repo>/packages/shared/src/schemas/review'
import {
  ScriptNodeSchema, ScriptOutputPortSchema, CallWorkflowNodeSchema, CallWorkgroupNodeSchema, CodeHostCallNodeSchema,
  WrapperFanoutNodeSchema, ClarifyNodeSchema, ClarifyCrossAgentNodeSchema, type NodeKind,
} from '<repo>/packages/shared/src/schemas/workflow'
import { type AclResourceType, type IntentResourceType } from '<repo>/packages/shared/src/schemas/resourceAcl'

// ───────────────────────── RFC-348 r9 type machinery ─────────────────────────
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
/** distributive over S (naked parameter) — unions yield the UNION of keys, never the intersection */
type KeysOf<S> = S extends unknown ? KeysOfInner<Unwrap<S>> : never
type KeysOfInner<U> =
  U extends z.ZodDiscriminatedUnion<any, infer O> ? KeysOf<O[number]>
  : U extends z.ZodUnion<infer O> ? KeysOf<O[number]>
  : U extends z.ZodArray<infer E, any> ? KeysOf<E>
  : U extends z.ZodObject<infer Shape, any, any> ? keyof Shape & string
  : never
type DiscriminatorOf<S> = Unwrap<S> extends z.ZodDiscriminatedUnion<infer D, any> ? D : never
type VariantValues<S> = OptionsOf<S> extends infer O ? (O extends z.ZodTypeAny ? z.infer<O>[DiscriminatorOf<S> & keyof z.infer<O>] & string : never) : never
type OptionFor<S, V extends string> = OptionsOf<S> extends infer O ? (O extends z.ZodTypeAny ? (z.infer<O> extends Record<DiscriminatorOf<S>, V> ? O : never) : never) : never
type FieldSchemaAt<S, K extends string> = ShapeOf<S> extends infer Shape ? (K extends keyof Shape ? Shape[K] : never) : never
type ElementOf<F> = Unwrap<F> extends z.ZodArray<infer E, any> ? Unwrap<E> : Unwrap<F>
type IsObjectLike<F> = [KeysOf<F>] extends [never] ? false : true
type ObjectOptionsOf<U> = U extends z.ZodUnion<infer O> ? Extract<O[number], z.ZodObject<any, any, any>> : never

export interface IntentVariantTeaching<S> {
  readonly discriminator: DiscriminatorOf<S>
  readonly variants: { readonly [V in VariantValues<S>]: TeachingFieldsOf<OptionFor<S, V>> }
}
type NestedFor<F> =
  ElementOf<F> extends z.ZodDiscriminatedUnion<any, any> ? IntentVariantTeaching<ElementOf<F>>
  : ElementOf<F> extends z.ZodUnion<any> ? TeachingFieldsOf<ObjectOptionsOf<ElementOf<F>>>
  : TeachingFieldsOf<ElementOf<F>>
type ScalarTeaching = { readonly form: string; readonly required: boolean; readonly note?: string; readonly mistake?: string; readonly nested?: never }
type ObjectTeaching<F> = { readonly form: string; readonly required: boolean; readonly note?: string; readonly mistake?: string; readonly nested: NestedFor<F> }
type Omitted = { readonly omit: true; readonly why: string }
export type FieldTeachingFor<F> = Omitted | (IsObjectLike<F> extends true ? ObjectTeaching<F> : ScalarTeaching)
export type TeachingFieldsOf<S> = { readonly [K in KeysOf<S>]: FieldTeachingFor<FieldSchemaAt<S, K>> }
type ResourceFieldsOf<S> = Unwrap<S> extends z.ZodDiscriminatedUnion<any, any> ? IntentVariantTeaching<S> : TeachingFieldsOf<S>

// ───────────────────────── resource registry (real schemas) ─────────────────────────
type IntentPayloadSchemaOf = {
  agent: typeof IntentAgentPayloadSchema; skill: typeof IntentSkillPayloadSchema; mcp: typeof IntentMcpPayloadSchema
  plugin: typeof IntentPluginPayloadSchema; workflow: typeof IntentWorkflowPayloadSchema; workgroup: typeof IntentWorkgroupPayloadSchema
}
export interface IntentResourceTeaching<Fields> { readonly fields: Fields; readonly notes: readonly string[]; readonly mistakes: readonly string[] }
const f = (form: string, required = false): ScalarTeaching => ({ form, required })

const INTENT_RESOURCE_TEACHING = {
  agent: { notes: [], mistakes: [], fields: {
    name: f('name', true), description: f('description', true), outputs: f('outputs: string[]', true), bodyMd: f('bodyMd', true),
    outputKinds: f('outputKinds:{port:kind}'), outputWrapperPortNames: f('outputWrapperPortNames'), role: f("role:'normal'|'aggregator'"),
    syncOutputsOnIterate: f('syncOutputsOnIterate'), runtime: f('runtime'), permission: f('permission:{key:action}'),
    dependsOn: f('dependsOn:[ref]'), mcp: f('mcp:[ref]'), plugins: f('plugins:[ref]'), frontmatterExtra: f('frontmatterExtra'),
    inputs: { form: 'inputs:[{name,kind,required,description}]', required: false, nested: { name: f('name', true), kind: f('kind', true), required: f('required'), description: f('description') } },
    skills: { form: "skills:[ref|{kind:'project',name}]", required: false, nested: { kind: f("kind:'project'", true), name: f('name', true) } },
  } },
  skill: { notes: [], mistakes: [], fields: {
    name: f('name', true), description: f('description', true), bodyMd: f('bodyMd', true), frontmatterExtra: f('frontmatterExtra'),
    files: { form: 'files:[{path,content}]', required: false, nested: { path: f('path', true), content: f('content', true) } },
  } },
  mcp: { notes: [], mistakes: [], fields: { discriminator: 'type', variants: {
    local:  { type: f("type:'local'", true), name: f('name', true), description: f('description', true), enabled: f('enabled'),
              config: { form: 'config', required: true, nested: { command: f('command', true), env: f('env'), timeoutMs: f('timeoutMs') } } },
    remote: { type: f("type:'remote'", true), name: f('name', true), description: f('description', true), enabled: f('enabled'),
              config: { form: 'config', required: true, nested: { url: f('url', true), headers: f('headers'), timeoutMs: f('timeoutMs') } } },
  } } },
  plugin: { notes: [], mistakes: [], fields: { name: f('name', true), spec: f('spec', true), description: f('description', true), optionsJson: f('optionsJson'), enabled: f('enabled') } },
  workflow: { notes: [], mistakes: [], fields: {
    name: f('name', true), description: f('description', true),
    definition: { form: 'definition:{…}', required: true, nested: {
      $schema_version: f('$schema_version', true), inputs: f('inputs:[…]'), edges: f('edges:[…]'), outputs: f('outputs'),
      nodes: { form: 'nodes:[…]', required: true, nested: { id: f('id', true), kind: f('kind', true), agentRef: f('agentRef'), workflowRef: f('workflowRef'), workgroupRef: f('workgroupRef') } },
    } },
  } },
  workgroup: { notes: [], mistakes: [], fields: {
    name: f('name', true), description: f('description', true), instructions: f('instructions'), mode: f('mode', true), outputContract: f('outputContract'),
    leaderDisplayName: f('leaderDisplayName'), maxRounds: f('maxRounds'), completionGate: f('completionGate'), clarifyBudget: f('clarifyBudget'), fanOut: f('fanOut'),
    switches: { form: 'switches:{…}', required: false, nested: { shareOutputs: f('shareOutputs', true), directMessages: f('directMessages', true), blackboard: f('blackboard', true) } },
    members: { form: 'members:[…]', required: false, nested: { discriminator: 'memberType', variants: {
      agent: { memberType: f("memberType:'agent'", true), agentRef: f('agentRef', true), displayName: f('displayName', true), roleDesc: f('roleDesc') },
      human: { memberType: f("memberType:'human'", true), displayName: f('displayName', true), roleDesc: f('roleDesc') },
    } } },
  } },
} satisfies { readonly [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }

// ───────────────────────── node registry (all 8 strict kinds + 5 passthrough kinds + code-round) ─────────────────────────
type StrictNodeSchemaOf = {
  review: typeof ReviewNodeSchema; clarify: typeof ClarifyNodeSchema; 'clarify-cross-agent': typeof ClarifyCrossAgentNodeSchema
  'wrapper-fanout': typeof WrapperFanoutNodeSchema; 'call-workflow': typeof CallWorkflowNodeSchema; 'call-workgroup': typeof CallWorkgroupNodeSchema
  script: typeof ScriptNodeSchema; 'code-host-call': typeof CodeHostCallNodeSchema
}
type NodeBaseKey = 'id' | 'kind' | 'position' | 'title' | 'agentId'
type IntentOnlyNodeFields<K> = K extends 'call-workflow' ? { readonly workflowRef: ScalarTeaching } : K extends 'call-workgroup' ? { readonly workgroupRef: ScalarTeaching } : {}
type StrictNodeFields<K extends keyof StrictNodeSchemaOf> = Omit<TeachingFieldsOf<StrictNodeSchemaOf[K]>, NodeBaseKey> & IntentOnlyNodeFields<K>
type PassthroughKeysOf<K> =
  K extends 'wrapper-loop' ? 'nodeIds' | 'maxIterations' | 'exitCondition' | 'outputBindings' | 'continueOnMaxIterations'
  : K extends 'agent-single' ? 'agentRef' | 'promptTemplate'
  : K extends 'input' ? 'inputKey' : K extends 'output' ? 'ports' : K extends 'wrapper-git' ? 'nodeIds' : never
export type IntentPassthroughFieldSource =
  | { readonly readPoint: { readonly file: string; readonly identifier: string } }
  | { readonly intentOnly: { readonly resolvedIn: 'packages/backend/src/services/intent/resolveChangeset.ts' } }
/** strict kind：不得有 fieldSources；passthrough kind：fieldSources 必须恰好覆盖每个声明字段 */
export type IntentNodeAvailability =
  | { kind: 'public' }
  | { kind: 'privileged'; permission: 'scripts:author' | 'code-host-calls:author'; redactedFields: readonly string[]; overviewLabel: string; nestedRedactionHint: string; untouchableFields: string }
  | { kind: 'synthesized-only' }
/** 可创作 kind 的 availability 不含 synthesized-only（r10 finding 1） */
type AuthorableAvailability = Exclude<IntentNodeAvailability, { kind: 'synthesized-only' }>
type AuthorableNodeTeaching<Fields, Sources = undefined> = {
  readonly availability: AuthorableAvailability
  readonly fields: Fields
  readonly notes: readonly string[]
  readonly mistakes: readonly string[]
} & (Sources extends undefined ? { readonly fieldSources?: never } : { readonly fieldSources: Sources })
type SynthesizedNodeTeaching = { readonly availability: { kind: 'synthesized-only' }; readonly notes: readonly string[]; readonly mistakes: readonly string[]; readonly fields?: never }
type NodeTeachingOf<K extends NodeKind> =
  K extends 'code-round' ? SynthesizedNodeTeaching
  : K extends keyof StrictNodeSchemaOf ? AuthorableNodeTeaching<StrictNodeFields<K>>
  : AuthorableNodeTeaching<{ readonly [P in PassthroughKeysOf<K>]: ScalarTeaching }, { readonly [P in PassthroughKeysOf<K>]: IntentPassthroughFieldSource }>
const pub = { kind: 'public' } as const
const INTENT_NODE_TEACHING = {
  review: { availability: pub, notes: [], mistakes: [], fields: {
    inputSource: { form: 'inputSource:{nodeId,portName}', required: true, nested: { nodeId: f('nodeId', true), portName: f('portName', true) } },
    description: f('description'), rerunnableOnReject: f('rerunnableOnReject', true), rerunnableOnIterate: f('rerunnableOnIterate', true),
    rollbackFilesOnReject: f('rollbackFilesOnReject'), rollbackFilesOnIterate: f('rollbackFilesOnIterate'), commentInjectTemplate: f('commentInjectTemplate'),
    assignee: { omit: true, why: 'reserved' },
  } },
  script: { availability: { kind: 'privileged', permission: 'scripts:author', redactedFields: ['env'], overviewLabel: 'script', nestedRedactionHint: '', untouchableFields: '' }, notes: [], mistakes: [], fields: {
    language: f('language', true), script: f('script', true), dependencies: f('dependencies'), env: f('env'), readonly: f('readonly'),
    outputs: { form: 'outputs:[{name,kind?,branch?}]', required: false, nested: { name: f('name', true), kind: f('kind'), branch: f('branch') } },
  } },
  'call-workflow': { availability: pub, notes: [], mistakes: [], fields: {
    workflowName: f('workflowName', true), workflowId: { omit: true, why: 'canonical id' }, workflowRef: f('workflowRef'),
    limits: { form: 'limits:{maxDurationMs?,maxTotalTokens?}', required: false, nested: { maxDurationMs: f('maxDurationMs'), maxTotalTokens: f('maxTotalTokens') } },
  } },
  'wrapper-loop': { availability: pub, notes: [], mistakes: [], fields: { nodeIds: f('nodeIds', true), maxIterations: f('maxIterations', true), exitCondition: f('exitCondition', true), outputBindings: f('outputBindings', true), continueOnMaxIterations: f('continueOnMaxIterations') },
    fieldSources: { nodeIds: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'nodeIds' } }, maxIterations: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'maxIterations' } },
      exitCondition: { readPoint: { file: 'packages/backend/src/modules/task-execution/domain/loopExitCondition.ts', identifier: 'exitCondition' } },
      outputBindings: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'outputBindings' } }, continueOnMaxIterations: { readPoint: { file: 'packages/shared/src/loopPolicy.ts', identifier: 'continueOnMaxIterations' } } } },
  'agent-single': { availability: pub, notes: [], mistakes: [], fields: { agentRef: f('agentRef', true), promptTemplate: f('promptTemplate', true) },
    fieldSources: { agentRef: { intentOnly: { resolvedIn: 'packages/backend/src/services/intent/resolveChangeset.ts' } }, promptTemplate: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'promptTemplate' } } } },
  input: { availability: pub, notes: [], mistakes: [], fields: { inputKey: f('inputKey', true) }, fieldSources: { inputKey: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'inputKey' } } } },
  output: { availability: pub, notes: [], mistakes: [], fields: { ports: f('ports', true) }, fieldSources: { ports: { readPoint: { file: 'packages/backend/src/modules/task-execution/domain/inboundEdges.ts', identifier: 'ports' } } } },
  'wrapper-git': { availability: pub, notes: [], mistakes: [], fields: { nodeIds: f('nodeIds', true) }, fieldSources: { nodeIds: { readPoint: { file: 'packages/backend/src/services/workflow.validator.ts', identifier: 'nodeIds' } } } },
  'wrapper-fanout': { availability: pub, notes: [], mistakes: [], fields: { nodeIds: f('nodeIds:[nodeId]', true), expectedShardCount: f('expectedShardCount'),
    inputs: { form: 'inputs:[{name,kind,isShardSource?}]', required: true, nested: { name: f('name', true), kind: f('kind', true), isShardSource: f('isShardSource') } } } },
  clarify: { availability: pub, notes: [], mistakes: [], fields: { description: f('description'), sessionMode: f("sessionMode:'isolated'|'inline'"), clarifyMode: f("clarifyMode:'optional'"), assignee: { omit: true, why: 'reserved' } } },
  'clarify-cross-agent': { availability: pub, notes: [], mistakes: [], fields: { description: f('description'), sessionModeForQuestioner: f('sessionModeForQuestioner'), assignee: { omit: true, why: 'reserved' } } },
  'call-workgroup': { availability: pub, notes: [], mistakes: [], fields: { workgroupName: f('workgroupName', true), workgroupId: { omit: true, why: 'canonical id' }, workgroupRef: f('workgroupRef'), goalTemplate: f('goalTemplate', true),
    limits: { form: 'limits:{maxDurationMs?,maxTotalTokens?}', required: false, nested: { maxDurationMs: f('maxDurationMs'), maxTotalTokens: f('maxTotalTokens') } } } },
  'code-host-call': { availability: { kind: 'privileged', permission: 'code-host-calls:author', redactedFields: ['params'], overviewLabel: 'code-host-call', nestedRedactionHint: '', untouchableFields: '' }, notes: [], mistakes: [], fields: {
    provider: f("provider:'gitlab'|'github'", true), action: f('action', true), params: f('params:{field:template}'), allowDestructive: f('allowDestructive'), timeoutMs: f('timeoutMs'),
    request: { form: 'request:{method,path,query?,body?}', required: false, nested: { method: f('method', true), path: f('path', true), query: f('query'), body: f('body') } } } },
  'code-round': { availability: { kind: 'synthesized-only' }, notes: [], mistakes: [] },
} satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }

// ───────────────────────── platform map ─────────────────────────
type PlatformTeaching = { stance: 'intent-creatable' } | { stance: 'platform-only'; purpose: string }
const PLATFORM_MAP = {
  agent: { stance: 'intent-creatable' }, skill: { stance: 'intent-creatable' }, mcp: { stance: 'intent-creatable' }, plugin: { stance: 'intent-creatable' },
  workflow: { stance: 'intent-creatable' }, workgroup: { stance: 'intent-creatable' },
  capability_template: { stance: 'platform-only', purpose: 'x' }, action_template: { stance: 'platform-only', purpose: 'x' },
  verification_profile: { stance: 'platform-only', purpose: 'x' }, digital_employee: { stance: 'platform-only', purpose: 'x' },
  automation_policy: { stance: 'platform-only', purpose: 'x' }, development_adapter: { stance: 'platform-only', purpose: 'x' },
  employee_definition: { stance: 'platform-only', purpose: 'x' }, employee_tool: { stance: 'platform-only', purpose: 'x' }, employee_job_template: { stance: 'platform-only', purpose: 'x' },
} satisfies Record<AclResourceType, PlatformTeaching>

// ───────────────────────── negative fixtures (must each be a real error) ─────────────────────────
const { review: _dropReview, ...nodeWithoutReview } = INTENT_NODE_TEACHING
// @ts-expect-error — 1. missing NodeKind entry
const _missingKind = nodeWithoutReview satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }
const { skill: _dropSkill, ...resWithoutSkill } = INTENT_RESOURCE_TEACHING
// @ts-expect-error — 2. missing IntentResourceType entry
const _missingRes = resWithoutSkill satisfies { readonly [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }
const { employee_tool: _dropTool, ...mapWithoutTool } = PLATFORM_MAP
// @ts-expect-error — 3. missing AclResourceType entry
const _missingAcl = mapWithoutTool satisfies Record<AclResourceType, PlatformTeaching>
const ReviewExt = ReviewNodeSchema.extend({ zzz: z.string() })
// @ts-expect-error — 4. top-level field added to a strict node schema, not taught
const _topLevel = INTENT_NODE_TEACHING.review.fields satisfies Omit<TeachingFieldsOf<typeof ReviewExt>, NodeBaseKey>
const OutputExt = ScriptOutputPortSchema.extend({ zzz: z.string() })
// @ts-expect-error — 5. nested element field added, not taught
const _nested = INTENT_NODE_TEACHING.script.fields.outputs.nested satisfies TeachingFieldsOf<typeof OutputExt>
const MemberExt = z.discriminatedUnion('memberType', [IntentWorkgroupMemberSchema.options[0].extend({ zzz: z.string() }), IntentWorkgroupMemberSchema.options[1]])
// @ts-expect-error — 6. variant-only field added, old variant table not updated
const _variantOnly = INTENT_RESOURCE_TEACHING.workgroup.fields.members.nested satisfies IntentVariantTeaching<typeof MemberExt>
const McpExt = z.discriminatedUnion('type', [IntentMcpPayloadSchema.options[0], IntentMcpPayloadSchema.options[1], z.object({ type: z.literal('stdio'), name: z.string() })])
// @ts-expect-error — 7. new variant added, old variants table lacks it
const _newVariant = INTENT_RESOURCE_TEACHING.mcp.fields satisfies IntentVariantTeaching<typeof McpExt>
const ReviewPolicy = ReviewNodeSchema.extend({ policy: z.object({ mode: z.string() }) })
// @ts-expect-error — 8. new object-valued field registered parent-only (no nested)
const _parentOnly = { ...INTENT_NODE_TEACHING.review.fields, policy: { form: 'policy', required: false } } satisfies Omit<TeachingFieldsOf<typeof ReviewPolicy>, NodeBaseKey>
// positive counterpart of 8: nested table present ⇒ compiles
const _parentWithNested = { ...INTENT_NODE_TEACHING.review.fields, policy: { form: 'policy', required: false, nested: { mode: f('mode', true) } } } satisfies Omit<TeachingFieldsOf<typeof ReviewPolicy>, NodeBaseKey>
// positive: scalar without nested compiles; object without nested is rejected by fixture 8
// key probes
type _SkillsKeys = KeysOf<typeof IntentAgentPayloadSchema.shape.skills>
const _skillsKeysProbe: Record<_SkillsKeys, true> = { kind: true, name: true }
type _McpVariants = VariantValues<typeof IntentMcpPayloadSchema>
const _mcpVariantsProbe: Record<_McpVariants, true> = { local: true, remote: true }
type _NodeKeys = KeysOf<typeof IntentWorkflowNodeSchema>
const _nodeKeysProbe: Record<_NodeKeys, true> = { id: true, kind: true, agentRef: true, workflowRef: true, workgroupRef: true }
export const _all = [_missingKind, _missingRes, _missingAcl, _topLevel, _nested, _variantOnly, _newVariant, _parentOnly, _parentWithNested, _skillsKeysProbe, _mcpVariantsProbe, _nodeKeysProbe]
```

## 变异自检输出

```
--- probe-mut
../../../../..probe.ts(70,5): error TS2322: Type '{ form: string; required: false; }' is not assignable to type 'FieldTeachingFor<ZodOptional<ZodArray<ZodObject<{ name: ZodString; kind: ZodEffects<Zod
  Property 'nested' is missing in type '{ form: string; required: false; }' but required in type 'ObjectTeaching<ZodOptional<ZodArray<ZodObject<{ name: ZodString; kind: ZodEffects<ZodEffects<ZodString
../../../../..probe.ts(81,57): error TS2741: Property 'timeoutMs' is missing in type '{ url: ScalarTeaching; headers: ScalarTeaching; }' but required in type 'TeachingFieldsOf<ZodObject<{ url: ZodEffe
../../../../..probe.ts(83,38): error TS2741: Property 'optionsJson' is missing in type '{ name: ScalarTeaching; spec: ScalarTeaching; description: ScalarTeaching; enabled: ScalarTeaching; }' but requi
--- probe-mutD
../../../../..probe.ts(153,5): error TS2561: Object literal may only specify known properties, but 'fieldSourcesX' does not exist in type 'AuthorableNodeTeaching<{ readonly nodeIds: ScalarTeaching; re
--- probe-mutE
../../../../..probe.ts(143,6): error TS2322: Type '{}' is not assignable to type 'undefined'.
```
