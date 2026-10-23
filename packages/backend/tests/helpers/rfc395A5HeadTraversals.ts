// RFC-395 II-a A5: byte-copied HEAD 67ab6b9ae traversals; independent compatibility oracle.
// Keep source strings intact when production collectors evolve.
export const headReferenceTraversals = {
  calls: {
    path: 'packages/shared/src/workflowCalls.ts',
    names: ['readStr', 'collectWorkflowCallRefs', 'collectWorkgroupCallRefs'],
    functions: [
      "function readStr(node: WorkflowNode, key: string): string | undefined {\n  const v = (node as unknown as Record<string, unknown>)[key]\n  return typeof v === 'string' && v.length > 0 ? v : undefined\n}",
      "export function collectWorkflowCallRefs(defn: WorkflowDefinition): WorkflowCallRef[] {\n  const out: WorkflowCallRef[] = []\n  for (const node of defn.nodes) {\n    if (node.kind !== 'call-workflow') continue\n    const workflowName = readStr(node, 'workflowName')\n    if (workflowName === undefined) continue // malformed node — validator owns the error\n    const workflowId = readStr(node, 'workflowId')\n    out.push({ nodeId: node.id, workflowName, ...(workflowId ? { workflowId } : {}) })\n  }\n  return out\n}",
      "export function collectWorkgroupCallRefs(defn: WorkflowDefinition): WorkgroupCallRef[] {\n  const out: WorkgroupCallRef[] = []\n  for (const node of defn.nodes) {\n    if (node.kind !== 'call-workgroup') continue\n    const workgroupName = readStr(node, 'workgroupName')\n    if (workgroupName === undefined) continue\n    const workgroupId = readStr(node, 'workgroupId')\n    out.push({ nodeId: node.id, workgroupName, ...(workgroupId ? { workgroupId } : {}) })\n  }\n  return out\n}",
    ],
  },
  legacy: {
    path: 'packages/backend/src/modules/resource-catalog/infrastructure/legacy/resourceRefs.ts',
    names: ['extractWorkflowAgentRefs'],
    functions: [
      "export function extractWorkflowAgentRefs(def: {\n  nodes?: ReadonlyArray<Record<string, unknown>>\n}): Set<string> {\n  const out = new Set<string>()\n  for (const node of def.nodes ?? []) {\n    if (typeof node !== 'object' || node === null) continue\n    if (node.kind !== 'agent-single') continue\n    const ref = typeof node.agentId === 'string' && node.agentId.length > 0 ? node.agentId : null\n    if (ref !== null) out.add(ref)\n  }\n  return out\n}",
    ],
  },
  validation: {
    path: 'packages/backend/src/modules/resource-catalog/application/workflows/workflowValidation.ts',
    names: ['agentReferences'],
    functions: [
      "function agentReferences(definition: WorkflowDefinition): ReadonlySet<string> {\n  const references = new Set<string>()\n  for (const node of definition.nodes ?? []) {\n    if (node.kind !== 'agent-single' || !('agentId' in node)) continue\n    if (typeof node.agentId === 'string' && node.agentId.length > 0) {\n      references.add(node.agentId)\n    }\n  }\n  return references\n}",
    ],
  },
  intent: {
    path: 'packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts',
    names: ['workflowAgentIds', 'workflowCallNames', 'assertCanonicalAgentIds'],
    functions: [
      "function workflowAgentIds(definition: WorkflowDefinition): readonly string[] {\n  return (definition.nodes ?? []).flatMap((node) =>\n    node.kind === 'agent-single' && typeof node.agentId === 'string' && node.agentId.length > 0\n      ? [node.agentId]\n      : [],\n  )\n}",
      "function workflowCallNames(\n  definition: WorkflowDefinition,\n  kind: 'call-workflow' | 'call-workgroup',\n  field: 'workflowName' | 'workgroupName',\n): readonly string[] {\n  return (definition.nodes ?? []).flatMap((node) => {\n    if (node.kind !== kind) return []\n    const value = Reflect.get(node, field)\n    return typeof value === 'string' && value.length > 0 ? [value] : []\n  })\n}",
      "function assertCanonicalAgentIds(definition: WorkflowDefinition): void {\n  const missing = (definition.nodes ?? [])\n    .filter((node) => node.kind === 'agent-single')\n    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)\n    .map((node) => node.id)\n  if (missing.length > 0) {\n    throw new ValidationError(\n      'workflow-agent-id-required',\n      'agent-single nodes require a canonical agentId',\n      { nodeIds: missing },\n    )\n  }\n}",
    ],
  },
  canonical: {
    path: 'packages/backend/src/modules/resource-catalog/infrastructure/workflowPersistence.ts',
    names: ['assertCanonicalWorkflowAgentIds'],
    functions: [
      "export function assertCanonicalWorkflowAgentIds(definition: WorkflowDefinition): void {\n  const nodeIds = (definition.nodes ?? [])\n    .filter((node) => node.kind === 'agent-single')\n    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)\n    .map((node) => node.id)\n    .sort()\n  if (nodeIds.length === 0) return\n  throw new ValidationError(\n    'workflow-agent-id-required',\n    'agent-single nodes require a canonical agentId',\n    { nodeIds },\n  )\n}",
    ],
  },
  package: {
    path: 'packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    names: ['workflowGrandfatheredReferences'],
    functions: [
      "function workflowGrandfatheredReferences(\n  definition: ReturnType<typeof WorkflowDefinitionSchema.parse>,\n): WorkflowGrandfatheredReferences {\n  const agentIds = new Set<string>()\n  const workflowIds = new Set<string>()\n  const workflowNames = new Set<string>()\n  const workgroupIds = new Set<string>()\n  const workgroupNames = new Set<string>()\n  for (const node of definition.nodes) {\n    if (node.kind === 'agent-single' && typeof node.agentId === 'string') {\n      agentIds.add(node.agentId)\n    }\n    if (node.kind === 'call-workflow') {\n      if (typeof node.workflowId === 'string') workflowIds.add(node.workflowId)\n      if (typeof node.workflowName === 'string') workflowNames.add(node.workflowName)\n    }\n    if (node.kind === 'call-workgroup') {\n      if (typeof node.workgroupId === 'string') workgroupIds.add(node.workgroupId)\n      if (typeof node.workgroupName === 'string') workgroupNames.add(node.workgroupName)\n    }\n  }\n  return Object.freeze({ agentIds, workflowIds, workflowNames, workgroupIds, workgroupNames })\n}",
    ],
  },
  closure: {
    path: 'packages/backend/src/services/resourcePackage/closure.ts',
    names: ['parseJsonArray', 'parseJsonObject', 'definitionOf', 'directRefsOf'],
    functions: [
      "function parseJsonArray(value: unknown): unknown[] {\n  if (Array.isArray(value)) return value\n  if (typeof value !== 'string') return []\n  try {\n    const parsed = JSON.parse(value)\n    return Array.isArray(parsed) ? parsed : []\n  } catch {\n    return []\n  }\n}",
      "function parseJsonObject(value: unknown): Record<string, unknown> {\n  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {\n    return value as Record<string, unknown>\n  }\n  if (typeof value !== 'string') return {}\n  try {\n    const parsed: unknown = JSON.parse(value)\n    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)\n      ? (parsed as Record<string, unknown>)\n      : {}\n  } catch {\n    return {}\n  }\n}",
      "function definitionOf(row: Record<string, unknown>): WorkflowDefinition | null {\n  const raw = row.definition\n  try {\n    const parsed = WorkflowDefinitionSchema.safeParse(\n      typeof raw === 'string' ? JSON.parse(raw) : raw,\n    )\n    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null\n  } catch {\n    return null\n  }\n}",
      "export function directRefsOf(\n  type: BundleResourceType,\n  row: Record<string, unknown>,\n): Array<{ type: BundleResourceType; id: string }> {\n  const out: Array<{ type: BundleResourceType; id: string }> = []\n  if (type === 'agent') {\n    for (const raw of parseJsonArray(row.skills)) {\n      const ref = raw as { kind?: string; skillId?: string }\n      // project 技能不是资源（无行、无 ACL）——闭包遍历必须跳过它，否则会去查一个\n      // 永远查不到的 id 然后判成「不可见」。\n      if (ref.kind === 'managed' && typeof ref.skillId === 'string') {\n        out.push({ type: 'skill', id: ref.skillId })\n      }\n    }\n    for (const id of parseJsonArray(row.dependsOn)) {\n      if (typeof id === 'string') out.push({ type: 'agent', id })\n    }\n    for (const id of parseJsonArray(row.mcp)) {\n      if (typeof id === 'string') out.push({ type: 'mcp', id })\n    }\n    for (const id of parseJsonArray(row.plugins)) {\n      if (typeof id === 'string') out.push({ type: 'plugin', id })\n    }\n    return out\n  }\n  if (type === 'workflow') {\n    const defn = definitionOf(row)\n    for (const node of defn?.nodes ?? []) {\n      const agentId = (node as unknown as { agentId?: unknown }).agentId\n      if (typeof agentId === 'string' && agentId.length > 0) {\n        out.push({ type: 'agent', id: agentId })\n      }\n    }\n    return out\n  }\n  if (type === 'capability_template') {\n    // RFC-309 — a template references only the AGENTS filling its slots. The\n    // old binding arm also had to pull in its framework, and forgetting that\n    // produced a package whose binding pointed at a template that was not in it\n    // — a defect the compiler could not see, because the extractor's default is\n    // an empty list rather than a missing case. The merge deletes that class of\n    // failure: the scripts travel in the same row.\n    for (const agentId of Object.values(parseJsonObject(row.agentBySlotJson))) {\n      if (typeof agentId === 'string' && agentId.length > 0) {\n        out.push({ type: 'agent', id: agentId })\n      }\n    }\n    return out\n  }\n  if (type === 'workgroup') {\n    // `row.members` 由 provider read adapter 在装载层补上（成员是独立表）。\n    for (const raw of parseJsonArray(row.members)) {\n      const m = raw as { memberType?: string; agentId?: string }\n      if (m.memberType === 'agent' && typeof m.agentId === 'string') {\n        out.push({ type: 'agent', id: m.agentId })\n      }\n    }\n    return out\n  }\n  return out\n}",
    ],
  },
} as const
