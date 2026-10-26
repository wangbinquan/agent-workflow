import type { AgentSkillRef } from './schemas/agent'

/** 源 definition 解码供 II-b 转换器复用；节点兼容策略仍由收集器调用方选择。 */
export function decodeWorkflowReferenceDocument(
  value: string,
): { readonly nodes?: readonly unknown[] } | undefined {
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === 'object' && decoded !== null ? decoded : undefined
  } catch {
    return undefined
  }
}

export interface WorkflowDependencyRef {
  readonly resourceType: 'agent' | 'workflow' | 'workgroup'
  readonly selectorKind: 'id' | 'name'
  readonly value: string
  readonly namespace: 'agent' | 'workflow' | 'workgroup'
  readonly selectorDefined?: false
  readonly idCache?: string
  readonly nodeId: string
  readonly nodePath: string
  readonly referencePath: string
}

/** RFC-395 II-a A5：只收集 authored selector；解析时间和可见集合仍由调用者决定。 */
export function collectWorkflowDependencyRefs(
  definition: { readonly nodes?: readonly unknown[] },
  compatibility: {
    /** 包导出与旧反查曾读取任意 kind 上的 agentId。 */
    readonly agentOnAnyNode?: boolean
    readonly includeMissingAgentIds?: boolean
    readonly throwOnNullNode?: boolean
    readonly requireNodes?: boolean
    readonly allStringSelectors?: boolean
  } = {},
): WorkflowDependencyRef[] {
  const refs: WorkflowDependencyRef[] = []
  const nodes = compatibility.requireNodes ? definition.nodes! : (definition.nodes ?? [])
  for (const [index, value] of nodes.entries()) {
    if (value === null || value === undefined) {
      if (compatibility.throwOnNullNode) throw new TypeError('invalid workflow node')
      continue
    }
    const node = value as Record<string, unknown>
    const nodePath = `nodes[${index}]`
    const nodeId = node.id as string
    const add = (
      resourceType: WorkflowDependencyRef['resourceType'],
      field: string,
      cache?: string,
    ) => {
      const selector = node[field]
      const idCache = cache === undefined ? undefined : node[cache]
      if (
        typeof selector !== 'string' ||
        (selector.length === 0 && !compatibility.allStringSelectors)
      ) {
        if (
          !(resourceType === 'agent' && compatibility.includeMissingAgentIds) &&
          !(compatibility.allStringSelectors && typeof idCache === 'string')
        )
          return
      }
      refs.push({
        resourceType,
        selectorKind: resourceType === 'agent' ? 'id' : 'name',
        value: typeof selector === 'string' ? selector : '',
        namespace: resourceType,
        ...(typeof idCache === 'string' && (idCache.length > 0 || compatibility.allStringSelectors)
          ? { idCache }
          : {}),
        ...(typeof selector === 'string' ? {} : { selectorDefined: false as const }),
        nodeId,
        nodePath,
        referencePath: `${nodePath}.${field}`,
      })
    }
    if (node.kind === 'agent-single' || compatibility.agentOnAnyNode) add('agent', 'agentId')
    if (node.kind === 'call-workflow') add('workflow', 'workflowName', 'workflowId')
    if (node.kind === 'call-workgroup') add('workgroup', 'workgroupName', 'workgroupId')
  }
  return refs
}

export interface AgentReferences {
  readonly skills: readonly AgentSkillRef[]
  readonly dependsOn: readonly string[]
  readonly mcp: readonly string[]
  readonly plugins: readonly string[]
}

export type AgentDependencyRef =
  | {
      readonly resourceType: 'skill'
      readonly selectorKind: 'project-name'
      readonly value: string
      readonly ordinal: number
    }
  | {
      readonly resourceType: 'skill' | 'agent' | 'mcp' | 'plugin'
      readonly selectorKind: 'id'
      readonly value: string
      readonly ordinal: number
    }

/** 分 kind 的 ordinal 保留重复项；项目技能无目录行，调用者不能将其当作 skill ID。 */
export function collectAgentDependencyRefs(agent: Partial<AgentReferences>): AgentDependencyRef[] {
  return [
    ...(agent.skills ?? []).map(
      (ref, ordinal): AgentDependencyRef =>
        ref.kind === 'managed'
          ? { resourceType: 'skill', selectorKind: 'id', value: ref.skillId, ordinal }
          : { resourceType: 'skill', selectorKind: 'project-name', value: ref.name, ordinal },
    ),
    ...(agent.dependsOn ?? []).map(
      (value, ordinal): AgentDependencyRef => ({
        resourceType: 'agent',
        selectorKind: 'id',
        value,
        ordinal,
      }),
    ),
    ...(agent.mcp ?? []).map(
      (value, ordinal): AgentDependencyRef => ({
        resourceType: 'mcp',
        selectorKind: 'id',
        value,
        ordinal,
      }),
    ),
    ...(agent.plugins ?? []).map(
      (value, ordinal): AgentDependencyRef => ({
        resourceType: 'plugin',
        selectorKind: 'id',
        value,
        ordinal,
      }),
    ),
  ]
}

/** 按 kind 投影仍走同一收集器；各调用方继续决定去重和 BFS/DFS 顺序。 */
export function agentReferenceIds(
  agent: Partial<AgentReferences>,
  kind: 'agent' | 'skill' | 'mcp' | 'plugin',
): string[] {
  return collectAgentDependencyRefs(agent)
    .filter((ref) => ref.resourceType === kind && ref.selectorKind === 'id')
    .map((ref) => ref.value)
}

export function agentSkillReferences(agent: Partial<AgentReferences>): AgentSkillRef[] {
  return collectAgentDependencyRefs(agent).flatMap((ref): AgentSkillRef[] =>
    ref.resourceType !== 'skill'
      ? []
      : [
          ref.selectorKind === 'project-name'
            ? { kind: 'project', name: ref.value }
            : { kind: 'managed', skillId: ref.value },
        ],
  )
}

/** RFC-395 II-a A5：资源包旧行的源解码规则，保留旧序列化器对非数组的处理。 */
export function decodeAgentReferenceDocument(row: {
  readonly skills?: unknown
  readonly dependsOn?: unknown
  readonly mcp?: unknown
  readonly plugins?: unknown
}) {
  const decode = (value: unknown): unknown => {
    if (typeof value !== 'string') return value ?? []
    try {
      return JSON.parse(value) as unknown
    } catch {
      return []
    }
  }
  return {
    skills: decode(row.skills),
    dependsOn: decode(row.dependsOn),
    mcp: decode(row.mcp),
    plugins: decode(row.plugins),
  }
}

/** 包闭包历史上只接收字符串 ID；未知技能形状不进入依赖集。 */
export function decodeAgentReferenceDocumentForClosure(
  row: Parameters<typeof decodeAgentReferenceDocument>[0],
): AgentReferences {
  const decoded = decodeAgentReferenceDocument(row)
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter(
      (entry): entry is string => typeof entry === 'string',
    )
  return {
    skills: (Array.isArray(decoded.skills) ? decoded.skills : []).flatMap(
      (raw): AgentSkillRef[] => {
        const ref = raw as { kind?: string; skillId?: unknown }
        return ref.kind === 'managed' && typeof ref.skillId === 'string'
          ? [{ kind: 'managed', skillId: ref.skillId }]
          : []
      },
    ),
    dependsOn: strings(decoded.dependsOn),
    mcp: strings(decoded.mcp),
    plugins: strings(decoded.plugins),
  }
}

/** 包导出沿用原 String 投影；非数组仍抛出，不能在 II-a 偷换为容错空数组。 */
export function decodeAgentReferenceDocumentForExport(
  row: Parameters<typeof decodeAgentReferenceDocument>[0],
): AgentReferences {
  const decoded = decodeAgentReferenceDocument(row)
  const strings = (value: unknown): string[] => (value as unknown[]).map((entry) => String(entry))
  return {
    skills: (decoded.skills as unknown[]).map((raw): AgentSkillRef => {
      const ref = raw as { kind?: string; skillId?: unknown; name?: unknown }
      return ref.kind === 'project'
        ? { kind: 'project', name: String(ref.name ?? '') }
        : { kind: 'managed', skillId: String(ref.skillId ?? '') }
    }),
    dependsOn: strings(decoded.dependsOn),
    mcp: strings(decoded.mcp),
    plugins: strings(decoded.plugins),
  }
}

/** The canonical document and the converter use the same authored-selector index. */
export function workflowDependencyIndexEntries(definitionBytes: string) {
  const value: unknown = JSON.parse(definitionBytes)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ('nodes' in value && !Array.isArray(value.nodes))
  ) {
    throw new Error('v2-workflow-definition-shape')
  }
  const definition = value as { readonly nodes?: readonly unknown[] }
  const kinds = new Map(
    (definition.nodes ?? []).map((node, index) => [
      `nodes[${index}]`,
      node !== null && typeof node === 'object' && 'kind' in node && typeof node.kind === 'string'
        ? node.kind
        : null,
    ]),
  )
  const refs = collectWorkflowDependencyRefs(definition, {
    agentOnAnyNode: true,
    allStringSelectors: true,
  })
  if (refs.some((ref) => ref.selectorDefined === false))
    throw new Error('v2-workflow-selector-unproven')
  return refs.map((ref) => ({
    referencePath: ref.referencePath,
    resourceKind: ref.resourceType,
    selectorKind: ref.selectorKind,
    selectorValue: ref.value,
    namespaceJson: JSON.stringify({
      version: 2,
      resourceType: ref.namespace,
      referenceKind: ref.referencePath.slice(ref.nodePath.length + 1),
      nodeKind: kinds.get(ref.nodePath) ?? null,
    }),
  }))
}
