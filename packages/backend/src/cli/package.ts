// RFC-271 T40–T42 —— 配置包的 CLI。
//
// **两条命令都强制 `--as-user`**，并构造与 HTTP 侧**同构**的 `Actor`。这不是形式：
// 导出的可见性判定、导入的 owner 归属与「只能覆盖自己的」全部从 actor 出，没有它
// 就没有判据可用。CLI 是本机 break-glass 通道（能读写 DB 的人本来就能改一切），
// 但**不能因此让它绕过判据** —— 那会让「导出/导入按谁的身份发生」变得不可追溯。
//
// 导出支持 `--id`：同一个 owner 可以有两个同名工作流（`workflows.name` 非唯一），
// `--type --name` 在那种情况下选不中确定的一行。

import type { DbClient } from '@/db/client'
import type { Actor } from '@/auth/actor'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { writeFileSync, readFileSync } from 'node:fs'
import {
  PackageImportReceiptSchema,
  PackagePreviewSchema,
  type BundleResourceType,
  type PackagePreview,
} from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type { ResourcePackageCatalogModule } from '@/modules/resource-catalog/public/operations'
import type {
  ApplyResourcePackage,
  ExportResourcePackage,
  InspectResourcePackage,
  PackageResourceRef,
} from '@/modules/resource-catalog/public/types'
import { invokeOperation } from '@/platform/operations/invoke'

const USAGE = `usage: agent-workflow package <export|import> --as-user <username> [options]

  package export --as-user <u> --type <agent|skill|mcp|plugin|workflow|workgroup>
                 (--id <id> | --name <name>) --out <file.zip>
      --id is REQUIRED to disambiguate when two rows share a name
      (workflows.name is NOT unique).

  package import --as-user <u> --file <file.zip>
                 (--plan <out.json> | --apply <in.json>
                  | --on-conflict <new|reuse|overwrite>)
      Two-phase by default:
        --plan  writes the decision plan (incl. human-member mappings) and
                commits NOTHING. Start here.
        --apply commits a plan you reviewed.
      --on-conflict is the one-shot escape hatch: one blanket action for every
      entry. All three are mutually exclusive, and omitting all three is an
      error — importing creates and overwrites resources, so there is no
      silent default.

  Break-glass boundary: the CLI runs on this machine's DB directly, but it
  still resolves --as-user into a real Actor and applies the SAME visibility /
  ownership rules as the HTTP API. It is not a way around them.
`

interface Parsed {
  flags: Map<string, string>
  bools: Set<string>
}

interface CliImportDecision {
  readonly localSlug: string
  readonly action: 'new' | 'reuse' | 'overwrite'
  readonly targetId?: string
  readonly finalName?: string
}

interface CliHumanMemberMapping {
  readonly workgroupSlug: string
  readonly username: string
  readonly userId?: string | null
}

interface CliPackageSecretInput {
  readonly resourceType: string
  readonly resourceName: string
  readonly field: string
  readonly value: string
}

interface PackageCommandTransport {
  findOwnedResourceIdsByName(
    actor: Actor,
    input: Readonly<{ kind: BundleResourceType; name: string }>,
  ): Promise<readonly string[]>
  stageInspect(actor: Actor, bytes: Uint8Array): InspectResourcePackage
  stageApply(
    actor: Actor,
    input: Readonly<{
      bytes: Uint8Array
      previewToken: string
      decisions: readonly CliImportDecision[]
      humanMemberMappings: readonly CliHumanMemberMapping[]
      secretInputs: readonly CliPackageSecretInput[]
    }>,
  ): ApplyResourcePackage
  stageExport(
    actor: Actor,
    input: Readonly<{
      root: PackageResourceRef
      exportedAt: number
      expect: Readonly<{
        expectedVersion?: number
        expectedContentVersion?: number
        expectedUpdatedAt?: number
        expectedAclRevision?: number
        expectedMetaRevision?: number
        expectedConfigHash?: string
      }>
    }>,
  ): ExportResourcePackage
  takeExport(packageId: string): Uint8Array
}

interface PackageCommandCatalog extends ResourcePackageCatalogModule {
  readonly transport: PackageCommandTransport
}

interface CliHumanMemberGroup {
  readonly workgroupSlug: string
  readonly username: string
  readonly displayNames: string[]
  suggestedUserId: string | null
  required: boolean
}

function groupHumanMemberSlots(slots: PackagePreview['humanMembers']): CliHumanMemberGroup[] {
  const grouped = new Map<string, CliHumanMemberGroup>()
  for (const slot of slots) {
    const key = `${slot.workgroupSlug}#${slot.username}`
    const existing = grouped.get(key)
    if (existing === undefined) {
      grouped.set(key, {
        workgroupSlug: slot.workgroupSlug,
        username: slot.username,
        displayNames: [slot.displayName],
        suggestedUserId: slot.suggestedUserId,
        required: slot.required,
      })
      continue
    }
    if (!existing.displayNames.includes(slot.displayName)) {
      existing.displayNames.push(slot.displayName)
    }
    existing.required ||= slot.required
    if (existing.suggestedUserId === null && slot.suggestedUserId !== null) {
      existing.suggestedUserId = slot.suggestedUserId
    }
  }
  return [...grouped.values()].sort((left, right) =>
    left.workgroupSlug === right.workgroupSlug
      ? left.username.localeCompare(right.username)
      : left.workgroupSlug.localeCompare(right.workgroupSlug),
  )
}

function parseArgs(args: readonly string[]): Parsed {
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      bools.add(key)
    }
  }
  return { flags, bools }
}

/**
 * The types `package export` understands.
 *
 * `BundleResourceType`, not `AclResourceType`: RFC-304's capability templates
 * have row ACLs but no bundle ops, and typing this list by the wider set is
 * what let a capability type reach the exporter as a compile-time no-op.
 */
const RESOURCE_TYPES: readonly BundleResourceType[] = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
]

export interface PackageCommandIdentityHandle {
  localIdentityForUser(userId: string): Promise<Readonly<{
    actor: Actor
    commandContext(): CommandContext
    queryContext(): QueryContext
  }> | null>
}

export interface PackageCommandBootstrap {
  readonly db: DbClient
  readonly identity: PackageCommandIdentityHandle
  readonly catalog: PackageCommandCatalog
  shutdown(): void
}

export type PackageCommandBootstrapFactory = () => Promise<PackageCommandBootstrap>

export async function packageCommand(
  args: string[],
  bootstrapFactory?: PackageCommandBootstrapFactory,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const sub = args[0]
  if (sub !== 'export' && sub !== 'import') return { output: USAGE, status: 'error' }
  const { flags } = parseArgs(args.slice(1))

  const username = flags.get('as-user')
  if (username === undefined) {
    return {
      output: '--as-user is required: every package operation happens AS someone.\n',
      status: 'error',
    }
  }

  if (bootstrapFactory === undefined) {
    return { output: 'identity-access-runtime-not-composed\n', status: 'error' }
  }

  let bootstrap: PackageCommandBootstrap | undefined
  try {
    bootstrap = await bootstrapFactory()
    const { db, identity, catalog } = bootstrap
    const row = db.select().from(users).where(eq(users.username, username)).get()
    if (row === undefined) return { output: `user '${username}' not found\n`, status: 'error' }
    // ⚠️ 与 HTTP 同构的**第二半**：HTTP 侧 session lookup 对非 active 用户返回 null，
    // 所以停用的人在网页上什么都做不了。只查「行存在」会让 CLI 给一个已停用的主体
    // 造出可写 Actor，导入的资源归到该主体名下 —— 那正是「绕过判据」。
    if (row.status !== 'active') {
      return {
        output: `user '${username}' is ${row.status}, not active: refusing to act as them\n`,
        status: 'error',
      }
    }
    // 与 HTTP 同构：bootstrap 注入的 local participant 从当前数据库访问状态解析
    // 最终 permissions + access revision；消费者不把角色当成第二条授权轴。
    const operationIdentity = await identity.localIdentityForUser(row.id)
    if (operationIdentity === null) {
      return { output: `user '${username}' is not active\n`, status: 'error' }
    }
    if (sub === 'export') return await runExport(operationIdentity, catalog, flags)
    return await runImport(operationIdentity, catalog, flags)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { output: `${e.code ?? 'error'}: ${e.message ?? String(err)}\n`, status: 'error' }
  } finally {
    bootstrap?.shutdown()
  }
}

async function runExport(
  identity: Readonly<{
    actor: Actor
    commandContext(): CommandContext
  }>,
  catalog: PackageCommandCatalog,
  flags: Map<string, string>,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  // `find` rather than a cast plus `includes`: the cast is what made this
  // compile when the ACL set grew past the packageable one, and a lookup on a
  // typed list narrows for real.
  const type = RESOURCE_TYPES.find((candidate) => candidate === flags.get('type'))
  if (type === undefined) {
    return { output: `--type must be one of ${RESOURCE_TYPES.join('|')}\n`, status: 'error' }
  }
  const out = flags.get('out')
  if (out === undefined) return { output: '--out <file.zip> is required\n', status: 'error' }

  let id = flags.get('id')
  if (id === undefined) {
    const name = flags.get('name')
    if (name === undefined)
      return { output: 'either --id or --name is required\n', status: 'error' }
    const matches = await catalog.transport.findOwnedResourceIdsByName(identity.actor, {
      kind: type,
      name,
    })
    if (matches.length === 0)
      return { output: `no ${type} named '${name}' for you\n`, status: 'error' }
    if (matches.length > 1) {
      // ⚠️ 这正是 `--id` 存在的理由：同 owner 可以有两个同名工作流。**不猜**。
      return {
        output:
          `${matches.length} ${type}s named '${name}' belong to you; pass --id to pick one:\n` +
          matches.map((match) => `  ${match}\n`).join(''),
        status: 'error',
      }
    }
    id = matches[0]!
  }

  const receipt = await invokeOperation(
    catalog.operations.exports[type],
    identity.commandContext(),
    catalog.transport.stageExport(identity.actor, {
      root: { kind: type, id },
      exportedAt: Date.now(),
      expect: {},
    }),
  )
  const bytes = catalog.transport.takeExport(receipt.packageId)
  writeFileSync(out, bytes)
  return { output: `wrote ${out} (${bytes.byteLength} bytes)\n`, status: 'ok' }
}

async function runImport(
  identity: Readonly<{
    actor: Actor
    commandContext(): CommandContext
    queryContext(): QueryContext
  }>,
  catalog: PackageCommandCatalog,
  flags: Map<string, string>,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const file = flags.get('file')
  if (file === undefined) return { output: '--file <file.zip> is required\n', status: 'error' }
  const planOut = flags.get('plan')
  const applyPath = flags.get('apply')
  const onConflict = flags.get('on-conflict')

  // 三个决策来源两两互斥。同时给就说明用户没想清楚哪个说了算——与其挑一个，
  // 不如让他明确。
  const given = [
    planOut === undefined ? null : '--plan',
    applyPath === undefined ? null : '--apply',
    onConflict === undefined ? null : '--on-conflict',
  ].filter((x): x is string => x !== null)
  if (given.length > 1) {
    return { output: `${given.join(' and ')} are mutually exclusive\n`, status: 'error' }
  }
  if (given.length === 0) {
    // ⚠️ **不默认提交**。导入会创建/覆盖资源，一个没写任何决策来源的命令最可能的
    // 意思是「我还不知道会发生什么」，而不是「照你想的全新建吧」。
    return {
      output:
        'one of --plan <out.json> / --apply <in.json> / --on-conflict <a> is required:\n' +
        '  --plan writes the decision plan and commits NOTHING (start here)\n' +
        '  --apply commits a plan you reviewed\n' +
        '  --on-conflict applies one blanket action to every entry\n',
      status: 'error',
    }
  }

  const bytes = new Uint8Array(readFileSync(file))
  const inspected = await invokeOperation(
    catalog.operations.inspect,
    identity.commandContext(),
    catalog.transport.stageInspect(identity.actor, bytes),
  )
  const previewView = await invokeOperation(
    catalog.operations.getPreview,
    identity.queryContext(),
    { previewId: inspected.previewId },
  )
  const preview = PackagePreviewSchema.parse(JSON.parse(previewView.document))
  const humanMemberGroups = groupHumanMemberSlots(preview.humanMembers)

  // ── 阶段一：只产出计划，**不提交任何东西** ──
  if (planOut !== undefined) {
    const plan = {
      // `previewToken` 与 `importId` 一起写进计划：`--apply` 消费的是**这一次**
      // 预检的基线，不是重新算一遍——重算等于让「用户复核过的那份」失去意义。
      previewToken: preview.previewToken,
      entries: preview.entries.map((e) => ({
        localSlug: e.localSlug,
        type: e.type,
        name: e.name,
        allowedActions: e.allowedActions,
        candidates: e.candidates.map((c) => ({ id: c.id, name: c.name, owned: c.owned })),
        // 预填一个**合法**的建议动作，用户改的是这一行。
        action: e.allowedActions.includes('reuse') ? 'reuse' : e.allowedActions[0],
        targetId: e.candidates[0]?.id,
        finalName: e.suggestedName,
      })),
      // 同一源用户可能以多个 alias 出现：映射按 `(workgroupSlug, username)` 只写一条，
      // alias 全量保留在 `displayNames` 供人工复核；`userId: null` = 全部不加入。
      humanMemberMappings: humanMemberGroups.map((m) => ({
        workgroupSlug: m.workgroupSlug,
        username: m.username,
        // 保留旧计划读取器用的单值字段，并新增不丢 alias 的完整列表。
        displayName: m.displayNames[0],
        displayNames: m.displayNames,
        required: m.required,
        userId: m.suggestedUserId,
      })),
    }
    writeFileSync(planOut, `${JSON.stringify(plan, null, 2)}\n`)
    return {
      output:
        `wrote ${planOut} (${plan.entries.length} entr${plan.entries.length === 1 ? 'y' : 'ies'}); nothing committed.\n` +
        `review it, then: agent-workflow package import --as-user … --file ${file} --apply ${planOut}\n`,
      status: 'ok',
    }
  }

  let decisions: CliImportDecision[]
  let previewToken = preview.previewToken
  let humanMemberMappings: CliHumanMemberMapping[] = humanMemberGroups.map((m) => ({
    workgroupSlug: m.workgroupSlug,
    username: m.username,
    userId: m.suggestedUserId,
  }))
  if (applyPath !== undefined) {
    const saved = JSON.parse(readFileSync(applyPath, 'utf8')) as {
      previewToken?: string
      entries?: CliImportDecision[]
      humanMemberMappings?: Array<{
        workgroupSlug: string
        username: string
        userId?: string | null
      }>
    }
    // 计划里带的 token 是权威：它把用户**复核过的那份基线**签死了。
    if (typeof saved.previewToken === 'string') previewToken = saved.previewToken
    decisions = saved.entries ?? []
    if (saved.humanMemberMappings !== undefined) humanMemberMappings = saved.humanMemberMappings
  } else {
    const want = onConflict
    decisions = preview.entries.map((e) => {
      // 一刀切的默认值也要落在**允许**的动作里：例如别人的资源没有 overwrite，
      // 那就退回 reuse（能看见即可复用），再退回 new。
      const action = e.allowedActions.includes(want as never)
        ? (want as CliImportDecision['action'])
        : e.allowedActions.includes('reuse')
          ? 'reuse'
          : 'new'
      return action === 'new'
        ? { localSlug: e.localSlug, action, finalName: e.suggestedName }
        : { localSlug: e.localSlug, action, targetId: e.candidates[0]?.id }
    })
  }

  const applied = await invokeOperation(
    catalog.operations.apply,
    identity.commandContext(),
    catalog.transport.stageApply(identity.actor, {
      bytes,
      previewToken,
      decisions,
      humanMemberMappings,
      secretInputs: [],
    }),
  )
  const receiptView = await invokeOperation(
    catalog.operations.getReceipt,
    identity.queryContext(),
    { receiptId: applied.receiptId },
  )
  const receipt = PackageImportReceiptSchema.parse(JSON.parse(receiptView.document))
  return {
    output:
      `imported ${receipt.applied.length} resource(s)\n` +
      receipt.applied.map((a) => `  ${a.resourceType} ${a.name} (${a.action})\n`).join(''),
    status: 'ok',
  }
}
