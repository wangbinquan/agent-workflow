// RFC-468 — the task runtime freeze, moved verbatim from `services/nodeRunMint.ts` (RFC-111 D15 / RFC-112 /
// RFC-113 / RFC-154 / RFC-282 C1-2). Its only production caller is this directory's task runtime bindings; the
// persistence it reads and freezes through is Runtime Management's own narrow port, which Task Execution's NodeRun
// runtime persistence satisfies (handed in by composition).
import type { RuntimeKind } from '../drivers'
import { tryGetRuntimeDriver, isKnownRuntimeKind } from '../drivers'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { RuntimeProfile, RuntimeObservationIdentity } from '../../public/types'
import { createLogger } from '@/util/log'
import type { TaskRuntimeFreezePersistence } from '../../application/ports/taskRuntimeFreezePersistence'

/** RFC-112/113: the frozen runtime snapshot a node_run dispatches/resumes on. */
export interface FrozenRuntime {
  /** RuntimeDriver kind — decides the driver + session-id format. */
  protocol: RuntimeKind
  /** The custom binary head snapshot, or null = the protocol's default binary. */
  binary: string | null
  /** RFC-113 (Codex P1-2): the execution params (model/variant/...) frozen too. */
  params: RuntimeProfile
  /**
   * RFC-154: the config-dir injection profile frozen too (sibling of `params`,
   * NOT inside it — it is a per-node-run property, not per-agent; dependents
   * share the root's config dir). Serialized as the `__configDir` key inside
   * `runtime_params_json` (no extra column); resume/retry MUST read this
   * snapshot, not the mutable runtimes row — claude especially: the session
   * transcript lives under the frozen dir, re-resolving would lose it.
   */
  configDir: RuntimeConfigDirProfile
  /** Registered identity at selection, retained through rename/delete/resume. */
  observationIdentity?: RuntimeObservationIdentity
}

function parseObservationIdentity(
  json: string | null | undefined,
): RuntimeObservationIdentity | undefined {
  try {
    const value: unknown = JSON.parse(json ?? '{}').__observation
    if (value === null || typeof value !== 'object') return undefined
    const identity = value as Partial<RuntimeObservationIdentity>
    if (
      typeof identity.registrationId !== 'string' ||
      identity.registrationId.length === 0 ||
      !Number.isSafeInteger(identity.configurationRevision) ||
      identity.configurationRevision! < 0
    )
      return undefined
    return {
      registrationId: identity.registrationId,
      configurationRevision: identity.configurationRevision!,
      ...(typeof identity.acceptedName === 'string' &&
      identity.acceptedName.length > 0 &&
      identity.acceptedName.length <= 200 &&
      identity.acceptedName.trim().length > 0
        ? { acceptedName: identity.acceptedName }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** Parse the frozen `runtime_params_json`, tolerating legacy NULL / bad JSON. */
function parseFrozenParams(json: string | null | undefined): RuntimeProfile {
  if (json != null && json.length > 0) {
    try {
      const p = JSON.parse(json) as Partial<RuntimeProfile>
      return {
        model: p.model ?? null,
        variant: p.variant ?? null,
        temperature: p.temperature ?? null,
        steps: p.steps ?? null,
        maxSteps: p.maxSteps ?? null,
        isSandbox: p.isSandbox === true,
        // 2026-08-04 — frozen extraArgs (claude fork flags). Whitelist-shape
        // checked: anything but a non-empty string[] degrades to null, so a
        // tampered/legacy JSON can never smuggle argv.
        extraArgs:
          Array.isArray(p.extraArgs) &&
          p.extraArgs.length > 0 &&
          p.extraArgs.every((t): t is string => typeof t === 'string')
            ? p.extraArgs
            : null,
      }
    } catch {
      /* fall through to empty */
    }
  }
  return {
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
    extraArgs: null,
  }
}

/**
 * RFC-154: extract the frozen `__configDir` from `runtime_params_json`. Legacy
 * rows (pre-RFC-154, no key) and bad JSON fall back to the protocol default —
 * byte-equivalent to their pre-RFC-154 behavior. Downgrade-safe the other way:
 * old parseFrozenParams whitelists its five keys, so it ignores `__configDir`.
 */
function parseFrozenConfigDir(
  json: string | null | undefined,
  protocol: RuntimeKind,
): RuntimeConfigDirProfile {
  if (json != null && json.length > 0) {
    try {
      const p = JSON.parse(json) as { __configDir?: Partial<RuntimeConfigDirProfile> }
      const cd = p.__configDir
      if (
        cd !== undefined &&
        typeof cd.env === 'string' &&
        cd.env.length > 0 &&
        typeof cd.name === 'string' &&
        cd.name.length > 0
      ) {
        return { env: cd.env, name: cd.name }
      }
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_CONFIG_DIR_PROFILE[protocol]
}

/**
 * RFC-111 D15 + RFC-112 (Codex P1) — read the (protocol, binary) frozen onto a
 * node_run, or on the FIRST dispatch (runtime still NULL) resolve the agent's
 * runtime NAME via the registry to a (protocol, binary) and freeze BOTH onto the
 * row. resume/retry read the frozen SNAPSHOT — never the mutable registry — so
 * deleting / renaming / re-pointing a runtime can't re-route a captured session
 * to the wrong driver or binary (session id + runtime are a pair, D11). An
 * unrecognized stored protocol re-resolves (forward-compatible recovery, logged).
 */

/** RFC-282 C1-2 — config-level binary fallback for the freeze, expressed via
 *  the driver's own defaultBinary (no protocol literals here): the value is
 *  frozen only when the config actually contributes a head. */
function configBackedBinary(
  protocol: string,
  binaryConfig: { opencodePath?: string | null; claudeCodePath?: string | null } | undefined,
): string | null {
  if (binaryConfig === undefined) return null
  const driver = tryGetRuntimeDriver(protocol)
  if (driver === null) return null
  const withConfig = driver.defaultBinary(binaryConfig)[0] ?? null
  const bare = driver.defaultBinary({})[0] ?? null
  return withConfig !== null && withConfig !== bare ? withConfig : null
}

/** Provider-selected runtime freeze entry; no provider client crosses it. */
export async function resolveFrozenRuntimeWith(
  persistence: TaskRuntimeFreezePersistence,
  nodeRunId: string,
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
  inheritFrom?: FrozenRuntime | null,
  binaryConfig?: { opencodePath?: string | null; claudeCodePath?: string | null },
): Promise<FrozenRuntime> {
  return persistence.withSelection(nodeRunId, async (session) => {
    const row = await session.load()
    if (row != null && isKnownRuntimeKind(row.runtime)) {
      // already frozen — return the self-contained snapshot, registry-independent.
      // Codex impl-gate P1-3 (RFC-282 收尾门): a NULL frozen binary means "no
      // explicit head was ever frozen" — pre-C1 rows never froze the config head
      // (it rode the per-entry opencodeCmd channel, read at spawn time), so NULL
      // must keep resolving against the CURRENT config or resuming such a row
      // regresses to the bare protocol command. D15 stays intact for non-NULL
      // frozen values; the stored column is not backfilled (compat read only).
      return {
        protocol: row.runtime,
        binary: row.runtimeBinary ?? configBackedBinary(row.runtime, binaryConfig),
        params: parseFrozenParams(row.runtimeParamsJson),
        configDir: parseFrozenConfigDir(row.runtimeParamsJson, row.runtime),
        observationIdentity: parseObservationIdentity(row.runtimeParamsJson),
      }
    }
    // Codex impl-gate P2-2: a NON-null stored value that isn't a known protocol
    // means corruption or a future runtime downgraded away. Re-resolve (a recovery
    // that keeps the run alive) but log loudly so it is never silent.
    if (row?.runtime != null && row.runtime !== '') {
      createLogger('nodeRunMint').warn('frozen-runtime-invalid-reresolved', {
        nodeRunId,
        stored: row.runtime,
      })
    }
    // RFC-112 P1: a resuming row inherits the session-owner's frozen snapshot so the
    // session id + (protocol, binary, params) stay consumed together across the new
    // row. RFC-113: params are part of the snapshot. RFC-154: so is configDir —
    // the resumed session's transcript/skills live under the frozen dir.
    const frozen: FrozenRuntime =
      inheritFrom != null
        ? {
            ...inheritFrom,
            // Codex impl-gate P1-2 (RFC-282 收尾门): inherit-literal callers
            // (commit/merge sessions pass a pre-resolved profile) and resume
            // inherits from pre-C1 rows carry NULL when the head used to arrive
            // via the deleted opencodeCmd channel. Fold the config head here so
            // this first freeze of the new row captures it — same semantics as
            // the fresh-resolve branch below.
            binary: inheritFrom.binary ?? configBackedBinary(inheritFrom.protocol, binaryConfig),
          }
        : await session.select(agentRuntime, defaultRuntime).then((selected) => ({
            ...selected,
            binary: selected.binary ?? configBackedBinary(selected.protocol, binaryConfig),
          }))
    await session.freeze({
      nodeRunId,
      runtime: frozen.protocol,
      runtimeBinary: frozen.binary,
      // RFC-154: __configDir rides inside the same JSON column (no new column);
      // parseFrozenParams whitelists its keys so it never leaks into params.
      runtimeParamsJson: JSON.stringify({
        ...frozen.params,
        __configDir: frozen.configDir,
        ...(frozen.observationIdentity ? { __observation: frozen.observationIdentity } : {}),
      }),
    })
    return frozen
  })
}

export async function frozenRuntimeOfSessionWith(
  persistence: TaskRuntimeFreezePersistence,
  sessionId: string,
): Promise<FrozenRuntime | null> {
  const row = await persistence.findBySessionId(sessionId)
  if (row != null && isKnownRuntimeKind(row.runtime)) {
    return {
      protocol: row.runtime,
      binary: row.runtimeBinary ?? null,
      params: parseFrozenParams(row.runtimeParamsJson),
      configDir: parseFrozenConfigDir(row.runtimeParamsJson, row.runtime),
      observationIdentity: parseObservationIdentity(row.runtimeParamsJson),
    }
  }
  return null
}
