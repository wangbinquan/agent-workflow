// RFC-271 T9 —— **lowering**：把包里的 wire 形态降到各 canonical 服务认得的形状。
//
// 两件事：
//   ① **预铸 id**（I5）。create op 的资源 id 必须在 preflight **之前**就存在，各
//      prepare* 内核才能靠 `pendingBundleIds` 接受「同包内尚未落库的目标」。
//   ② **引用回填**。`local:` 指向同包目标 ⇒ 换成预铸 id；`external:` 交给 provider
//      解析；`project:` 与 `name:` 原样保留（见 refs.ts 的说明）。
//
// lowering 是**纯准备**：不写库、不碰 FS。它之后才轮到 prepare* / pre-stage。

import type { AclResourceType, BundleOp, BundleOpKind } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { ACL_TABLES } from '@/services/resourceAcl'
import { ValidationError } from '@/util/errors'
import { opAction, opSlug, resourceTypeOfOp, type BundleApplyProvider } from './provider'
import {
  resolveAgentSkillRef,
  resolveCallRef,
  resolveIdentityRef,
  type RefResolveCtx,
} from './refs'

export interface LoweredOp {
  opId: string
  kind: BundleOpKind
  resourceType: AclResourceType
  action: 'create' | 'update'
  /** create：预铸值；update：解析出来的既有行 id。 */
  resourceId: string
  /** 引用已回填的 payload。 */
  payload: Record<string, unknown>
  /** update op 的内容级 CAS token（create 没有）。 */
  expect?: Record<string, unknown>
}

export async function lowerBundlePayloads(
  db: DbClient,
  ops: readonly BundleOp[],
  provider: BundleApplyProvider,
): Promise<LoweredOp[]> {
  // ① 预铸 / 解析目标 id —— 必须先于任何 payload 处理，因为 payload 里的
  //    `local:` 引用要换成这一步产出的 id。
  const idOfSlug = new Map<string, string>()
  const targetIdOfOp = new Map<string, string>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug !== null) {
      idOfSlug.set(slug, ulid())
      continue
    }
    const target = (op as { target: string }).target
    targetIdOfOp.set(op.opId, await provider.resolveExternal(target, resourceTypeOfOp(op)))
  }

  const ctx: RefResolveCtx = {
    idOfSlug,
    resolveExternal: (ref, type) => provider.resolveExternal(ref, type),
  }

  // call 目标要写「权威名字 + id hint」，所以需要 id → name。同包目标从 payload
  // 取（它还没落库）；库里既有的行查一次。
  const nameOfId = new Map<string, string>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug === null) continue
    const name = (op.payload as { name?: unknown }).name
    const id = idOfSlug.get(slug)
    if (typeof name === 'string' && id !== undefined) nameOfId.set(id, name)
  }
  await loadExistingNames(db, ops, targetIdOfOp, nameOfId)

  const out: LoweredOp[] = []
  for (const op of ops) {
    const slug = opSlug(op)
    const resourceId = slug !== null ? idOfSlug.get(slug)! : targetIdOfOp.get(op.opId)!
    const payload = await lowerPayload(op, ctx, nameOfId)
    out.push({
      opId: op.opId,
      kind: op.kind,
      resourceType: resourceTypeOfOp(op),
      action: opAction(op),
      resourceId,
      payload,
      ...('expect' in op ? { expect: op.expect as Record<string, unknown> } : {}),
    })
  }
  return out
}

/** 把所有 external 目标与 external 引用指向的行的名字读进来（每类一次查询）。 */
async function loadExistingNames(
  db: DbClient,
  ops: readonly BundleOp[],
  targetIdOfOp: Map<string, string>,
  into: Map<string, string>,
): Promise<void> {
  const byType = new Map<AclResourceType, Set<string>>()
  const want = (type: AclResourceType, id: string): void => {
    const set = byType.get(type) ?? new Set<string>()
    set.add(id)
    byType.set(type, set)
  }
  for (const op of ops) {
    const id = targetIdOfOp.get(op.opId)
    if (id !== undefined) want(resourceTypeOfOp(op), id)
  }
  for (const [type, ids] of byType) {
    const table = ACL_TABLES[type]
    const rows = await db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(inArray(table.id, [...ids]))
    for (const row of rows) into.set(row.id, row.name)
  }
}

async function lowerPayload(
  op: BundleOp,
  ctx: RefResolveCtx,
  nameOfId: Map<string, string>,
): Promise<Record<string, unknown>> {
  const payload = { ...(op.payload as Record<string, unknown>) }
  switch (op.kind) {
    case 'agent-create':
    case 'agent-update': {
      const skills = asStrings(payload.skills)
      payload.skills = await Promise.all(skills.map((r) => resolveAgentSkillRef(r, ctx)))
      payload.dependsOn = await Promise.all(
        asStrings(payload.dependsOn).map((r) => resolveIdentityRef(r, 'agent', ctx)),
      )
      payload.mcp = await Promise.all(
        asStrings(payload.mcp).map((r) => resolveIdentityRef(r, 'mcp', ctx)),
      )
      payload.plugins = await Promise.all(
        asStrings(payload.plugins).map((r) => resolveIdentityRef(r, 'plugin', ctx)),
      )
      return payload
    }
    case 'workgroup-create':
    case 'workgroup-update': {
      const members = Array.isArray(payload.members) ? payload.members : []
      payload.members = await Promise.all(
        members.map(async (raw) => {
          const m = raw as Record<string, unknown>
          if (m.memberType !== 'agent') {
            // human 成员带 **username**（跨实例标识）。解析成本地 userId 是导入侧
            // 的事——这里保持原样，由 provider 决定认领策略。
            return { ...m }
          }
          const agentId = await resolveIdentityRef(String(m.agentRef), 'agent', ctx)
          const { agentRef: _drop, sortOrder: _order, ...rest } = m
          return { ...rest, agentId }
        }),
      )
      return payload
    }
    case 'workflow-create':
    case 'workflow-update': {
      payload.definition = await lowerWorkflowDefinition(
        payload.definition as Record<string, unknown>,
        ctx,
        nameOfId,
      )
      return payload
    }
    default:
      return payload
  }
}

/** 节点里的三种引用槽：`agentId`（identity）、call 目标（late-bound 名字域）。 */
async function lowerWorkflowDefinition(
  definition: Record<string, unknown>,
  ctx: RefResolveCtx,
  nameOfId: Map<string, string>,
): Promise<Record<string, unknown>> {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  const lowered = await Promise.all(
    nodes.map(async (raw) => {
      const node = { ...(raw as Record<string, unknown>) }
      if (typeof node.agentRef === 'string') {
        node.agentId = await resolveIdentityRef(node.agentRef, 'agent', ctx)
        delete node.agentRef
      }
      if (typeof node.workflowRef === 'string') {
        const resolved = await resolveCallRef(node.workflowRef, 'workflow', ctx, (id) =>
          nameOfId.get(id),
        )
        node.workflowName = resolved.name
        if (resolved.idHint !== undefined) node.workflowId = resolved.idHint
        delete node.workflowRef
      }
      if (typeof node.workgroupRef === 'string') {
        const resolved = await resolveCallRef(node.workgroupRef, 'workgroup', ctx, (id) =>
          nameOfId.get(id),
        )
        node.workgroupName = resolved.name
        if (resolved.idHint !== undefined) node.workgroupId = resolved.idHint
        delete node.workgroupRef
      }
      return node
    }),
  )
  return { ...definition, nodes: lowered }
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => {
    if (typeof v !== 'string') {
      throw new ValidationError('bundle-ref-invalid', 'reference slot must contain strings')
    }
    return v
  })
}

/** 单元测试用：不经 provider 解析 external 的纯 lowering（只走 local/project/name）。 */
export const __lowerPayloadForTests = lowerPayload
