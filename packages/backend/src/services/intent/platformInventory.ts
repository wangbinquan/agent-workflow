// RFC-348 D3 (user ruling ③) — read-only inventory of the nine PLATFORM-ONLY
// ACL resource types, one file each under `inventory/platform/<type>.md`.
//
// The intent changeset cannot create, update, mount or reference these types
// (`INTENT_RESOURCE_TYPES` is the closed roster the schema accepts), but the
// model must still SEE that they exist so it can point the user at the right
// page instead of inventing a changeset op. Rows are visibility-filtered with
// the same `filterVisibleRows` judgement the REST list endpoints use, carry no
// handle (nothing here is referenceable), and are capped per file.
//
// `PLATFORM_ONLY_INVENTORY_LOADERS satisfies Record<PlatformOnlyResourceType, …>`
// ties this file to the platform map: a tenth platform-only type fails to
// compile until it gets a loader.
//
// Composition note (RFC-294 debt, recorded in design §10): the default context
// reaches each module's own store / composition factories directly because the
// bootstrap (`server.ts`) is the only place the composed modules exist, and the
// `IntentPlatformInventory` port is how bootstrap replaces this default once it
// is wired there. Platform-provided employee tools come from the same builtin
// catalog composition the daemon uses (`composeDigitalEmployeeBuiltinToolCatalog`).

import { z } from 'zod'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  platformOnlyResourceTypes,
  type PlatformOnlyResourceType,
} from '@/modules/intent/domain/teaching/platformMap'
import { filterVisibleRows } from '@/modules/resource-catalog/public/operations'
import { listTemplateRows } from '@/services/capabilityTemplates'
import {
  listAutomationPolicies,
  listDigitalEmployees,
} from '@/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import {
  createSqliteActionTemplateStore,
  createSqliteVerificationProfileStore,
} from '@/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { createSqliteDevelopmentAdapterStore } from '@/modules/integration/infrastructure/sqliteDevelopmentAdapterStore'
import { createSqliteDigitalEmployeeAuthoringStore } from '@/modules/digital-employee/infrastructure/sqliteAuthoringStore'
import type { DigitalEmployeeAuthoringStore } from '@/modules/digital-employee/application/ports/authoringStore'
import type { DigitalEmployeePlatformToolCatalogParticipant } from '@/modules/digital-employee/public/types'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'

export interface PlatformInventoryRow {
  readonly id: string
  readonly name: string
  readonly description: string | null
}

/** The port the dump reads through; bootstrap may replace the default. */
export interface IntentPlatformInventory {
  listRows(type: PlatformOnlyResourceType, actor: Actor): Promise<PlatformInventoryRow[]>
}

export const PLATFORM_INVENTORY_ROW_CAP = 200

/** The slice of the digital-employee authoring store the loaders read. */
export type IntentEmployeeAuthoringReads = Pick<
  DigitalEmployeeAuthoringStore,
  | 'listTypePackages'
  | 'listTypePackageDescriptorJsons'
  | 'listTools'
  | 'listJobTemplates'
  | 'listEmployeeDefinitions'
>

export interface PlatformInventoryContext {
  readonly db: DbClient
  readonly actor: Actor
  readonly employeeReads: IntentEmployeeAuthoringReads
  /** Platform-provided (built-in) tools, composed from the registered type-package descriptors. */
  readonly employeeToolCatalog: (
    descriptorJsons: readonly string[],
  ) => DigitalEmployeePlatformToolCatalogParticipant
}

export interface PlatformInventoryOverrides {
  readonly employeeReads?: IntentEmployeeAuthoringReads
  readonly employeeToolCatalog?: PlatformInventoryContext['employeeToolCatalog']
}

type AclLike = {
  readonly id: string
  readonly ownerUserId?: string | null
  readonly visibility?: 'private' | 'public'
  readonly builtin?: boolean | null
}
type RawRow = AclLike & { readonly name: string; readonly description: string | null }
type Loader = (ctx: PlatformInventoryContext) => Promise<PlatformInventoryRow[]>

async function visible(
  ctx: PlatformInventoryContext,
  type: PlatformOnlyResourceType,
  rows: readonly RawRow[],
): Promise<PlatformInventoryRow[]> {
  const kept = await filterVisibleRows(ctx.db, ctx.actor, type, rows)
  return kept
    .map((row) => ({ id: row.id, name: row.name, description: row.description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function publishState(publishedRevision: number | null): string {
  return publishedRevision === null ? 'draft' : `published r${publishedRevision}`
}

/** Localized text (`{ en, zh, … }`) or a plain string → one display string. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of ['en', 'en-US', 'zh', 'zh-CN', ...Object.keys(record)]) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return null
}

const typePackageDescriptorSchema = z
  .object({
    typeRef: z.object({ typeId: z.string(), revision: z.number().int() }).passthrough(),
    authoringManifest: z
      .object({
        workItems: z.array(z.object({ workItemRef: z.string() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const catalogToolSchema = z
  .object({
    id: z.string(),
    content: z
      .object({ displayName: z.unknown().optional(), description: z.unknown().optional() })
      .passthrough()
      .optional(),
    ownerUserId: z.string().nullable().optional(),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .passthrough()

/** Every (typeRef, workItemRef) pair the registered type packages declare. */
function employeeWorkItems(ctx: PlatformInventoryContext): {
  descriptorJsons: string[]
  pairs: Array<{ typeRef: { typeId: string; revision: number }; workItemRef: string }>
} {
  const descriptorJsons = [
    ...ctx.employeeReads.listTypePackageDescriptorJsons(),
    developmentEmployeeTypePackage.descriptorJson,
  ]
  const seen = new Set<string>()
  const pairs: Array<{ typeRef: { typeId: string; revision: number }; workItemRef: string }> = []
  for (const json of descriptorJsons) {
    const parsed = typePackageDescriptorSchema.safeParse(JSON.parse(json))
    if (!parsed.success) continue
    const typeRef = { typeId: parsed.data.typeRef.typeId, revision: parsed.data.typeRef.revision }
    for (const item of parsed.data.authoringManifest?.workItems ?? []) {
      const key = `${typeRef.typeId}@${typeRef.revision}:${item.workItemRef}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ typeRef, workItemRef: item.workItemRef })
    }
  }
  return { descriptorJsons, pairs }
}

export const PLATFORM_ONLY_INVENTORY_LOADERS = {
  capability_template: async (ctx) =>
    visible(
      ctx,
      'capability_template',
      (await listTemplateRows(ctx.db)).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
        builtin: row.builtin,
      })),
    ),
  digital_employee: async (ctx) =>
    visible(
      ctx,
      'digital_employee',
      (await listDigitalEmployees(ctx.db)).map((row) => ({
        id: row.id,
        name: row.name,
        description: publishState(row.publishedRevision),
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })),
    ),
  automation_policy: async (ctx) =>
    visible(
      ctx,
      'automation_policy',
      (await listAutomationPolicies(ctx.db)).map((row) => ({
        id: row.id,
        name: row.name,
        description: publishState(row.publishedRevision),
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })),
    ),
  action_template: async (ctx) =>
    visible(
      ctx,
      'action_template',
      createSqliteActionTemplateStore(ctx.db)
        .list()
        .filter((row) => row.archivedAt === null)
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: `capability ${row.extra.capabilityId}; ${publishState(row.publishedRevision)}`,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })),
    ),
  verification_profile: async (ctx) =>
    visible(
      ctx,
      'verification_profile',
      createSqliteVerificationProfileStore(ctx.db)
        .list()
        .filter((row) => row.archivedAt === null)
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: publishState(row.publishedRevision),
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })),
    ),
  development_adapter: async (ctx) =>
    visible(
      ctx,
      'development_adapter',
      createSqliteDevelopmentAdapterStore(ctx.db)
        .list()
        .filter((row) => row.archivedAt === null)
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: row.purpose,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })),
    ),
  employee_definition: async (ctx) =>
    visible(
      ctx,
      'employee_definition',
      ctx.employeeReads.listEmployeeDefinitions(undefined).map((row) => ({
        id: row.id,
        name: row.name,
        description: `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
      })),
    ),
  employee_job_template: async (ctx) => {
    const rows: RawRow[] = []
    for (const pkg of ctx.employeeReads.listTypePackages()) {
      for (const row of ctx.employeeReads.listJobTemplates(pkg.descriptor.typeRef)) {
        rows.push({
          id: row.id,
          name: row.name,
          description:
            textOf((row.draft as { description?: unknown }).description) ??
            `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    }
    return visible(ctx, 'employee_job_template', rows)
  },
  employee_tool: async (ctx) => {
    const { descriptorJsons, pairs } = employeeWorkItems(ctx)
    const catalog = ctx.employeeToolCatalog(descriptorJsons)
    const rows = new Map<string, RawRow>()
    for (const { typeRef, workItemRef } of pairs) {
      // user-registered tools (DB) …
      for (const tool of ctx.employeeReads.listTools(typeRef, workItemRef)) {
        rows.set(tool.id, {
          id: tool.id,
          name: textOf((tool.content as { displayName?: unknown }).displayName) ?? tool.id,
          description: `${textOf((tool.content as { description?: unknown }).description) ?? 'custom tool'} (${workItemRef})`,
          ownerUserId: tool.ownerUserId,
          visibility: tool.visibility,
        })
      }
      // … plus the platform-provided catalog entries the composed module would list.
      // A DB registration with the same id wins (it is the user's edit of that tool).
      const listed = z
        .array(catalogToolSchema)
        .safeParse(JSON.parse(catalog.listJson(JSON.stringify(typeRef), workItemRef)))
      if (!listed.success) continue
      for (const tool of listed.data) {
        if (rows.has(tool.id)) continue
        rows.set(tool.id, {
          id: tool.id,
          name: textOf(tool.content?.displayName) ?? tool.id,
          description: `${textOf(tool.content?.description) ?? 'platform tool'} (${workItemRef})`,
          ownerUserId: tool.ownerUserId ?? null,
          visibility: tool.visibility ?? 'public',
          builtin: true,
        })
      }
    }
    return visible(ctx, 'employee_tool', [...rows.values()])
  },
} as const satisfies Record<PlatformOnlyResourceType, Loader>

/** The default context: this daemon's DB-backed stores + the builtin tool catalog. */
export function createDefaultIntentPlatformInventory(
  db: DbClient,
  overrides: PlatformInventoryOverrides = {},
): IntentPlatformInventory {
  const employeeReads = overrides.employeeReads ?? createSqliteDigitalEmployeeAuthoringStore(db)
  const employeeToolCatalog =
    overrides.employeeToolCatalog ??
    ((descriptorJsons: readonly string[]) =>
      composeDigitalEmployeeBuiltinToolCatalog({
        db,
        typePackageDescriptorJsons: [...descriptorJsons],
      }))
  return {
    listRows: (type, actor) =>
      PLATFORM_ONLY_INVENTORY_LOADERS[type]({ db, actor, employeeReads, employeeToolCatalog }),
  }
}

/** One `inventory/platform/<type>.md` (design §4): header with count / truncation, the rule, rows without handles. */
export function renderPlatformInventoryFile(
  type: PlatformOnlyResourceType,
  rows: readonly PlatformInventoryRow[],
  cap: number = PLATFORM_INVENTORY_ROW_CAP,
): string {
  const kept = rows.slice(0, cap)
  const dropped = rows.length - kept.length
  const lines = [
    `# ${type} (${rows.length} visible; read-only — cannot be referenced${dropped > 0 ? `; TRUNCATED — ${dropped} more not listed` : ''})`,
    '',
    'Not creatable, updatable, mountable or referenceable from a changeset — no handles. Listed so you can recognise what already exists and tell the user where it is managed (see "Platform capability map" in INTENT.md).',
    '',
    ...kept.map(
      (row) =>
        `- \`${row.name}\`${row.description === null || row.description === '' ? '' : ` — ${row.description.split('\n', 1)[0]}`}`,
    ),
  ]
  return `${lines.join('\n')}\n`
}

/** Roster order, for callers that write one file per type. */
export function platformInventoryTypes(): readonly PlatformOnlyResourceType[] {
  return platformOnlyResourceTypes()
}
