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
  type LocalRefTarget,
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
  const idOfSlug = new Map<string, LocalRefTarget>()
  const targetIdOfOp = new Map<string, string>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug !== null) {
      idOfSlug.set(slug, { id: ulid(), type: resourceTypeOfOp(op) })
      continue
    }
    const target = (op as { target: string }).target
    targetIdOfOp.set(op.opId, await provider.resolveExternal(target, resourceTypeOfOp(op)))
  }

  const ctx: RefResolveCtx = {
    idOfSlug,
    resolveExternal: (ref, type) => provider.resolveExternal(ref, type),
    ...(provider.resolveBuiltin === undefined
      ? {}
      : { resolveBuiltin: (type, name) => provider.resolveBuiltin!(type, name) }),
  }

  // call 目标要写「权威名字 + id hint」，所以需要 id → name。同包目标从 payload
  // 取（它还没落库）；库里既有的行查一次。
  const nameOfId = new Map<string, string>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug === null) continue
    const name = (op.payload as { name?: unknown }).name
    const target = idOfSlug.get(slug)
    if (typeof name === 'string' && target !== undefined) nameOfId.set(target.id, name)
  }
  await loadExistingNames(db, ops, targetIdOfOp, nameOfId)

  const out: LoweredOp[] = []
  for (const op of ops) {
    const slug = opSlug(op)
    const resourceId = slug !== null ? idOfSlug.get(slug)!.id : targetIdOfOp.get(op.opId)!
    const payload = await lowerPayload(op, ctx, nameOfId, provider, slug ?? '')
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
  // ⚠️ update **目标**只是 external id 的一半来源：payload 里也会出现 `external:`
  // ——典型场景是预检把某个 call 目标选成了 reuse，于是引用方指向一个本次并不改写
  // 的既有行。只扫 target 的话，call 槽拿不到权威名字，整包在
  // `bundle-ref-invalid ... name is unknown` 上失败（一个纯 reuse 的包必然踩中）。
  for (const op of ops) {
    collectExternalRefs(op.payload, (type, id) => want(type, id))
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

/**
 * payload 里出现 `external:` 的**引用槽**（按槽位分派，不盲扫字符串——`external:`
 * 长得像的自由文本不该被当成引用，而槽位本身就带类型）。
 */
function collectExternalRefs(
  rawPayload: unknown,
  want: (type: AclResourceType, id: string) => void,
): void {
  const payload = (rawPayload ?? {}) as Record<string, unknown>
  const take = (type: AclResourceType, value: unknown): void => {
    if (typeof value !== 'string' || !value.startsWith('external:')) return
    want(type, value.slice('external:'.length))
  }
  const takeAll = (type: AclResourceType, list: unknown): void => {
    for (const v of Array.isArray(list) ? list : []) take(type, v)
  }

  takeAll('skill', payload.skills)
  takeAll('agent', payload.dependsOn)
  takeAll('mcp', payload.mcp)
  takeAll('plugin', payload.plugins)
  for (const raw of Array.isArray(payload.members) ? payload.members : []) {
    take('agent', (raw as Record<string, unknown>).agentRef)
  }
  // RFC-304 T17a — a binding points at its framework and at one agent per slot.
  // Both are refs for the same reason every other cross-resource pointer is:
  // an id from the source instance means nothing here.
  take('capability_framework', payload.frameworkRef)
  for (const slotRef of Object.values(
    (payload.agentBySlot as Record<string, unknown> | undefined) ?? {},
  )) {
    take('agent', slotRef)
  }
  const definition = payload.definition as { nodes?: unknown } | undefined
  for (const raw of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const node = raw as Record<string, unknown>
    take('agent', node.agentRef)
    take('workflow', node.workflowRef)
    take('workgroup', node.workgroupRef)
  }
}

async function lowerPayload(
  op: BundleOp,
  ctx: RefResolveCtx,
  nameOfId: Map<string, string>,
  provider: BundleApplyProvider,
  slug: string,
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
      const lowered = await Promise.all(
        members.map(async (raw) => {
          const m = raw as Record<string, unknown>
          if (m.memberType !== 'agent') {
            // human 成员带 **username**（跨实例标识）；canonical 层要的是本地
            // `userId`。原样透传会让 payload 过不了正式 schema，也会在
            // `workgroup_members` 里留一条永远解析不出人的行。
            const userId = provider.resolveHumanMember?.(slug, String(m.username ?? '')) ?? null
            // `null` = 用户在导入时选了「不加入」⇒ 整条剔除。
            if (userId === null) return null
            const { username: _username, sortOrder: _order, ...rest } = m
            return { ...rest, userId }
          }
          const agentId = await resolveIdentityRef(String(m.agentRef), 'agent', ctx)
          const { agentRef: _drop, sortOrder: _order, ...rest } = m
          return { ...rest, agentId }
        }),
      )
      const kept = lowered.filter((m) => m !== null) as Record<string, unknown>[]
      payload.members = kept
      // Bundle wire uses null for "no leader" while the canonical create/save schemas use
      // omission. Normalize that boundary here. A named leader whose member was removed (for
      // example a defensive legacy human-leader payload) is omitted for the same reason.
      if (
        payload.leaderDisplayName === null ||
        (typeof payload.leaderDisplayName === 'string' &&
          !kept.some((m) => m.displayName === payload.leaderDisplayName))
      ) {
        delete payload.leaderDisplayName
      }
      return payload
    }
    // RFC-304 T17a — a binding's two pointers become local ids.
    //
    // The applier reads `frameworkId` and `agentBySlot[slot]` as ids; the wire
    // carries refs. Without this the applier saw `undefined` and refused with
    // "this binding names framework 'undefined'", which reads as a corrupt
    // package rather than as a step nobody wrote.
    case 'capability-binding-create':
    case 'capability-binding-update': {
      payload.frameworkId = await resolveIdentityRef(
        String(payload.frameworkRef ?? ''),
        'capability_framework',
        ctx,
      )
      delete payload.frameworkRef

      const slots = (payload.agentBySlot as Record<string, unknown> | undefined) ?? {}
      const resolved: Record<string, string> = {}
      for (const [slot, ref] of Object.entries(slots)) {
        resolved[slot] = await resolveIdentityRef(String(ref ?? ''), 'agent', ctx)
      }
      payload.agentBySlot = resolved
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
