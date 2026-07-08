// RFC-112 PR-A — runtime registry: named runtime instances {name, protocol,
// binaryPath} backed by the `runtimes` table. opencode / claude-code are
// framework-seeded on first startup only (empty table, RFC-153) as ORDINARY
// editable + deletable rows. agents.runtime / config.defaultRuntime reference a
// row by name; this module resolves a name to a (protocol, binary) for dispatch
// and owns CRUD + the in-use / name guards. Admin-managed (the route layer
// enforces requireAdmin); there is
// no per-user ACL — a runtime is machine-level config including a local binary
// path (RFC-112 D3).

import { readFileSync } from 'node:fs'
import { eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, runtimes } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { RuntimeKind } from '@/services/runtime'
import { RUNTIME_KINDS } from '@/services/runtime'
import { createLogger } from '@/util/log'
import { evictOpencodeModelsCache } from '@/util/opencode-models'

const log = createLogger('runtimeRegistry')

// RFC-143: protocol IS the runtime kind — derived from the DRIVERS registry
// (single source) rather than a re-hardcoded literal set. `RuntimeProtocol`
// stays as a runtimeRegistry-local alias of RuntimeKind for call-site continuity.
export const RUNTIME_PROTOCOLS: readonly RuntimeKind[] = RUNTIME_KINDS
export type RuntimeProtocol = RuntimeKind

/** The framework built-ins — reserved names + seeded read-only rows. RFC-143:
 *  one built-in per registered kind (name === protocol === kind), derived from
 *  the DRIVERS registry so a new runtime seeds its built-in automatically. */
export const BUILTIN_RUNTIMES: ReadonlyArray<{ name: string; protocol: RuntimeProtocol }> =
  RUNTIME_KINDS.map((k) => ({ name: k, protocol: k }))
const BUILTIN_NAMES = new Set(BUILTIN_RUNTIMES.map((b) => b.name))

/** RFC-112 Codex P3: runtime names are lowercase, URL-safe (used in /:name routes). */
export const RUNTIME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

/**
 * RFC-113: the execution params a runtime spawns with (agents only SELECT a
 * runtime). variant/temperature/steps/maxSteps are opencode-only. NULL model =
 * "omit model" (a distinct profile from an explicit model).
 */
export interface RuntimeProfile {
  model: string | null
  variant: string | null
  temperature: number | null
  steps: number | null
  maxSteps: number | null
}

export interface RuntimeRow extends RuntimeProfile {
  id: string
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  /** RFC-118: false = disabled (hidden from agent/default pickers, kept in list). */
  enabled: boolean
  lastProbeJson: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export interface ResolvedRuntime extends RuntimeProfile {
  name: string
  protocol: RuntimeKind
  binaryPath: string | null
}

const NULL_PROFILE: RuntimeProfile = {
  model: null,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
}

export interface RuntimeView extends RuntimeProfile {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  /** RFC-118: false = disabled (filtered from agent/default pickers, kept in list). */
  enabled: boolean
  /** RFC-113: this row is the global default (name === config.defaultRuntime). */
  isDefault: boolean
  lastProbe: unknown
  createdAt: number
  updatedAt: number
}

/** Extract just the execution params from a row. */
export function runtimeProfileOf(row: RuntimeProfile): RuntimeProfile {
  return {
    model: row.model,
    variant: row.variant,
    temperature: row.temperature,
    steps: row.steps,
    maxSteps: row.maxSteps,
  }
}

/**
 * Public view of a row for the HTTP layer — parses the cached probe JSON back to
 * an object. Lives here (not in the route) so the route file stays free of the
 * `as` cast the RFC-054 W1-7 guard bans; this is our own serialized data, not
 * unvalidated user input. `defaultRuntimeName` (config.defaultRuntime) drives the
 * in-table default marker (RFC-113 D3/D7).
 */
export function runtimeRowToView(
  row: RuntimeRow,
  defaultRuntimeName: string | null | undefined,
): RuntimeView {
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
    enabled: row.enabled,
    isDefault: row.name === (defaultRuntimeName ?? 'opencode'),
    ...runtimeProfileOf(row),
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
    if (row !== null)
      return {
        name: row.name,
        protocol: row.protocol,
        binaryPath: row.binaryPath,
        ...runtimeProfileOf(row),
      }
    // RFC-112: a built-in NAME resolves to its protocol (default binary) even
    // when the registry row isn't seeded — so RFC-111 built-in values keep
    // working in any context (tests, a dispatch that races startup seeding).
    // Only CUSTOM names require a registered row. RFC-113: no row → no profile
    // params (NULL = the binary's own default). RFC-143: use BUILTIN_NAMES
    // (derived from DRIVERS) instead of the hand-copied kind literals.
    if (BUILTIN_NAMES.has(n)) {
      return { name: n, protocol: n as RuntimeProtocol, binaryPath: null, ...NULL_PROFILE }
    }
    log.warn('runtime-name-unknown-fallback-opencode', { name: n })
  }
  return { name: 'opencode', protocol: 'opencode', binaryPath: null, ...NULL_PROFILE }
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
 * RFC-117 — resolve the runtime for an internal framework agent (distiller /
 * commit-push), which selects a profile via a per-feature config field rather
 * than an agents-table row. Priority:
 *   1. the per-feature runtime profile NAME (e.g. `config.memoryDistillRuntime`);
 *   2. the DEPRECATED per-feature model (`config.memoryDistillModel` /
 *      `commitPushModel` / `mergeAgentModel`) — a transition fallback that keeps
 *      the prior behavior (**explicitly opencode-only**: these fields predate
 *      multi-runtime, so a bare model can only mean an opencode model) until the
 *      admin selects a profile; physical removal of the model fields is a
 *      follow-up cleanup (RFC-113→115 two-phase);
 *   3. the global `defaultRuntime` (then opencode).
 * Like `resolveAgentRuntime` (and unlike the fail-loud `validateRuntimeReference`
 * on agent save), this is fall-safe — a dangling name can't brick a background
 * job / a commit.
 *
 * RFC-143 PR-5 audit: the legacyModel branch is NOT dead code — all three
 * deprecated config fields still exist in ConfigSchema and thread here live
 * (services/launchRuntimeConfig.ts + cli/start.ts batch-import + the scheduler's
 * commit/merge dispatch). `assertConfigDefaultsMigrated` below only forces the
 * SIX generation-default keys, not these. Delete the branch only together with
 * those config fields.
 */
export async function resolveInternalAgentRuntime(
  db: DbClient,
  opts: {
    runtimeName?: string | null
    deprecatedModel?: string | null
    defaultRuntime?: string | null
  },
): Promise<ResolvedRuntime> {
  const pick = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null
  const runtimeName = pick(opts.runtimeName)
  if (runtimeName !== null) return resolveRuntimeByName(db, runtimeName)
  const legacyModel = pick(opts.deprecatedModel)
  if (legacyModel !== null) {
    return {
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
      ...NULL_PROFILE,
      model: legacyModel,
    }
  }
  return resolveAgentRuntime(db, null, opts.defaultRuntime)
}

// RFC-143: `runtimeHead` (RFC-112 PR-A) was a second copy of the per-protocol
// config-key binary pick with ZERO production callers (dispatch uses runner's
// pickRuntimeHead; the routes use resolveRuntimeBinary → driver.defaultBinary).
// Deleted — driver.defaultBinary is the single source.

// --- guards ----------------------------------------------------------------

function validateName(name: string): void {
  if (!RUNTIME_NAME_RE.test(name))
    throw new ValidationError(
      'runtime-name-invalid',
      'runtime name must be lowercase URL-safe (^[a-z0-9][a-z0-9-]{0,30}$)',
    )
  // RFC-153: opencode / claude-code are no longer reserved — they are ordinary
  // rows now, so a deleted preseeded name may be recreated (name uniqueness in
  // createRuntime still blocks a duplicate while a preseeded row exists).
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
  return {
    agentNames: refAgents.map((a) => a.name),
    // RFC-153 F1: fold an unset config default → 'opencode' (the effective default
    // that dispatch + resolveRuntimeByName fall back to) so it can't be deleted.
    isDefault: (defaultRuntimeName ?? 'opencode') === name,
  }
}

// --- CRUD ------------------------------------------------------------------

/** RFC-113: optional per-field profile params on create/update. */
export interface RuntimeProfileInput {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  maxSteps?: number | null
}

/** Validate + normalize profile params into the row columns (only present keys). */
function profilePatch(input: RuntimeProfileInput): Partial<RuntimeProfile> {
  const out: Partial<RuntimeProfile> = {}
  const str = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  if (input.model !== undefined) out.model = str(input.model)
  if (input.variant !== undefined) out.variant = str(input.variant)
  if (input.temperature !== undefined) {
    if (input.temperature !== null && (input.temperature < 0 || input.temperature > 2))
      throw new ValidationError('runtime-temperature-invalid', 'temperature must be 0–2')
    out.temperature = input.temperature
  }
  for (const k of ['steps', 'maxSteps'] as const) {
    const v = input[k]
    if (v !== undefined) {
      if (v !== null && (!Number.isInteger(v) || v < 1))
        throw new ValidationError(`runtime-${k}-invalid`, `${k} must be a positive integer`)
      out[k] = v
    }
  }
  return out
}

export interface CreateRuntimeInput extends RuntimeProfileInput {
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
    lastProbeJson: input.lastProbeJson ?? null,
    createdBy: input.createdBy ?? null,
    ...profilePatch(input),
  })
  const row = await getRuntime(db, input.name)
  if (row === null) throw new Error('runtime insert vanished')
  return row
}

export interface UpdateRuntimeInput extends RuntimeProfileInput {
  binaryPath?: string | null
  lastProbeJson?: string | null
}

/**
 * Update a runtime's binary_path / profile params / cached probe. `name` and
 * `protocol` are IMMUTABLE (the reference key + the driver/session-format pin).
 * RFC-113 D8: BUILT-INS are editable here (binary/model/params) — only their
 * identity (name/protocol) + deletion stay locked (deleteRuntime guards those).
 */
export async function updateRuntime(
  db: DbClient,
  name: string,
  input: UpdateRuntimeInput,
): Promise<RuntimeRow> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  const patch: Record<string, unknown> = { updatedAt: Date.now(), ...profilePatch(input) }
  if (input.binaryPath !== undefined) patch.binaryPath = validateBinaryPath(input.binaryPath)
  if (input.lastProbeJson !== undefined) patch.lastProbeJson = input.lastProbeJson
  await db.update(runtimes).set(patch).where(eq(runtimes.name, name))
  const updated = await getRuntime(db, name)
  if (updated === null) throw new Error('runtime update vanished')
  // RFC-114 P3-6: a changed binary makes any cached `<binary> models` stale —
  // evict the old + new path so the next list re-runs the right binary.
  if (input.binaryPath !== undefined) {
    if (row.binaryPath !== null) evictOpencodeModelsCache(row.binaryPath)
    if (updated.binaryPath !== null) evictOpencodeModelsCache(updated.binaryPath)
  }
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

/**
 * RFC-118: enable/disable a runtime. A disabled runtime STAYS in the list but
 * drops out of the agent / default-runtime pickers (frontend filter + save-time
 * guard). Built-ins MAY be disabled — EXCEPT the effective default
 * (`config.defaultRuntime ?? 'opencode'`), protected (D3) so dispatch + the
 * resolve fail-safe always have a live target. Enabling is unconditional. resolve
 * IGNORES `enabled` (D4): an in-flight agent pinning a disabled runtime keeps
 * dispatching — disabling only blocks NEW selections. Idempotent.
 */
export async function setRuntimeEnabled(
  db: DbClient,
  name: string,
  enabled: boolean,
  defaultRuntimeName: string | null | undefined,
): Promise<RuntimeRow> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  if (!enabled && name === (defaultRuntimeName ?? 'opencode')) {
    throw new ConflictError(
      'runtime-default-cannot-disable',
      `runtime '${name}' is the effective default and cannot be disabled; change the default first`,
    )
  }
  if (row.enabled === enabled) return row // no-op
  await db.update(runtimes).set({ enabled, updatedAt: Date.now() }).where(eq(runtimes.name, name))
  const updated = await getRuntime(db, name)
  if (updated === null) throw new Error('runtime enabled-toggle vanished')
  return updated
}

export async function deleteRuntime(
  db: DbClient,
  name: string,
  defaultRuntimeName: string | null | undefined,
): Promise<void> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
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
  // RFC-114 P3-6: drop this binary's cached model list.
  if (row.binaryPath !== null) evictOpencodeModelsCache(row.binaryPath)
}

// --- seed ------------------------------------------------------------------

/**
 * RFC-153: seed opencode / claude-code ONLY on a fresh (empty) runtimes table.
 * They are ordinary editable + deletable rows now — the built-in read-only flag
 * is gone. Once the table has ANY row (including the case where an admin deleted a
 * preseeded row and kept a custom one) we never re-insert, so a deletion sticks
 * across restarts. Fresh install → both rows created with NULL binary/params (the
 * config binary backfill fills binary next; model stays NULL = opencode's own
 * default). Idempotent via the empty-table guard.
 */
export async function seedBuiltinRuntimes(db: DbClient): Promise<void> {
  const existing = await db.select({ id: runtimes.id }).from(runtimes).limit(1)
  if (existing.length > 0) return
  for (const b of BUILTIN_RUNTIMES) {
    await db
      .insert(runtimes)
      .values({ id: ulid(), name: b.name, protocol: b.protocol, binaryPath: null })
  }
}

// --- RFC-113 one-time startup migrations ------------------------------------

/** RFC-113 §3.1 / RFC-115: backfill the preseeded runtimes' binary paths from
 *  config — NULL `binary_path` ONLY, so it's idempotent + never clobbers an
 *  admin-edited row. RFC-115 dropped the dead generation-param backfill
 *  (defaultModel / variant / temperature / steps / maxSteps / defaultClaudeModel
 *  are gone from config); generation params now live solely on the runtime
 *  profile rows, edited via the Settings runtime list. RFC-153 F2: names are
 *  reusable now, so match on PROTOCOL too — never write a config binary path into
 *  a user row that merely reused 'opencode' / 'claude-code' under a mismatched
 *  protocol. */
export async function migrateConfigIntoBuiltins(
  db: DbClient,
  config: {
    opencodePath?: string | null
    claudeCodePath?: string | null
  },
): Promise<void> {
  const backfillBinary = async (
    name: string,
    protocol: RuntimeProtocol,
    binaryPath: string | null | undefined,
  ) => {
    const row = await getRuntime(db, name)
    if (row === null || row.protocol !== protocol || row.binaryPath !== null || binaryPath == null)
      return
    await db
      .update(runtimes)
      .set({ binaryPath, updatedAt: Date.now() })
      .where(eq(runtimes.name, name))
  }
  await backfillBinary('opencode', 'opencode', config.opencodePath)
  await backfillBinary('claude-code', 'claude-code', config.claudeCodePath)
}

/**
 * RFC-115 (Codex impl-gate F-high): fail-loud guard for the CONFIG-only
 * skip-upgrade path — the symmetric counterpart of migration 0057's agents
 * guard. The 6 generation-default config keys (defaultModel / defaultVariant /
 * defaultTemperature / defaultSteps / defaultMaxSteps / defaultClaudeModel) were
 * dropped from ConfigSchema, so `loadConfig()` (Zod) strips them silently.
 * RFC-113 had backfilled them into the built-in runtime rows' profile. A DB that
 * jumps pre-RFC-113 → here still has those keys on disk but never ran that
 * backfill, so silently dropping them would change every inherited runtime's
 * default model (and the next config save permanently deletes them from disk).
 * We read the RAW config (Zod can't see the stripped keys) and ABORT if legacy
 * defaults are present while EVERY built-in runtime profile is still NULL
 * (un-migrated). Already-migrated DBs (a built-in profile is non-NULL) and fresh
 * installs (no legacy keys / no config file) pass through untouched.
 */
export async function assertConfigDefaultsMigrated(
  db: DbClient,
  configPath: string,
): Promise<void> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return // no / unreadable config = fresh install, nothing to migrate or lose
  }
  const LEGACY = [
    'defaultModel',
    'defaultVariant',
    'defaultTemperature',
    'defaultSteps',
    'defaultMaxSteps',
    'defaultClaudeModel',
  ] as const
  const present = LEGACY.filter((k) => raw[k] !== undefined && raw[k] !== null)
  if (present.length === 0) return
  // RFC-153 F3: `builtin` is gone + names are reusable, so only the CANONICAL
  // protocol-default rows (name === protocol, protocol immutable) prove the
  // RFC-113 backfill ran — a user row that merely reused 'opencode' must not
  // count. (In the pre-RFC-113 first-upgrade case this guard serves, the table is
  // freshly seeded this boot, so there is no user row to confuse it with.)
  const preseeded = (
    await db
      .select({
        name: runtimes.name,
        protocol: runtimes.protocol,
        model: runtimes.model,
        variant: runtimes.variant,
        temperature: runtimes.temperature,
        steps: runtimes.steps,
        maxSteps: runtimes.maxSteps,
      })
      .from(runtimes)
      .where(inArray(runtimes.name, [...BUILTIN_NAMES]))
  ).filter((r) => r.protocol === r.name)
  const anyProfileSet = preseeded.some(
    (r) =>
      r.model !== null ||
      r.variant !== null ||
      r.temperature !== null ||
      r.steps !== null ||
      r.maxSteps !== null,
  )
  // F4 (Codex gate): abort whether the built-ins are MISSING (seed failed) or all
  // their profiles are NULL (RFC-113 backfill never ran) — both mean no runtime
  // profile preserves these defaults, so loadConfig having stripped them + the
  // next config save would permanently lose them. Name both causes so the message
  // isn't misleading when the real cause is a failed seed (empty built-ins make
  // `anyProfileSet` false, which lands here exactly as the all-NULL case does).
  if (!anyProfileSet) {
    throw new Error(
      `RFC-115: config.json still has un-migrated generation defaults (${present.join(', ')}) ` +
        `but no built-in runtime profile carries them (built-in rows are missing or all-NULL). ` +
        `Either the built-in runtime seed failed or RFC-113's config→runtime backfill never ran — ` +
        `ensure the runtimes are seeded and start the RFC-113 build once to migrate them, ` +
        `or remove these keys from config.json before upgrading.`,
    )
  }
}
