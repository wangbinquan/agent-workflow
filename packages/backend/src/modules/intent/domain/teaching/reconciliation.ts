// RFC-348 D2 — platform ⇔ intent field reconciliation.
//
// The teaching registries are keyed by the INTENT payload schemas. That alone
// cannot notice a field the PLATFORM gained but the intent schema never learned
// (`branchPorts` sat in `CreateAgentSchema` for an RFC and never reached the
// model). This table pairs every platform object node with its intent
// counterpart and states, per key, whether it is renamed (`agentId → agentRef`),
// deliberately excluded (a platform-internal id cache) or intent-only (a session
// handle). tests/intent-teaching-reconciliation.test.ts runs two rules over it:
//
//  1. per-entry, one level of KEY NAMES in both directions (leaf types are the
//     resolve seam's business, not this table's);
//  2. an object-coverage ratchet: every object node in the six platform create
//     schema trees (and the six intent payload trees) must be claimed by exactly
//     one entry, sit inside an excluded / intent-only subtree, or be listed in
//     the uncovered map with a reason.
//
// Pure module: zod schema introspection only.

import { z } from 'zod'
import {
  AgentInputPortSchema,
  AgentSkillRefSchema,
  CallWorkflowNodeSchema,
  CallWorkgroupNodeSchema,
  ClarifyCrossAgentNodeSchema,
  ClarifyNodeSchema,
  CodeHostCallNodeSchema,
  CreateAgentSchema,
  CreateManagedSkillSchema,
  CreateMcpSchema,
  CreatePluginSchema,
  CreateWorkflowSchema,
  CreateWorkgroupSchema,
  IntentAgentPayloadSchema,
  IntentMcpOAuthConfigSchema,
  IntentMcpPayloadSchema,
  IntentPluginPayloadSchema,
  IntentSkillPayloadSchema,
  IntentWorkflowDefinitionSchema,
  IntentWorkflowNodeSchema,
  IntentWorkflowPayloadSchema,
  IntentWorkgroupMemberSchema,
  IntentWorkgroupPayloadSchema,
  McpLocalConfigSchema,
  McpOAuthConfigSchema,
  McpRemoteConfigSchema,
  PortRefSchema,
  ReviewNodeSchema,
  ScriptNodeSchema,
  UploadInputSchema,
  WorkflowDefinitionSchema,
  WorkflowEdgeSchema,
  WorkflowInputSchema,
  WorkflowNodeSchema,
  WorkflowOutputBindingSchema,
  WorkgroupMemberInputSchema,
  WorkgroupSwitchesSchema,
  WrapperFanoutNodeSchema,
  type IntentResourceType,
} from '@agent-workflow/shared'
import { INTENT_NODE_TEACHING } from './nodeKinds'
import {
  WORKFLOW_EDGE_TEACHING,
  WORKFLOW_INPUT_TEACHING,
  WORKFLOW_OUTPUT_TEACHING,
  WORKFLOW_PORT_REF_TEACHING,
  type WorkflowInputKind,
} from './workflowParts'
import type { NodeBaseKey, StrictNodeSchemaOf } from './types'

// ───────────────────────── zod introspection ─────────────────────────

/** Any zod type that unwraps to an object (checked at runtime by `schemaKeys`). */
export type ZodObjectLike = z.ZodTypeAny

/** Strip effects / optional / nullable / default / branded wrappers. */
export function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema
  for (;;) {
    if (current instanceof z.ZodEffects) current = current.innerType()
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap()
    } else if (current instanceof z.ZodDefault) current = current.removeDefault()
    else if (current instanceof z.ZodBranded) current = current.unwrap()
    else return current
  }
}

/** One level of keys of an object schema (throws on anything else). */
export function schemaKeys(schema: z.ZodTypeAny, label = 'schema'): string[] {
  const inner = unwrapSchema(schema)
  if (!(inner instanceof z.ZodObject)) {
    throw new Error(`${label}: expected an object schema, got ${inner._def.typeName}`)
  }
  return Object.keys(inner.shape as Record<string, unknown>)
}

/** Element schema of an array (after unwrapping). */
export function elementSchemaOf(schema: z.ZodTypeAny): z.ZodTypeAny {
  const inner = unwrapSchema(schema)
  if (!(inner instanceof z.ZodArray)) {
    throw new Error(`expected an array schema, got ${inner._def.typeName}`)
  }
  return inner.element as z.ZodTypeAny
}

/** The single object option of a plain union (e.g. `z.union([ref, object])`). */
export function objectOptionOf(schema: z.ZodTypeAny): z.ZodTypeAny {
  const inner = unwrapSchema(schema)
  if (!(inner instanceof z.ZodUnion)) {
    throw new Error(`expected a union schema, got ${inner._def.typeName}`)
  }
  const objects = (inner.options as z.ZodTypeAny[]).filter(
    (option) => unwrapSchema(option) instanceof z.ZodObject,
  )
  if (objects.length !== 1) {
    throw new Error(`expected exactly one object option, found ${objects.length}`)
  }
  return objects[0] as z.ZodTypeAny
}

export interface ObjectNode {
  /** '' for the root; `a.b`, `a[]`, `<variant>`, `a[]<variant>` … */
  readonly path: string
  readonly schema: z.ZodTypeAny
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}

/**
 * Every OBJECT node reachable from `root`. Arrays descend into their element
 * (`[]`), discriminated unions into every option (`<value>`), plain unions into
 * object options (unlabeled when there is exactly one, `<i>` otherwise);
 * records, literals and primitives are leaves. Effects / optional / default /
 * nullable wrappers are transparent.
 */
export function walkObjectNodes(root: z.ZodTypeAny, path = ''): ObjectNode[] {
  const out: ObjectNode[] = []
  const visit = (schema: z.ZodTypeAny, at: string): void => {
    const inner = unwrapSchema(schema)
    if (inner instanceof z.ZodObject) {
      out.push({ path: at, schema: inner })
      for (const [key, child] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
        visit(child, joinPath(at, key))
      }
      return
    }
    if (inner instanceof z.ZodArray) {
      visit(inner.element as z.ZodTypeAny, `${at}[]`)
      return
    }
    if (inner instanceof z.ZodDiscriminatedUnion) {
      const discriminator = inner.discriminator as string
      for (const option of inner.options as z.ZodObject<z.ZodRawShape>[]) {
        const literal = unwrapSchema(option.shape[discriminator] as z.ZodTypeAny)
        const value = literal instanceof z.ZodLiteral ? String(literal.value) : '?'
        visit(option, `${at}<${value}>`)
      }
      return
    }
    if (inner instanceof z.ZodUnion) {
      // Only options that actually contain object nodes count; a lone object
      // option keeps the parent path, several are labeled by index.
      const objectOptions = (inner.options as z.ZodTypeAny[]).filter(
        (option) => walkObjectNodes(option).length > 0,
      )
      objectOptions.forEach((option, index) => {
        visit(option, objectOptions.length === 1 ? at : `${at}<${index}>`)
      })
      return
    }
    // records / literals / primitives / unknown / never: leaves
  }
  visit(root, path)
  return out
}

// ───────────────────────── the table ─────────────────────────

export type TeachingTableName =
  | 'INTENT_NODE_TEACHING'
  | 'WORKFLOW_INPUT_TEACHING'
  | 'WORKFLOW_EDGE_TEACHING'
  | 'WORKFLOW_OUTPUT_TEACHING'
  | 'WORKFLOW_PORT_REF_TEACHING'

export interface ReconciliationVariant {
  readonly paths: readonly string[]
  readonly schema: ZodObjectLike
  readonly renamed: Readonly<Record<string, string>>
  readonly excluded: Readonly<Record<string, string>>
}

export interface ReconciliationEntry {
  readonly id: string
  readonly resourceType: IntentResourceType
  /** Platform object node + its path(s) in the create-schema tree; `paths: []` = tree-external (only via validator). */
  readonly platform: { readonly paths: readonly string[]; readonly schema: ZodObjectLike }
  /** Intent-side key view: a schema, a teaching table, or per-variant schemas. */
  readonly intent:
    | { readonly paths: readonly string[]; readonly schema: ZodObjectLike }
    | {
        readonly paths: readonly string[]
        readonly table: TeachingTableName
        readonly select?: string
      }
    | { readonly variants: Readonly<Record<string, ReconciliationVariant>> }
  /** platform key → intent key */
  readonly renamed: Readonly<Record<string, string>>
  /** platform key → why (the whole subtree is excluded) */
  readonly excluded: Readonly<Record<string, string>>
  /** intent key → why (the whole subtree is excluded) */
  readonly intentOnly: Readonly<Record<string, string>>
}

export const NODE_BASE_KEYS = [
  'id',
  'kind',
  'position',
  'title',
  'agentId',
] as const satisfies readonly NodeBaseKey[]

/** Common reference keys taught once by the `workflow.nodes[]` entry, not per kind. */
export const NODE_TEACHING_REFERENCE_KEYS = ['agentRef', 'workflowRef', 'workgroupRef'] as const

const NODE_BASE_EXCLUDED: Readonly<Record<string, string>> = Object.fromEntries(
  NODE_BASE_KEYS.map((key) => [key, 'node base field (see workflow.nodes[])']),
)

const STRICT_NODE_SCHEMAS: { readonly [K in keyof StrictNodeSchemaOf]: StrictNodeSchemaOf[K] } = {
  review: ReviewNodeSchema,
  clarify: ClarifyNodeSchema,
  'clarify-cross-agent': ClarifyCrossAgentNodeSchema,
  'wrapper-fanout': WrapperFanoutNodeSchema,
  'call-workflow': CallWorkflowNodeSchema,
  'call-workgroup': CallWorkgroupNodeSchema,
  script: ScriptNodeSchema,
  'code-host-call': CodeHostCallNodeSchema,
}

const NONE: Readonly<Record<string, string>> = {}

const strictNodeEntries: ReconciliationEntry[] = (
  Object.keys(STRICT_NODE_SCHEMAS) as (keyof StrictNodeSchemaOf)[]
).map((kind) => ({
  id: `workflow.nodes[${kind}]`,
  resourceType: 'workflow',
  platform: { paths: [], schema: STRICT_NODE_SCHEMAS[kind] },
  intent: { paths: [], table: 'INTENT_NODE_TEACHING', select: kind },
  renamed: NONE,
  // only the base keys this kind's schema actually carries (review has no agentId)
  excluded: Object.fromEntries(
    Object.entries(NODE_BASE_EXCLUDED).filter(([key]) =>
      schemaKeys(STRICT_NODE_SCHEMAS[kind]).includes(key),
    ),
  ),
  intentOnly: NONE,
}))

const intentWorkgroupShape = IntentWorkgroupPayloadSchema.innerType().shape

export const INTENT_PLATFORM_FIELD_RECONCILIATION: readonly ReconciliationEntry[] = [
  {
    id: 'agent.root',
    resourceType: 'agent',
    platform: { paths: [''], schema: CreateAgentSchema },
    intent: { paths: [''], schema: IntentAgentPayloadSchema },
    renamed: NONE,
    excluded: { network: 'RFC-276 tombstone (`z.never()`)' },
    intentOnly: NONE,
  },
  {
    id: 'agent.inputs[]',
    resourceType: 'agent',
    platform: { paths: ['inputs[]'], schema: AgentInputPortSchema },
    intent: { paths: ['inputs[]'], schema: elementSchemaOf(IntentAgentPayloadSchema.shape.inputs) },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'agent.skills[project]',
    resourceType: 'agent',
    platform: { paths: ['skills[]<project>'], schema: AgentSkillRefSchema.options[1] },
    intent: {
      paths: ['skills[]'],
      schema: objectOptionOf(elementSchemaOf(IntentAgentPayloadSchema.shape.skills)),
    },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'plugin.root',
    resourceType: 'plugin',
    platform: { paths: [''], schema: CreatePluginSchema },
    intent: { paths: [''], schema: IntentPluginPayloadSchema },
    renamed: { options: 'optionsJson' },
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'skill.root',
    resourceType: 'skill',
    platform: { paths: [''], schema: CreateManagedSkillSchema },
    intent: { paths: [''], schema: IntentSkillPayloadSchema },
    renamed: NONE,
    excluded: NONE,
    intentOnly: {
      files:
        'auxiliary skill files (RFC-234 T1) — written by the apply seam, not a create-schema field',
    },
  },
  {
    id: 'mcp.local.root',
    resourceType: 'mcp',
    platform: { paths: ['<local>'], schema: CreateMcpSchema.options[0] },
    intent: { paths: ['<local>'], schema: IntentMcpPayloadSchema.options[0] },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'mcp.remote.root',
    resourceType: 'mcp',
    platform: { paths: ['<remote>'], schema: CreateMcpSchema.options[1] },
    intent: { paths: ['<remote>'], schema: IntentMcpPayloadSchema.options[1] },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'mcp.local.config',
    resourceType: 'mcp',
    platform: { paths: ['<local>.config'], schema: McpLocalConfigSchema },
    intent: { paths: ['<local>.config'], schema: IntentMcpPayloadSchema.options[0].shape.config },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'mcp.remote.config',
    resourceType: 'mcp',
    platform: { paths: ['<remote>.config'], schema: McpRemoteConfigSchema },
    intent: { paths: ['<remote>.config'], schema: IntentMcpPayloadSchema.options[1].shape.config },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'mcp.remote.config.oauth',
    resourceType: 'mcp',
    platform: { paths: ['<remote>.config.oauth'], schema: McpOAuthConfigSchema },
    intent: { paths: ['<remote>.config.oauth'], schema: IntentMcpOAuthConfigSchema },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.root',
    resourceType: 'workflow',
    platform: { paths: [''], schema: CreateWorkflowSchema },
    intent: { paths: [''], schema: IntentWorkflowPayloadSchema },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.definition',
    resourceType: 'workflow',
    platform: { paths: ['definition'], schema: WorkflowDefinitionSchema },
    intent: { paths: ['definition'], schema: IntentWorkflowDefinitionSchema },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.inputs[]',
    resourceType: 'workflow',
    platform: { paths: ['definition.inputs[]'], schema: WorkflowInputSchema },
    intent: { paths: [], table: 'WORKFLOW_INPUT_TEACHING', select: 'base' },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.inputs[upload]',
    resourceType: 'workflow',
    platform: { paths: [], schema: UploadInputSchema },
    intent: { paths: [], table: 'WORKFLOW_INPUT_TEACHING', select: 'upload' },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.nodes[]',
    resourceType: 'workflow',
    platform: { paths: ['definition.nodes[]'], schema: WorkflowNodeSchema },
    intent: { paths: ['definition.nodes[]'], schema: IntentWorkflowNodeSchema },
    renamed: { agentId: 'agentRef' },
    excluded: {
      position:
        'taught in the common node sentence (every node may carry position/title); its XY object is an excluded subtree',
      title: 'taught in the common node sentence (every node may carry position/title)',
    },
    intentOnly: {
      workflowRef: 'call-node precise binding (RFC-291 面 E)',
      workgroupRef: 'call-node precise binding (RFC-291 面 E)',
    },
  },
  ...strictNodeEntries,
  {
    id: 'workflow.portRef',
    resourceType: 'workflow',
    platform: {
      paths: [
        'definition.edges[].source',
        'definition.edges[].target',
        'definition.outputs[].bind',
      ],
      schema: PortRefSchema,
    },
    intent: { paths: [], table: 'WORKFLOW_PORT_REF_TEACHING' },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.edges[]',
    resourceType: 'workflow',
    platform: { paths: ['definition.edges[]'], schema: WorkflowEdgeSchema },
    intent: { paths: [], table: 'WORKFLOW_EDGE_TEACHING' },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workflow.outputs[]',
    resourceType: 'workflow',
    platform: { paths: ['definition.outputs[]'], schema: WorkflowOutputBindingSchema },
    intent: { paths: [], table: 'WORKFLOW_OUTPUT_TEACHING' },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workgroup.root',
    resourceType: 'workgroup',
    platform: { paths: [''], schema: CreateWorkgroupSchema },
    intent: { paths: [''], schema: IntentWorkgroupPayloadSchema },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workgroup.members[]',
    resourceType: 'workgroup',
    platform: { paths: ['members[]'], schema: WorkgroupMemberInputSchema },
    intent: {
      variants: {
        agent: {
          paths: ['members[]<agent>'],
          schema: IntentWorkgroupMemberSchema.options[0],
          renamed: { agentId: 'agentRef' },
          excluded: { userId: 'agent members carry no userId' },
        },
        human: {
          paths: ['members[]<human>'],
          schema: IntentWorkgroupMemberSchema.options[1],
          renamed: NONE,
          excluded: {
            agentId: 'human members carry no agentId',
            userId:
              'human members are placeholders in intent (never real usernames); bound to a user at confirm time',
          },
        },
      },
    },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
  {
    id: 'workgroup.switches',
    resourceType: 'workgroup',
    platform: { paths: ['switches'], schema: WorkgroupSwitchesSchema },
    intent: { paths: ['switches'], schema: intentWorkgroupShape.switches },
    renamed: NONE,
    excluded: NONE,
    intentOnly: NONE,
  },
]

/** Platform object nodes claimed by no entry and inside no excluded subtree, with the reason. */
export const RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS = {
  'agent.skills[]<managed>':
    'intent expresses a managed skill as a bare handle string (IntentRefSchema); resolved to {kind:managed, skillId} at the resolve seam',
} as const

/** Intent object nodes claimed by no entry and inside no intent-only subtree (none today). */
export const RECONCILIATION_UNCOVERED_INTENT_OBJECTS = {} as const

export const PLATFORM_CREATE_SCHEMAS: Readonly<Record<IntentResourceType, z.ZodTypeAny>> = {
  agent: CreateAgentSchema,
  skill: CreateManagedSkillSchema,
  mcp: CreateMcpSchema,
  plugin: CreatePluginSchema,
  workflow: CreateWorkflowSchema,
  workgroup: CreateWorkgroupSchema,
}

export const INTENT_PAYLOAD_SCHEMAS: Readonly<Record<IntentResourceType, z.ZodTypeAny>> = {
  agent: IntentAgentPayloadSchema,
  skill: IntentSkillPayloadSchema,
  mcp: IntentMcpPayloadSchema,
  plugin: IntentPluginPayloadSchema,
  workflow: IntentWorkflowPayloadSchema,
  workgroup: IntentWorkgroupPayloadSchema,
}

// ───────────────────────── key views ─────────────────────────

function nodeTeachingKeys(kind: string): string[] {
  const entry = (INTENT_NODE_TEACHING as Record<string, { fields?: Record<string, unknown> }>)[kind]
  if (entry?.fields === undefined) throw new Error(`no teachable fields for node kind '${kind}'`)
  return Object.keys(entry.fields).filter(
    (key) => !(NODE_TEACHING_REFERENCE_KEYS as readonly string[]).includes(key),
  )
}

export function teachingTableKeys(table: TeachingTableName, select?: string): string[] {
  switch (table) {
    case 'INTENT_NODE_TEACHING':
      if (select === undefined) throw new Error('INTENT_NODE_TEACHING needs a kind selector')
      return nodeTeachingKeys(select)
    case 'WORKFLOW_INPUT_TEACHING': {
      const base = Object.keys(WORKFLOW_INPUT_TEACHING.text.base)
      if (select === undefined || select === 'base') return base
      const kind = WORKFLOW_INPUT_TEACHING[select as WorkflowInputKind]
      if (kind === undefined) throw new Error(`unknown input kind '${select}'`)
      return [...base, ...Object.keys(kind.extra)]
    }
    case 'WORKFLOW_EDGE_TEACHING':
      return Object.keys(WORKFLOW_EDGE_TEACHING)
    case 'WORKFLOW_OUTPUT_TEACHING':
      return Object.keys(WORKFLOW_OUTPUT_TEACHING)
    case 'WORKFLOW_PORT_REF_TEACHING':
      return Object.keys(WORKFLOW_PORT_REF_TEACHING)
  }
}

// ───────────────────────── checks ─────────────────────────

export interface ReconciliationInput {
  readonly entries: readonly ReconciliationEntry[]
  readonly platformSchemas: Readonly<Record<IntentResourceType, z.ZodTypeAny>>
  readonly intentSchemas: Readonly<Record<IntentResourceType, z.ZodTypeAny>>
  readonly uncoveredPlatform: Readonly<Record<string, string>>
  readonly uncoveredIntent: Readonly<Record<string, string>>
}

export const DEFAULT_RECONCILIATION_INPUT: ReconciliationInput = {
  entries: INTENT_PLATFORM_FIELD_RECONCILIATION,
  platformSchemas: PLATFORM_CREATE_SCHEMAS,
  intentSchemas: INTENT_PAYLOAD_SCHEMAS,
  uncoveredPlatform: RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS,
  uncoveredIntent: RECONCILIATION_UNCOVERED_INTENT_OBJECTS,
}

function compareKeys(
  id: string,
  platformKeys: readonly string[],
  intentKeys: readonly string[],
  renamed: Readonly<Record<string, string>>,
  excluded: Readonly<Record<string, string>>,
  intentOnly: Readonly<Record<string, string>>,
): string[] {
  const violations: string[] = []
  const renamedValues = new Set(Object.values(renamed))
  for (const key of platformKeys) {
    if (intentKeys.includes(key) || key in renamed || key in excluded) continue
    violations.push(`${id}: platform key '${key}' is neither taught, renamed nor excluded`)
  }
  for (const key of intentKeys) {
    if (platformKeys.includes(key) || renamedValues.has(key) || key in intentOnly) continue
    violations.push(`${id}: intent key '${key}' has no platform counterpart and is not intent-only`)
  }
  for (const [from, to] of Object.entries(renamed)) {
    if (!platformKeys.includes(from))
      violations.push(`${id}: renamed key '${from}' is not a platform key`)
    if (!intentKeys.includes(to))
      violations.push(`${id}: renamed target '${to}' is not an intent key`)
  }
  for (const key of Object.keys(excluded)) {
    if (!platformKeys.includes(key))
      violations.push(`${id}: excluded key '${key}' is not a platform key`)
  }
  for (const key of Object.keys(intentOnly)) {
    if (!intentKeys.includes(key))
      violations.push(`${id}: intent-only key '${key}' is not an intent key`)
  }
  return violations
}

/** Rule 1 — per-entry, one level of key names in both directions. */
export function checkKeyReconciliation(entries: readonly ReconciliationEntry[]): string[] {
  const violations: string[] = []
  for (const entry of entries) {
    const platformKeys = schemaKeys(entry.platform.schema, `${entry.id} platform`)
    if ('variants' in entry.intent) {
      for (const [name, variant] of Object.entries(entry.intent.variants)) {
        violations.push(
          ...compareKeys(
            `${entry.id}<${name}>`,
            platformKeys,
            schemaKeys(variant.schema, `${entry.id}<${name}> intent`),
            variant.renamed,
            variant.excluded,
            entry.intentOnly,
          ),
        )
      }
      continue
    }
    const intentKeys =
      'table' in entry.intent
        ? teachingTableKeys(entry.intent.table, entry.intent.select)
        : schemaKeys(entry.intent.schema, `${entry.id} intent`)
    violations.push(
      ...compareKeys(
        entry.id,
        platformKeys,
        intentKeys,
        entry.renamed,
        entry.excluded,
        entry.intentOnly,
      ),
    )
  }
  return violations
}

function insideSubtree(path: string, base: string, key: string): boolean {
  const prefix = joinPath(base, key)
  return (
    path === prefix ||
    path.startsWith(`${prefix}.`) ||
    path.startsWith(`${prefix}[`) ||
    path.startsWith(`${prefix}<`)
  )
}

/**
 * Rule 2 — every object node in the platform trees (and the intent trees) is
 * claimed by exactly one entry, or lies in an excluded (resp. intent-only)
 * subtree, or is listed as uncovered — exactly one of the three.
 */
export function checkObjectCoverage(input: ReconciliationInput): string[] {
  const violations: string[] = []
  const sides: Array<'platform' | 'intent'> = ['platform', 'intent']
  for (const side of sides) {
    const schemas = side === 'platform' ? input.platformSchemas : input.intentSchemas
    const uncovered = side === 'platform' ? input.uncoveredPlatform : input.uncoveredIntent
    const seenUncovered = new Set<string>()
    for (const [resourceType, schema] of Object.entries(schemas) as [
      IntentResourceType,
      z.ZodTypeAny,
    ][]) {
      for (const node of walkObjectNodes(schema)) {
        const fullId = `${resourceType}.${node.path}`
        const claims: string[] = []
        let excludedBy: string | null = null
        for (const entry of input.entries) {
          if (entry.resourceType !== resourceType) continue
          if (side === 'platform') {
            if (entry.platform.paths.includes(node.path)) claims.push(entry.id)
            for (const base of entry.platform.paths) {
              for (const key of Object.keys(entry.excluded)) {
                if (insideSubtree(node.path, base, key)) excludedBy = `${entry.id}.excluded.${key}`
              }
            }
          } else {
            const intentPaths =
              'variants' in entry.intent
                ? Object.values(entry.intent.variants).flatMap((variant) => variant.paths)
                : entry.intent.paths
            if (intentPaths.includes(node.path)) claims.push(entry.id)
            for (const base of intentPaths) {
              for (const key of Object.keys(entry.intentOnly)) {
                if (insideSubtree(node.path, base, key))
                  excludedBy = `${entry.id}.intentOnly.${key}`
              }
            }
          }
        }
        const listed = fullId in uncovered
        if (listed) seenUncovered.add(fullId)
        const ways = (claims.length > 0 ? 1 : 0) + (excludedBy !== null ? 1 : 0) + (listed ? 1 : 0)
        if (claims.length > 1) {
          violations.push(
            `${side} object '${fullId}' is claimed by several entries: ${claims.join(', ')}`,
          )
        } else if (ways === 0) {
          violations.push(
            `${side} object '${fullId}' is not claimed by any entry, excluded subtree or uncovered list`,
          )
        } else if (ways > 1) {
          violations.push(
            `${side} object '${fullId}' is claimed more than one way (${[
              claims.length > 0 ? `entry ${claims[0]}` : null,
              excludedBy,
              listed ? 'uncovered list' : null,
            ]
              .filter((x) => x !== null)
              .join(' + ')})`,
          )
        }
      }
    }
    for (const id of Object.keys(uncovered)) {
      if (!seenUncovered.has(id))
        violations.push(`${side} uncovered list names '${id}', which is not an object node`)
    }
  }
  return violations
}

/** All reconciliation violations (empty = the table matches today's schemas). */
export function reconcile(input: ReconciliationInput = DEFAULT_RECONCILIATION_INPUT): string[] {
  return [...checkKeyReconciliation(input.entries), ...checkObjectCoverage(input)]
}
