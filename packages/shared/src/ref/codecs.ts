// RFC-271 决策 29 — 七个域的 wire codec。
//
// **这是「wire 零变更」的兑现点。** AST 统一（./ast.ts），编码各域自理：
//
//   IntentRef          res#<type>#<n>  /  $new:<slug>        ← 模型看到的，一字不改
//   ImportSelectorRef  {type, name, ownerUsername?} 对象      ← type 必留
//   RuntimeRef         裸 ULID  /  {kind:'project',name}      ← 存量 agents.* 不改
//   CallRef            {nodeId, workflowName, workflowId?}    ← 存量 definition 不改
//   BundleIdentityRef  local:<slug> / external:<token> / builtin:<type>/<name>
//   BundleAgentSkillRef  local: / external: / project:<name>  ← 仅 agent.skills 槽
//   BundleCallRef      local: / external: / name:<type>/<name> / builtin:<type>/<name>
//
// 域是**收窄**不是放宽：把 `name` 形态放进 agent 的 dependsOn 必须 parse 失败。
// 每个 codec 只认自己那几个变体，其余一律 `null`（调用方转成该域自己的错误）。

import { BUNDLE_SLUG_RE, type ResourceRefAst } from './ast'
import type { AclResourceType } from '../schemas/resourceAcl'

// -----------------------------------------------------------------------------
// 域 1 · IntentRef —— 拼写来自 schemas/intentChangeset.ts，逐字不动
// -----------------------------------------------------------------------------

/**
 * ⚠️ **这两个正则是 intent wire 的唯一 lexicon**（RFC-271 T6b）。
 * `schemas/intentChangeset.ts` 从这里导入，不再各自声明一份——重复声明正是决策 29
 * 要消除的东西（同一概念六套实现）。捕获组是 codec 需要的，schema 侧只用它们做
 * `.regex()` 校验，行为逐字不变。
 */
export const INTENT_HANDLE_RE =
  /^res#(agent|skill|mcp|plugin|workflow|workgroup)#([1-9][0-9]{0,5})$/
export const INTENT_TEMP_REF_RE = /^\$new:([a-z0-9][a-z0-9_-]{0,63})$/

/** `res#agent#3` / `$new:auditor` → AST。不认识的返回 null。 */
export function decodeIntentRef(wire: string): ResourceRefAst | null {
  const handle = INTENT_HANDLE_RE.exec(wire)
  if (handle !== null) {
    return { k: 'handle', type: handle[1] as AclResourceType, ordinal: Number(handle[2]) }
  }
  const temp = INTENT_TEMP_REF_RE.exec(wire)
  if (temp !== null) return { k: 'local', slug: temp[1]! }
  return null
}

/** AST → intent wire。**必须与 decode 逐字往返**（字节级 round-trip 测试锁）。 */
export function encodeIntentRef(ref: ResourceRefAst): string | null {
  if (ref.k === 'handle') return `res#${ref.type}#${ref.ordinal}`
  if (ref.k === 'local') return `$new:${ref.slug}`
  return null
}

// -----------------------------------------------------------------------------
// 域 2 · ImportSelectorRef —— 对象形态，`type` 必填且参与稳定 key
// -----------------------------------------------------------------------------

export interface ImportSelectorWire {
  type: AclResourceType
  name: string
  ownerUsername?: string
}

export function decodeImportSelectorRef(wire: ImportSelectorWire): ResourceRefAst {
  return {
    k: 'selector',
    type: wire.type,
    name: wire.name,
    ...(wire.ownerUsername === undefined ? {} : { ownerUsername: wire.ownerUsername }),
  }
}

export function encodeImportSelectorRef(ref: ResourceRefAst): ImportSelectorWire | null {
  if (ref.k !== 'selector') return null
  return {
    type: ref.type,
    name: ref.name,
    ...(ref.ownerUsername === undefined ? {} : { ownerUsername: ref.ownerUsername }),
  }
}

// -----------------------------------------------------------------------------
// 域 3 · RuntimeRef —— scheduler 派发 / runner 组装 config
//
// ⚠️ 两个变体，不是一个（R7-P1-2）：`agents.skills` 是判别联合，project 分支没有
// DB row、runner 按 `p:<name>` 去重并按名字透传 CLI。只允许 `id` 会让一个今天
// 完全合法、能跑的代理无法表达。
// -----------------------------------------------------------------------------

/** `agents.skills` 元素的持久化形态。 */
export type AgentSkillWire =
  | { kind: 'managed'; skillId: string }
  | { kind: 'project'; name: string }

export function decodeAgentSkillRef(wire: AgentSkillWire): ResourceRefAst {
  return wire.kind === 'managed'
    ? { k: 'id', type: 'skill', id: wire.skillId }
    : { k: 'project-skill', name: wire.name }
}

export function encodeAgentSkillRef(ref: ResourceRefAst): AgentSkillWire | null {
  if (ref.k === 'id' && ref.type === 'skill') return { kind: 'managed', skillId: ref.id }
  if (ref.k === 'project-skill') return { kind: 'project', name: ref.name }
  return null
}

/** 裸 ULID（node.agentId、agents.mcp/plugins/dependsOn 的落库形态）。 */
export function decodeRuntimeIdRef(type: AclResourceType, id: string): ResourceRefAst {
  return { k: 'id', type, id }
}

export function encodeRuntimeIdRef(ref: ResourceRefAst): string | null {
  return ref.k === 'id' ? ref.id : null
}

// -----------------------------------------------------------------------------
// 域 4 · CallRef —— 复合记录（R7-P1-3）
//
// 存量 definition 的形态就是 {workflowName, workflowId?}，节点 id 来自节点本身。
// 三条 lowering 规则见 design §1.1b：
//   local:    → name + 预铸 id
//   external: → name + 解析到的 id（**两个都写**，否则 freeze 回退到最老可见行）
//   name:     → 只写 name，**不写 id cache**（late-bound，写 cache 等于伪造）
// -----------------------------------------------------------------------------

export interface CallRefWire {
  nodeId: string
  /** `workflowName` 或 `workgroupName`，按 type 取。 */
  name: string
  /** `workflowId` 或 `workgroupId` 的 cache；late-bound 时缺席。 */
  idHint?: string
}

export function decodeCallRef(type: 'workflow' | 'workgroup', wire: CallRefWire): ResourceRefAst {
  return {
    k: 'call',
    type,
    nodeId: wire.nodeId,
    authoritativeName: wire.name,
    ...(wire.idHint === undefined ? {} : { idHint: wire.idHint }),
  }
}

export function encodeCallRef(ref: ResourceRefAst): CallRefWire | null {
  if (ref.k !== 'call') return null
  return {
    nodeId: ref.nodeId,
    name: ref.authoritativeName,
    ...(ref.idHint === undefined ? {} : { idHint: ref.idHint }),
  }
}

// -----------------------------------------------------------------------------
// 域 5 · BundleIdentityRef —— bundle 里除 agent.skills 外的引用槽
// -----------------------------------------------------------------------------

const BUNDLE_LOCAL_RE = /^local:([a-z0-9][a-z0-9_-]{0,63})$/
const BUNDLE_EXTERNAL_RE = /^external:([A-Za-z0-9._:#/-]{1,128})$/

/** `builtin:<type>/<name>` —— 只有 agent / workflow 两张表有 `builtin` 列。 */
const BUNDLE_BUILTIN_RE = /^builtin:(agent|workflow)\/(\S{1,256})$/

export function decodeBundleIdentityRef(wire: string): ResourceRefAst | null {
  const local = BUNDLE_LOCAL_RE.exec(wire)
  if (local !== null) return { k: 'local', slug: local[1]! }
  const external = BUNDLE_EXTERNAL_RE.exec(wire)
  if (external !== null) return { k: 'external', token: external[1]! }
  const builtin = BUNDLE_BUILTIN_RE.exec(wire)
  if (builtin !== null) {
    return {
      k: 'builtin',
      type: builtin[1] as 'agent' | 'workflow',
      name: builtin[2]!,
    }
  }
  return null
}

export function encodeBundleIdentityRef(ref: ResourceRefAst): string | null {
  if (ref.k === 'local') return `local:${ref.slug}`
  if (ref.k === 'external') return `external:${ref.token}`
  if (ref.k === 'builtin') return `builtin:${ref.type}/${ref.name}`
  return null
}

// -----------------------------------------------------------------------------
// 域 6 · BundleAgentSkillRef —— **仅** agent 的 `skills` 槽（R8-P1-1）
//
// 第四个槽位域。`project:` 只在这里合法；其余槽拒绝它。
// -----------------------------------------------------------------------------

const BUNDLE_PROJECT_SKILL_RE = /^project:(.{1,128})$/

export function decodeBundleAgentSkillRef(wire: string): ResourceRefAst | null {
  const project = BUNDLE_PROJECT_SKILL_RE.exec(wire)
  if (project !== null) return { k: 'project-skill', name: project[1]! }
  const identity = decodeBundleIdentityRef(wire)
  // Skill 表没有 builtin 列。不能因为 identity 域增加了 builtin，就把
  // 这种无法解析的形态渗进 agent.skills 专属域。
  return identity?.k === 'local' || identity?.k === 'external' ? identity : null
}

export function encodeBundleAgentSkillRef(ref: ResourceRefAst): string | null {
  if (ref.k === 'project-skill') return `project:${ref.name}`
  if (ref.k === 'local') return `local:${ref.slug}`
  if (ref.k === 'external') return `external:${ref.token}`
  return null
}

// -----------------------------------------------------------------------------
// 域 7 · BundleCallRef —— bundle 里的 call 目标槽（local / external / name）
// -----------------------------------------------------------------------------

const BUNDLE_NAME_RE = /^name:(workflow|workgroup)\/(.{1,256})$/

export function decodeBundleCallRef(wire: string): ResourceRefAst | null {
  const named = BUNDLE_NAME_RE.exec(wire)
  if (named !== null) {
    return { k: 'name', type: named[1] as AclResourceType, name: named[2]! }
  }
  return decodeBundleIdentityRef(wire)
}

export function encodeBundleCallRef(ref: ResourceRefAst): string | null {
  if (ref.k === 'name') return `name:${ref.type}/${ref.name}`
  return encodeBundleIdentityRef(ref)
}

// -----------------------------------------------------------------------------
// 域收窄的自检（测试消费）
// -----------------------------------------------------------------------------

/** 每个域允许的 AST 变体。测试用它做「跨域必须 parse 失败」的表驱动断言。 */
export const REF_DOMAIN_VARIANTS = {
  intent: ['handle', 'local'],
  importSelector: ['selector'],
  agentSkill: ['id', 'project-skill'],
  runtimeId: ['id'],
  call: ['call'],
  bundleIdentity: ['local', 'external', 'builtin'],
  bundleAgentSkill: ['local', 'external', 'project-skill'],
  bundleCall: ['local', 'external', 'name', 'builtin'],
} as const satisfies Record<string, readonly ResourceRefAst['k'][]>

export { BUNDLE_SLUG_RE }
