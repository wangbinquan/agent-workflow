import {
  McpLocalConfigSchema,
  McpRemoteConfigSchema,
  McpSchema,
  mcpOperationConfigHashWith,
  type CreateMcp,
  type Mcp,
} from '@agent-workflow/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { mcps } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import {
  assertInitialResourceOwner,
  initialPrivateResourceAcl,
} from '../application/resourceDefaults'
import type { McpAgentReference, McpProjection } from '../application/mcps/ports'
import type { McpCatalogResource } from '../public/types'
import { transitionMcpRuntimeTestsInTx } from './legacy/mcpRuntimeTestTransitions'

export interface McpPersistenceRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
  readonly aclRevision: number
  readonly type: string
  readonly config: string
  readonly enabled: boolean
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

export function mcpFromPersistenceRow(row: McpPersistenceRow): Mcp {
  let config: unknown
  try {
    config = JSON.parse(row.config)
  } catch {
    config = {}
  }
  const parsed = McpSchema.safeParse({ ...row, config })
  if (!parsed.success) {
    throw new ValidationError(
      'mcp-row-corrupt',
      `mcp row '${row.name}' (id=${row.id}) failed schema validation`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}

export function mcpConfigHash(mcp: Mcp): string {
  return mcpOperationConfigHashWith(mcp, sha256Hex)
}

export function mcpCatalogResource(mcp: Mcp): McpCatalogResource {
  return Object.freeze({ ...mcp, operationConfigHash: mcpConfigHash(mcp) })
}

export const mcpProjection: McpProjection = Object.freeze({
  configHashOf: mcpConfigHash,
  resourceOf: mcpCatalogResource,
})

/**
 * SQLite transaction-local mutation values retained only for the two legacy
 * aggregate adapters. Public MCP callers use the provider-neutral repository;
 * these values never cross the Resource Catalog infrastructure boundary.
 */
export interface LegacyPreparedMcpCreate {
  readonly id: string
  readonly input: CreateMcp
  readonly initialAcl: ReturnType<typeof initialPrivateResourceAcl>
  readonly now: number
}

export interface LegacyPreparedMcpUpdate {
  readonly id: string
  readonly set: Partial<typeof mcps.$inferInsert>
  readonly expectedConfigHash?: string
  readonly expectedOwnerUserId?: string | null
}

function validateConfigForType(type: 'local' | 'remote', config: unknown): void {
  const schema = type === 'local' ? McpLocalConfigSchema : McpRemoteConfigSchema
  const result = schema.safeParse(config)
  if (!result.success) {
    throw new ValidationError('mcp-config-invalid', `mcp ${type} config is invalid`, {
      issues: result.error.issues,
    })
  }
}

/** Owner-native SQLite prepare used by Intent/ResourcePackage legacy sessions. */
export async function prepareLegacyMcpCreate(
  db: DbClient,
  input: CreateMcp,
  options: { readonly ownerUserId?: string; readonly actor?: Actor | null } = {},
): Promise<LegacyPreparedMcpCreate> {
  const ownerUserId = options.ownerUserId ?? null
  assertInitialResourceOwner(options.actor, ownerUserId)
  const occupied = await db
    .select({ id: mcps.id })
    .from(mcps)
    .where(
      and(
        ownerUserId === null ? isNull(mcps.ownerUserId) : eq(mcps.ownerUserId, ownerUserId),
        eq(mcps.name, input.name),
      ),
    )
    .limit(1)
  if (occupied.length > 0) {
    throw new ConflictError('mcp-name-in-use', `mcp '${input.name}' already exists`)
  }
  validateConfigForType(input.type, input.config)
  return {
    id: ulid(),
    input,
    initialAcl: initialPrivateResourceAcl(ownerUserId),
    now: Date.now(),
  }
}

export async function loadLegacyMcpById(db: DbClient, id: string): Promise<Mcp | null> {
  const row = (await db.select().from(mcps).where(eq(mcps.id, id)).limit(1))[0]
  return row === undefined ? null : mcpFromPersistenceRow(row)
}

export function commitLegacyMcpCreateInTx(tx: DbTxSync, prepared: LegacyPreparedMcpCreate): void {
  tx.insert(mcps)
    .values({
      id: prepared.id,
      name: prepared.input.name,
      description: prepared.input.description,
      type: prepared.input.type,
      config: JSON.stringify(prepared.input.config),
      enabled: prepared.input.enabled,
      ...prepared.initialAcl,
      createdAt: prepared.now,
      updatedAt: prepared.now,
    })
    .run()
}

export function commitLegacyMcpUpdateInTx(tx: DbTxSync, prepared: LegacyPreparedMcpUpdate): void {
  const row = tx.select().from(mcps).where(eq(mcps.id, prepared.id)).get()
  if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
  if (
    prepared.expectedOwnerUserId !== undefined &&
    row.ownerUserId !== prepared.expectedOwnerUserId
  ) {
    throw staleConflictError(
      'mcp',
      'the MCP is no longer owned by the authorizing user; reload before saving',
    )
  }
  if (prepared.expectedConfigHash !== undefined) {
    const currentConfigHash = mcpConfigHash(mcpFromPersistenceRow(row))
    if (currentConfigHash !== prepared.expectedConfigHash) {
      throw staleConflictError('mcp', 'the MCP changed; reload before saving', {
        expectedConfigHash: prepared.expectedConfigHash,
        currentConfigHash,
      })
    }
  }
  tx.update(mcps).set(prepared.set).where(eq(mcps.id, prepared.id)).run()
  transitionMcpRuntimeTestsInTx(tx, {
    mcpId: prepared.id,
    reason: (prepared.set.enabled ?? row.enabled) ? 'mcp-config-changed' : 'mcp-disabled',
    now: typeof prepared.set.updatedAt === 'number' ? prepared.set.updatedAt : Date.now(),
  })
}

export interface AgentReferencePersistenceRow {
  readonly id: string
  readonly name: string
  readonly raw: unknown
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export function collectMcpAgentReferences(
  rows: readonly AgentReferencePersistenceRow[],
  mcpId: string,
): McpAgentReference[] {
  const references: McpAgentReference[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.raw)) as unknown
      if (Array.isArray(parsed) && parsed.includes(mcpId)) {
        references.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    } catch {
      // Preserve the established fail-closed behavior for corrupt legacy JSON.
    }
  }
  return references
}
