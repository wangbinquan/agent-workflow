// RFC-112 PR-A — runtime registry: named runtime instances {name, protocol,
// binaryPath} backed by the `runtimes` table. The two built-ins (opencode,
// claude-code) are framework-seeded (builtin=1, read-only). agents.runtime /
// config.defaultRuntime reference a row by name; this module resolves a name to
// a (protocol, binary) for dispatch and owns CRUD + the read-only / in-use /
// name guards. Admin-managed (the route layer enforces requireAdmin); there is
// no per-user ACL — a runtime is machine-level config including a local binary
// path (RFC-112 D3).

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, runtimes } from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import type { RuntimeKind } from '@/services/runtime'
import { createLogger } from '@/util/log'

const log = createLogger('runtimeRegistry')

export const RUNTIME_PROTOCOLS = ['opencode', 'claude-code'] as const
export type RuntimeProtocol = (typeof RUNTIME_PROTOCOLS)[number]

/** The two framework built-ins — reserved names + seeded read-only rows. */
export const BUILTIN_RUNTIMES: ReadonlyArray<{ name: string; protocol: RuntimeProtocol }> = [
  { name: 'opencode', protocol: 'opencode' },
  { name: 'claude-code', protocol: 'claude-code' },
]
const BUILTIN_NAMES = new Set(BUILTIN_RUNTIMES.map((b) => b.name))

/** RFC-112 Codex P3: runtime names are lowercase, URL-safe (used in /:name routes). */
export const RUNTIME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

export interface RuntimeRow {
  id: string
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  builtin: boolean
  lastProbeJson: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export interface ResolvedRuntime {
  name: string
  protocol: RuntimeKind
  binaryPath: string | null
}

export interface RuntimeView {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  builtin: boolean
  lastProbe: unknown
  createdAt: number
  updatedAt: number
}

/**
 * Public view of a row for the HTTP layer — parses the cached probe JSON back to
 * an object. Lives here (not in the route) so the route file stays free of the
 * `as` cast the RFC-054 W1-7 guard bans; this is our own serialized data, not
 * unvalidated user input.
 */
export function runtimeRowToView(row: RuntimeRow): RuntimeView {
  let lastProbe: unknown = null
  if (row.lastProbeJson !== null) {
    try {
      lastProbe = JSON.parse(row.lastProbeJson)
    } catch {
      lastProbe = null
    }
  }
  return {
    name: row.name,
    protocol: row.protocol,
    binaryPath: row.binaryPath,
    builtin: row.builtin,
    lastProbe,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// --- reads -----------------------------------------------------------------

export async function listRuntimes(db: DbClient): Promise<RuntimeRow[]> {
  return (await db.select().from(runtimes)) as RuntimeRow[]
}

export async function getRuntime(db: DbClient, name: string): Promise<RuntimeRow | null> {
  const row = (await db.select().from(runtimes).where(eq(runtimes.name, name)).limit(1))[0]
  return (row as RuntimeRow | undefined) ?? null
}

// --- resolution (name → protocol + binary) ---------------------------------

/**
 * Resolve a runtime NAME to its (protocol, binaryPath). Unknown / empty name
 * fail-safe to the built-in opencode (+ warn) so a dangling agent.runtime can't
 * brick a dispatch. db-aware (custom names aren't derivable from the string).
 */
export async function resolveRuntimeByName(
  db: DbClient,
  name: string | null | undefined,
): Promise<ResolvedRuntime> {
  const n = typeof name === 'string' && name.length > 0 ? name : null
  if (n !== null) {
    const row = await getRuntime(db, n)
    if (row !== null) return { name: row.name, protocol: row.protocol, binaryPath: row.binaryPath }
    // RFC-112: the two built-in NAMES resolve to their protocol (default binary)
    // even when the registry row isn't seeded — so RFC-111 'opencode' /
    // 'claude-code' values keep working in any context (tests, a dispatch that
    // races startup seeding). Only CUSTOM names require a registered row.
    if (n === 'opencode' || n === 'claude-code') {
      return { name: n, protocol: n, binaryPath: null }
    }
    log.warn('runtime-name-unknown-fallback-opencode', { name: n })
  }
  return { name: 'opencode', protocol: 'opencode', binaryPath: null }
}

/** agent.runtime ?? config.defaultRuntime ?? 'opencode', resolved to a row. */
export async function resolveAgentRuntime(
  db: DbClient,
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
): Promise<ResolvedRuntime> {
  const pick = (v: string | null | undefined): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  return resolveRuntimeByName(db, pick(agentRuntime) ?? pick(defaultRuntime) ?? 'opencode')
}

/**
 * The argv head for a resolved runtime: the custom binary if set, else the
 * protocol's default (RFC-111 behavior — opencode: config.opencodePath/PATH,
 * claude: config.claudeCodePath/PATH).
 */
export function runtimeHead(
  resolved: ResolvedRuntime,
  config: { opencodePath?: string | null; claudeCodePath?: string | null },
): string[] {
  if (resolved.binaryPath !== null && resolved.binaryPath.length > 0) return [resolved.binaryPath]
  if (resolved.protocol === 'opencode')
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
}

// --- guards ----------------------------------------------------------------

export function assertNotBuiltinRuntime(row: Pick<RuntimeRow, 'builtin' | 'name'>): void {
  if (row.builtin) {
    throw new ForbiddenError(
      'runtime-builtin-readonly',
      `runtime '${row.name}' is a built-in framework runtime and is read-only`,
    )
  }
}

function validateName(name: string): void {
  if (!RUNTIME_NAME_RE.test(name))
    throw new ValidationError(
      'runtime-name-invalid',
      'runtime name must be lowercase URL-safe (^[a-z0-9][a-z0-9-]{0,30}$)',
    )
  if (BUILTIN_NAMES.has(name))
    throw new ConflictError(
      'runtime-name-reserved',
      `'${name}' is a reserved built-in runtime name`,
    )
}

function validateProtocol(protocol: string): asserts protocol is RuntimeProtocol {
  if (!RUNTIME_PROTOCOLS.includes(protocol as RuntimeProtocol))
    throw new ValidationError(
      'runtime-protocol-invalid',
      `protocol must be one of ${RUNTIME_PROTOCOLS.join(' | ')}`,
    )
}

/** RFC-112 Codex P3: a single executable path, not a shell string with args. */
function validateBinaryPath(binaryPath: string | null | undefined): string | null {
  if (binaryPath === null || binaryPath === undefined) return null
  const p = binaryPath.trim()
  if (p.length === 0) return null
  if (/[\n\r]/.test(p))
    throw new ValidationError('runtime-binary-invalid', 'binaryPath must be a single path')
  return p
}

/** Rows that reference a runtime name (block delete to avoid dangling refs). */
export async function findRuntimeReferences(
  db: DbClient,
  name: string,
  defaultRuntimeName: string | null | undefined,
): Promise<{ agentNames: string[]; isDefault: boolean }> {
  const refAgents = (await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.runtime, name))) as { name: string }[]
  return { agentNames: refAgents.map((a) => a.name), isDefault: defaultRuntimeName === name }
}

// --- CRUD ------------------------------------------------------------------

export interface CreateRuntimeInput {
  name: string
  protocol: string
  binaryPath?: string | null
  lastProbeJson?: string | null
  createdBy?: string | null
}

export async function createRuntime(db: DbClient, input: CreateRuntimeInput): Promise<RuntimeRow> {
  validateName(input.name)
  validateProtocol(input.protocol)
  const binaryPath = validateBinaryPath(input.binaryPath)
  const existing = await getRuntime(db, input.name)
  if (existing !== null)
    throw new ConflictError('runtime-exists', `runtime '${input.name}' already exists`)
  await db.insert(runtimes).values({
    id: ulid(),
    name: input.name,
    protocol: input.protocol as RuntimeProtocol,
    binaryPath,
    builtin: false,
    lastProbeJson: input.lastProbeJson ?? null,
    createdBy: input.createdBy ?? null,
  })
  const row = await getRuntime(db, input.name)
  if (row === null) throw new Error('runtime insert vanished')
  return row
}

export interface UpdateRuntimeInput {
  binaryPath?: string | null
  lastProbeJson?: string | null
}

/**
 * Update a CUSTOM runtime's binary_path / cached probe. `name` and `protocol`
 * are IMMUTABLE: name is the reference key, and protocol pins the driver + the
 * frozen-session id format (changing it would orphan resumable node_runs that
 * froze the old protocol). Rename / re-flavor = delete + recreate.
 */
export async function updateRuntime(
  db: DbClient,
  name: string,
  input: UpdateRuntimeInput,
): Promise<RuntimeRow> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  assertNotBuiltinRuntime(row)
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (input.binaryPath !== undefined) patch.binaryPath = validateBinaryPath(input.binaryPath)
  if (input.lastProbeJson !== undefined) patch.lastProbeJson = input.lastProbeJson
  await db.update(runtimes).set(patch).where(eq(runtimes.name, name))
  const updated = await getRuntime(db, name)
  if (updated === null) throw new Error('runtime update vanished')
  return updated
}

/**
 * Cache a deep-smoke result onto a row's `last_probe_json` for display. Allowed
 * on BUILT-INS (unlike updateRuntime) — a probe result is advisory display, not
 * an identity edit, so it doesn't trip the read-only lock. No-op if the row is gone.
 */
export async function cacheRuntimeProbe(
  db: DbClient,
  name: string,
  lastProbeJson: string,
): Promise<void> {
  await db
    .update(runtimes)
    .set({ lastProbeJson, updatedAt: Date.now() })
    .where(eq(runtimes.name, name))
}

export async function deleteRuntime(
  db: DbClient,
  name: string,
  defaultRuntimeName: string | null | undefined,
): Promise<void> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  assertNotBuiltinRuntime(row)
  const refs = await findRuntimeReferences(db, name, defaultRuntimeName)
  if (refs.isDefault || refs.agentNames.length > 0) {
    const by = [
      refs.isDefault ? 'config.defaultRuntime' : null,
      ...refs.agentNames.map((a) => `agent '${a}'`),
    ].filter((s): s is string => s !== null)
    throw new ConflictError(
      'runtime-in-use',
      `runtime '${name}' is in use by ${by.join(', ')}; re-point them first`,
    )
  }
  await db.delete(runtimes).where(eq(runtimes.name, name))
}

// --- seed ------------------------------------------------------------------

/**
 * RFC-112 Codex P2: hard-reset the two built-in rows to their canonical shape on
 * every startup ({protocol, binary_path=NULL, builtin=1}) — NOT adopt. If a row
 * with a built-in name exists with a wrong protocol / non-null binary_path
 * (corruption, or a user who somehow acquired the reserved name), overwrite it
 * so bad state can't become immutable. Idempotent: a correct row is left alone.
 */
export async function seedBuiltinRuntimes(db: DbClient): Promise<void> {
  for (const b of BUILTIN_RUNTIMES) {
    const row = await getRuntime(db, b.name)
    if (row === null) {
      await db
        .insert(runtimes)
        .values({ id: ulid(), name: b.name, protocol: b.protocol, binaryPath: null, builtin: true })
    } else if (row.protocol !== b.protocol || row.binaryPath !== null || !row.builtin) {
      log.warn('runtime-builtin-hard-reset', {
        name: b.name,
        was: { protocol: row.protocol, binaryPath: row.binaryPath, builtin: row.builtin },
      })
      await db
        .update(runtimes)
        .set({ protocol: b.protocol, binaryPath: null, builtin: true, updatedAt: Date.now() })
        .where(eq(runtimes.name, b.name))
    }
  }
}
