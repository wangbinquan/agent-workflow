import { ulid } from 'ulid'

import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  RuntimeKind,
  RuntimeProtocol,
  RuntimeProfile,
  CreateRuntimeInput,
  UpdateRuntimeInput,
} from '../public/types'
import type {
  RuntimeRow,
  RuntimeProbeTarget,
  ResolvedRuntime,
  RuntimeRefConfig,
} from '../domain/runtimeProfile'
import { validateBinaryPath } from './runtimeBinary'
import {
  defaultConfigDirProfile,
  resolveConfigDirProfile,
  runtimeProfileOf,
  validateName,
  validateConfigDirName,
  validateConfigDirEnv,
  profilePatch,
} from '../domain/runtimeProfile'
import { createLogger } from '@/util/log'
import type {
  RuntimeRegistryOperations,
  RuntimeRegistryPersistence,
  RuntimeUpdateRecord,
} from './ports/runtimeRegistry'
import type { RuntimeRegistryEffects } from './ports/runtimeRegistryEffects'

/** The only registry application; effects are supplied by composition. */
export function createRuntimeRegistryApplication(effects: RuntimeRegistryEffects) {
  const log = createLogger('runtimeRegistry')

  // RFC-284 T19 —— registry 保持 kind-blind：二进制缓存驱逐走 driver 可选能力面
  // `evictBinaryCaches?`（对全部 driver 盲调，无缓存的 driver 缺省即跳过），不再
  // 具名依赖 opencode 的缓存实现。
  function evictDriverBinaryCaches(binaryPath: string): void {
    for (const kind of effects.protocols) effects.driver(kind).evictBinaryCaches?.(binaryPath)
  }

  // RFC-143: protocol IS the runtime kind — derived from the DRIVERS registry
  // (single source) rather than a re-hardcoded literal set. `RuntimeProtocol`
  // stays as a runtimeRegistry-local alias of RuntimeKind for call-site continuity.
  const RUNTIME_PROTOCOLS: readonly RuntimeKind[] = effects.protocols

  /** The framework-preseeded runtimes (RFC-153: ordinary rows — no longer reserved
   *  names or read-only). RFC-143: one per registered kind (name === protocol ===
   *  kind), derived from the DRIVERS registry so a new kind seeds its default. The
   *  name set also backs resolveRuntimeByName's protocol-name dispatch fallback. */
  const BUILTIN_RUNTIMES: ReadonlyArray<{ name: string; protocol: RuntimeProtocol }> =
    effects.protocols.map((k) => ({ name: k, protocol: k }))
  const BUILTIN_NAMES = new Set(BUILTIN_RUNTIMES.map((b) => b.name))

  interface RuntimeProbeReceipt {
    readonly codec: 1
    readonly target: RuntimeProbeTarget
    readonly smoke: unknown
  }

  const NULL_PROFILE: RuntimeProfile = {
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
    extraArgs: null,
  }

  /** 2026-08-04 — extraArgs write-time validation caps. */
  const RUNTIME_EXTRA_ARGS_MAX = 16
  const RUNTIME_EXTRA_ARG_MAX_LENGTH = 200

  /**
   * Validate a runtime's extraArgs and normalize to the stored JSON (or NULL).
   * Fail-closed on:
   *  - non-claude protocols (opencode's verified serve argv is sealed — no seam);
   *  - platform-owned flags (effects.ownedExtraArgFlags, exact or `=`-joined) —
   *    extraArgs must never override transport / permission shape / session
   *    identity;
   *  - a bare value token in first position or after another bare token (it
   *    would be consumed as claude's positional PROMPT argument and break the
   *    stdin prompt contract) — values are only legal directly after a `--flag`;
   *  - control characters, empties, and size caps.
   */
  function validateExtraArgs(
    protocol: RuntimeProtocol,
    input: readonly string[] | null | undefined,
  ): string | null {
    if (input == null || input.length === 0) return null
    // RFC-143 bypass-zero: capability declaration, not a protocol literal — a
    // third runtime opts in by declaring acceptsExtraArgs on its driver.
    if (effects.driver(protocol).acceptsExtraArgs !== true) {
      throw new ValidationError(
        'runtime-extra-args-protocol',
        `extraArgs is not supported by the '${protocol}' runtime driver (only drivers declaring acceptsExtraArgs consume it)`,
      )
    }
    if (input.length > RUNTIME_EXTRA_ARGS_MAX) {
      throw new ValidationError(
        'runtime-extra-args-invalid',
        `extraArgs accepts at most ${RUNTIME_EXTRA_ARGS_MAX} tokens`,
      )
    }
    let previousWasLongFlag = false
    for (const token of input) {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new ValidationError(
          'runtime-extra-args-invalid',
          'extraArgs tokens must be non-empty',
        )
      }
      if (token.length > RUNTIME_EXTRA_ARG_MAX_LENGTH) {
        throw new ValidationError(
          'runtime-extra-args-invalid',
          `extraArgs token exceeds ${RUNTIME_EXTRA_ARG_MAX_LENGTH} characters`,
        )
      }
      // eslint-disable-next-line no-control-regex -- rejecting control bytes IS the check
      if (/[\u0000-\u001f\u007f]/.test(token)) {
        throw new ValidationError(
          'runtime-extra-args-invalid',
          'extraArgs tokens must not contain control characters',
        )
      }
      const isFlag = token.startsWith('-')
      if (!isFlag && !previousWasLongFlag) {
        throw new ValidationError(
          'runtime-extra-args-invalid',
          `bare token '${token}' would be consumed as the prompt positional — values are only legal directly after a --flag`,
        )
      }
      if (isFlag) {
        const bareFlag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
        if (effects.ownedExtraArgFlags.has(bareFlag)) {
          throw new ValidationError(
            'runtime-extra-args-reserved',
            `'${bareFlag}' is platform-owned and cannot be overridden via extraArgs`,
          )
        }
      }
      previousWasLongFlag = isFlag && token.startsWith('--') && !token.includes('=')
    }
    return JSON.stringify(input)
  }

  // --- reads -----------------------------------------------------------------

  async function listRuntimes(
    persistence: RuntimeRegistryPersistence,
  ): Promise<readonly RuntimeRow[]> {
    return persistence.listRuntimes()
  }

  async function getRuntime(
    persistence: RuntimeRegistryPersistence,
    name: string,
  ): Promise<RuntimeRow | null> {
    return persistence.getRuntime(name)
  }

  // --- resolution (name → protocol + binary) ---------------------------------

  /**
   * Resolve a runtime NAME to its (protocol, binaryPath). Unknown / empty name
   * fail-safe to the built-in opencode (+ warn) so a dangling agent.runtime can't
   * brick a dispatch. db-aware (custom names aren't derivable from the string).
   */
  async function resolveRuntimeByName(
    persistence: RuntimeRegistryPersistence,
    name: string | null | undefined,
  ): Promise<ResolvedRuntime> {
    const n = typeof name === 'string' && name.length > 0 ? name : null
    if (n !== null) {
      const row = await getRuntime(persistence, n)
      if (row !== null)
        return {
          name: row.name,
          protocol: row.protocol,
          binaryPath: row.binaryPath,
          // RFC-154: fold the row's config-dir overrides over the protocol default.
          configDir: resolveConfigDirProfile(row.protocol, row.configDirEnv, row.configDirName),
          ...runtimeProfileOf(row),
        }
      // RFC-112: a built-in NAME resolves to its protocol (default binary) even
      // when the registry row isn't seeded — so RFC-111 built-in values keep
      // working in any context (tests, a dispatch that races startup seeding).
      // Only CUSTOM names require a registered row. RFC-113: no row → no profile
      // params (NULL = the binary's own default). RFC-143: use BUILTIN_NAMES
      // (derived from DRIVERS) instead of the hand-copied kind literals.
      if (BUILTIN_NAMES.has(n)) {
        return {
          name: n,
          protocol: n as RuntimeProtocol,
          binaryPath: null,
          configDir: defaultConfigDirProfile(n as RuntimeProtocol),
          ...NULL_PROFILE,
        }
      }
      log.warn('runtime-name-unknown-fallback-opencode', { name: n })
    }
    return {
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
      configDir: defaultConfigDirProfile('opencode'),
      ...NULL_PROFILE,
    }
  }

  /** agent.runtime ?? config.defaultRuntime ?? 'opencode', resolved to a row. */
  async function resolveAgentRuntime(
    persistence: RuntimeRegistryPersistence,
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<ResolvedRuntime> {
    const pick = (v: string | null | undefined): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined
    return resolveRuntimeByName(
      persistence,
      pick(agentRuntime) ?? pick(defaultRuntime) ?? 'opencode',
    )
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
  async function resolveInternalAgentRuntime(
    persistence: RuntimeRegistryPersistence,
    opts: {
      runtimeName?: string | null
      deprecatedModel?: string | null
      defaultRuntime?: string | null
    },
  ): Promise<ResolvedRuntime> {
    const pick = (v: string | null | undefined): string | null =>
      typeof v === 'string' && v.length > 0 ? v : null
    const runtimeName = pick(opts.runtimeName)
    if (runtimeName !== null) return resolveRuntimeByName(persistence, runtimeName)
    const legacyModel = pick(opts.deprecatedModel)
    if (legacyModel !== null) {
      return {
        name: 'opencode',
        protocol: 'opencode',
        binaryPath: null,
        configDir: defaultConfigDirProfile('opencode'),
        ...NULL_PROFILE,
        model: legacyModel,
      }
    }
    return resolveAgentRuntime(persistence, null, opts.defaultRuntime)
  }

  function validateProtocol(protocol: string): asserts protocol is RuntimeProtocol {
    if (!RUNTIME_PROTOCOLS.includes(protocol as RuntimeProtocol))
      throw new ValidationError(
        'runtime-protocol-invalid',
        `protocol must be one of ${RUNTIME_PROTOCOLS.join(' | ')}`,
      )
  }

  /**
   * RFC-317 T71（findings RT-01）—— 起子进程**之前**必须过的能力门。
   *
   * `acceptsExtraArgs` / `acceptsSandboxCompatibilityMarker` 是 driver 的能力声明，
   * 而在此之前它们只在**注册写路径**（createRuntime / updateRuntime）上被查过。
   * `POST /api/runtimes/probe` 与 `POST /api/runtimes` 的预检 smoke 都把**请求体里的**
   * `extraArgs` / `isSandbox` 直接交给 `smokeRuntime` 拉起真子进程，两条都绕过了这道门。
   *
   * 「只在两个入口之一被强制的能力声明不是能力，是约定」——而
   * `validateExtraArgs` 的错误文案（:218）正是拿它当能力说的：「只有声明了
   * acceptsExtraArgs 的 driver 才会消费它」。这句话对 probe 路径不成立。
   *
   * 今天这条缺口是**惰性**的：opencode 的 spawn 既不读 extraArgs 也不写 IS_SANDBOX
   * （`services/runtime/opencode/spawn.ts`），只有 claudeCode 会（`claudeCode/spawn.ts`）。
   * 但一个未来的 driver 只要开始读这两个字段，任何 `settings:write` 调用方就立刻拿到
   * 一条**未经校验的 argv / env 通道**——所以这里不等到那一天再补。
   *
   * 注册路径不改用本函数：它们各自还要做与写入相关的其它校验，且顺序有意义。
   * 本函数只承担「spawn 前的能力门」这一件事。
   */
  function assertRuntimeSpawnCapabilities(
    protocol: RuntimeProtocol,
    input: {
      readonly extraArgs?: readonly string[] | null | undefined
      readonly isSandbox?: boolean | undefined
    },
  ): void {
    validateExtraArgs(protocol, input.extraArgs)
    validateIsSandbox(protocol, input.isSandbox)
  }

  function validateIsSandbox(protocol: RuntimeProtocol, value: boolean | undefined): boolean {
    if (value === true && effects.driver(protocol).acceptsSandboxCompatibilityMarker !== true) {
      throw new ValidationError(
        'runtime-is-sandbox-unsupported',
        `isSandbox is not supported by the '${protocol}' runtime driver (only drivers declaring acceptsSandboxCompatibilityMarker consume it)`,
      )
    }
    return value === true
  }

  async function createRuntime(
    persistence: RuntimeRegistryPersistence,
    input: CreateRuntimeInput,
  ): Promise<RuntimeRow> {
    validateName(input.name)
    validateProtocol(input.protocol)
    const profile = profilePatch(input)
    const binaryPath = validateBinaryPath(input.binaryPath)
    const configDirEnv = validateConfigDirEnv(input.configDirEnv)
    const configDirName = validateConfigDirName(input.configDirName)
    const extraArgsJson = validateExtraArgs(input.protocol as RuntimeProtocol, input.extraArgs)
    const isSandbox = validateIsSandbox(input.protocol as RuntimeProtocol, input.isSandbox)
    const existing = await getRuntime(persistence, input.name)
    if (existing !== null)
      throw new ConflictError('runtime-exists', `runtime '${input.name}' already exists`)
    await persistence.insertRuntime({
      id: ulid(),
      name: input.name,
      protocol: input.protocol as RuntimeProtocol,
      binaryPath,
      configDirEnv,
      configDirName,
      extraArgsJson,
      isSandbox,
      lastProbeJson: input.lastProbeJson ?? null,
      createdBy: input.createdBy ?? null,
      ...profile,
    })
    const row = await getRuntime(persistence, input.name)
    if (row === null) throw new Error('runtime insert vanished')
    return row
  }

  type MutableRuntimeUpdateRecord = {
    -readonly [Key in keyof RuntimeUpdateRecord]: RuntimeUpdateRecord[Key]
  }

  /**
   * Update a runtime's binary_path / profile params / cached probe. `name` and
   * `protocol` are IMMUTABLE (the reference key + the driver/session-format pin).
   * RFC-113 D8: BUILT-INS are editable here (binary/model/params) — only their
   * identity (name/protocol) + deletion stay locked (deleteRuntime guards those).
   */
  async function updateRuntime(
    persistence: RuntimeRegistryPersistence,
    name: string,
    input: UpdateRuntimeInput,
  ): Promise<RuntimeRow> {
    const row = await getRuntime(persistence, name)
    if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
    const profile = profilePatch(input)
    const now = Date.now()
    const patch: MutableRuntimeUpdateRecord = {
      updatedAt: now,
      incrementProbeFence: false,
      ...profile,
    }
    let executionProfileChanged =
      (profile.model !== undefined && profile.model !== row.model) ||
      (profile.variant !== undefined && profile.variant !== row.variant) ||
      (profile.temperature !== undefined && profile.temperature !== row.temperature) ||
      (profile.steps !== undefined && profile.steps !== row.steps) ||
      (profile.maxSteps !== undefined && profile.maxSteps !== row.maxSteps)
    if (input.isSandbox !== undefined) {
      const isSandbox = validateIsSandbox(row.protocol, input.isSandbox)
      patch.isSandbox = isSandbox
      executionProfileChanged ||= isSandbox !== row.isSandbox
    }
    if (input.extraArgs !== undefined) {
      const extraArgsJson = validateExtraArgs(row.protocol, input.extraArgs)
      patch.extraArgsJson = extraArgsJson
      // Argv changes the runtime's execution meaning — invalidate cached probes.
      executionProfileChanged ||= extraArgsJson !== row.extraArgsJson
    }
    if (input.binaryPath !== undefined) {
      const binaryPath = validateBinaryPath(input.binaryPath)
      patch.binaryPath = binaryPath
      executionProfileChanged ||= binaryPath !== row.binaryPath
    }
    if (input.configDirEnv !== undefined) {
      const configDirEnv = validateConfigDirEnv(input.configDirEnv)
      patch.configDirEnv = configDirEnv
      executionProfileChanged ||= configDirEnv !== row.configDirEnv
    }
    if (input.configDirName !== undefined) {
      const configDirName = validateConfigDirName(input.configDirName)
      patch.configDirName = configDirName
      executionProfileChanged ||= configDirName !== row.configDirName
    }
    // A smoke receipt describes one exact execution profile. Never keep a green
    // receipt attached to changed binary/model/config semantics.
    if (executionProfileChanged) {
      patch.lastProbeJson = null
      patch.incrementProbeFence = true
    }
    // Internal callers may deliberately persist a fresh receipt in the same
    // update; an explicit value wins over invalidation.
    if (input.lastProbeJson !== undefined) {
      patch.lastProbeJson = input.lastProbeJson
    }
    await persistence.updateRuntime({
      name,
      patch,
      executionProfileChanged,
    })
    const updated = await getRuntime(persistence, name)
    if (updated === null) throw new Error('runtime update vanished')
    // RFC-114 P3-6: a changed binary makes any cached `<binary> models` stale —
    // evict the old + new path so the next list re-runs the right binary.
    if (input.binaryPath !== undefined) {
      if (row.binaryPath !== null) evictDriverBinaryCaches(row.binaryPath)
      if (updated.binaryPath !== null) evictDriverBinaryCaches(updated.binaryPath)
    }
    return updated
  }

  /**
   * Cache a deep-smoke result onto the exact row/profile that was probed.
   *
   * The smoke call is intentionally outside SQLite and can take a minute. This
   * final single-statement CAS prevents an old result from attaching after an
   * execution-profile PUT, inherited-config invalidation, or delete + same-name
   * recreation. A no-op PUT keeps the same fingerprint/fence and therefore does
   * not spuriously discard a valid result. The boolean tells the route whether it
   * may truthfully return success.
   */
  async function cacheRuntimeProbe(
    persistence: RuntimeRegistryPersistence,
    target: RuntimeProbeTarget,
    smoke: unknown,
  ): Promise<boolean> {
    const receipt: RuntimeProbeReceipt = { codec: 1, target, smoke }
    return persistence.cacheRuntimeProbe({
      target,
      lastProbeJson: JSON.stringify(receipt),
      updatedAt: Date.now(),
    })
  }

  /**
   * Persistently invalidate every runtime that inherits a protocol binary from
   * config.json. Bumping even rows with no cached receipt fences probes already
   * in flight. Config PUT calls this before its atomic file write; if that write
   * fails, the conservative false-negative is safe and a future probe repairs it.
   */
  async function invalidateInheritedRuntimeProbeReceipts(
    persistence: RuntimeRegistryPersistence,
    protocols: readonly RuntimeProtocol[],
  ): Promise<number> {
    if (protocols.length === 0) return 0
    return persistence.invalidateInheritedRuntimeProbeReceipts({ protocols, now: Date.now() })
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
  async function setRuntimeEnabled(
    persistence: RuntimeRegistryPersistence,
    name: string,
    enabled: boolean,
    defaultRuntimeName: string | null | undefined,
  ): Promise<RuntimeRow> {
    const result = await persistence.setRuntimeEnabled({
      name,
      enabled,
      effectiveDefaultName: defaultRuntimeName ?? 'opencode',
      now: Date.now(),
    })
    if (result.status === 'not-found') {
      throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
    }
    if (result.status === 'default-cannot-disable') {
      throw new ConflictError(
        'runtime-default-cannot-disable',
        `runtime '${name}' is the effective default and cannot be disabled; change the default first`,
      )
    }
    const updated = await getRuntime(persistence, name)
    if (updated === null) throw new Error('runtime enabled-toggle vanished')
    return updated
  }

  async function deleteRuntime(
    persistence: RuntimeRegistryPersistence,
    name: string,
    refs: RuntimeRefConfig,
  ): Promise<void> {
    // RFC-153 impl-gate (2nd pass): the existence check, last-row count, reference
    // checks and delete MUST be ONE provider-owned serializable transaction. Split
    // across awaited statements, two concurrent DELETEs of different unreferenced
    // rows both observe count===2, both pass, and empty the table — which the next
    // boot's empty-table seed would then resurrect.
    const result = await persistence.deleteRuntime({
      name,
      refs,
      builtinNames: BUILTIN_NAMES,
      now: Date.now(),
    })
    if (result.status === 'not-found') {
      throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
    }
    if (result.status === 'last-runtime') {
      throw new ConflictError(
        'runtime-last',
        `runtime '${name}' is the only remaining runtime and cannot be deleted`,
      )
    }
    if (result.status === 'in-use') {
      throw new ConflictError(
        'runtime-in-use',
        `runtime '${name}' is in use by ${result.references.join(', ')}; re-point them first`,
      )
    }
    // RFC-114 P3-6: drop this binary's cached model list (outside the tx — the cache
    // is process-local, not DB state).
    if (result.binaryPath !== null) evictDriverBinaryCaches(result.binaryPath)
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
  async function seedBuiltinRuntimes(persistence: RuntimeRegistryPersistence): Promise<void> {
    await persistence.seedBuiltinRuntimes(
      BUILTIN_RUNTIMES.map((builtin) => ({ id: ulid(), ...builtin })),
    )
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
  async function migrateConfigIntoBuiltins(
    persistence: RuntimeRegistryPersistence,
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
      if (binaryPath == null) return
      await persistence.backfillBuiltinBinary({
        name,
        protocol,
        binaryPath,
        updatedAt: Date.now(),
      })
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
  async function assertConfigDefaultsMigrated(
    persistence: RuntimeRegistryPersistence,
    configPath: string,
  ): Promise<void> {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(effects.readConfigText(configPath)) as Record<string, unknown>
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
    const preseeded = (await persistence.listBuiltinProfiles([...BUILTIN_NAMES])).filter(
      (row) => row.protocol === row.name,
    )
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

  /**
   * Provider-neutral application surface. Bootstrap selects exactly one concrete
   * persistence adapter and passes this frozen aggregate to every registry
   * consumer; no route or caller receives a database client.
   */
  function composeRuntimeRegistryOperations(
    persistence: RuntimeRegistryPersistence,
  ): RuntimeRegistryOperations {
    return Object.freeze({
      listRuntimes: () => listRuntimes(persistence),
      getRuntime: (name: string) => getRuntime(persistence, name),
      resolveRuntimeByName: (name: string | null | undefined) =>
        resolveRuntimeByName(persistence, name),
      resolveAgentRuntime: (
        agentRuntime: string | null | undefined,
        defaultRuntime: string | null | undefined,
      ) => resolveAgentRuntime(persistence, agentRuntime, defaultRuntime),
      resolveInternalAgentRuntime: (input: {
        readonly runtimeName?: string | null
        readonly deprecatedModel?: string | null
        readonly defaultRuntime?: string | null
      }) => resolveInternalAgentRuntime(persistence, input),
      createRuntime: (input: CreateRuntimeInput) => createRuntime(persistence, input),
      updateRuntime: (name: string, input: UpdateRuntimeInput) =>
        updateRuntime(persistence, name, input),
      cacheRuntimeProbe: (target: RuntimeProbeTarget, smoke: unknown) =>
        cacheRuntimeProbe(persistence, target, smoke),
      invalidateInheritedRuntimeProbeReceipts: (protocols: readonly RuntimeProtocol[]) =>
        invalidateInheritedRuntimeProbeReceipts(persistence, protocols),
      setRuntimeEnabled: (
        name: string,
        enabled: boolean,
        defaultRuntimeName: string | null | undefined,
      ) => setRuntimeEnabled(persistence, name, enabled, defaultRuntimeName),
      deleteRuntime: (name: string, refs: RuntimeRefConfig) =>
        deleteRuntime(persistence, name, refs),
      seedBuiltinRuntimes: () => seedBuiltinRuntimes(persistence),
      migrateConfigIntoBuiltins: (config: {
        readonly opencodePath?: string | null
        readonly claudeCodePath?: string | null
      }) => migrateConfigIntoBuiltins(persistence, config),
      assertConfigDefaultsMigrated: (configPath: string) =>
        assertConfigDefaultsMigrated(persistence, configPath),
    })
  }
  return Object.freeze({
    RUNTIME_PROTOCOLS,
    BUILTIN_RUNTIMES,
    RUNTIME_EXTRA_ARGS_MAX,
    RUNTIME_EXTRA_ARG_MAX_LENGTH,
    validateExtraArgs,
    listRuntimes,
    getRuntime,
    resolveRuntimeByName,
    resolveAgentRuntime,
    resolveInternalAgentRuntime,
    assertRuntimeSpawnCapabilities,
    createRuntime,
    updateRuntime,
    cacheRuntimeProbe,
    invalidateInheritedRuntimeProbeReceipts,
    setRuntimeEnabled,
    deleteRuntime,
    seedBuiltinRuntimes,
    migrateConfigIntoBuiltins,
    assertConfigDefaultsMigrated,
    composeRuntimeRegistryOperations,
  })
}

export type { RuntimeRegistryOperations }
// Transitional named exports keep existing consumers on the single owner implementation.
export * from '../domain/runtimeProfile'
export type * from '../public/types'
