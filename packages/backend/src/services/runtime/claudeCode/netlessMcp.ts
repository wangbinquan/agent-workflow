// RFC-242 T5 — the platform-level no-network boundary for a controlled Claude
// Code business node's LOCAL MCP children (design §4, decision C-1).
//
// Why this exists. claude itself MUST reach the network (it talks to the model
// API), so the parity guarantee opencode gives is not "the runtime is offline"
// but "every MODEL-CONTROLLED child process is". On opencode that is
// `verifiedPlan.ts`'s local-MCP wrapper; claude used to hand its raw
// `command`/`args` to `--mcp-config`, so its MCP children inherited full
// network and the daemon's whole environment.
//
// How. T0b measured (design §4.1, claude 2.1.220): claude FORKS whatever
// `command` the mcp config names, so the platform can name its own. This module
// therefore reuses the EXISTING opencode machinery verbatim — zero new
// mechanism:
//   materializeNetlessWrapper → 0500 `run` + 0400 `netless.json`
//   → claude forks `run`
//   → `__opencode-netless-subprocess` reads the manifest
//   → the admitted child provider (bwrap `--unshare-net` / Seatbelt
//     `deny network*`) wraps the REAL MCP command, stdio fully inherited.
//
// EVERY path that reaches the manifest is a hole in that boundary (writable
// allow-backs are applied after the realHome/appHome masks), so all of them go
// through `../netlessProjection` — the single copy shared with the opencode
// plan. The adversarial review of the first cut found a private duplicate here
// that had dropped three of the original's checks; there is no duplicate now.
//
// Scope guard: only a CONTROLLED node (its agent declared a permission map —
// `claudeBusinessGate`) is fenced. An unconstrained node keeps its historical
// shape by the user decision of 2026-07-31, and remote MCP is untouched on both
// paths: it has no child process to contain.

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import type { PreparedContainmentPlan } from '@/services/sandbox'
import type { Logger } from '@/util/log'
import {
  canonicalExecutable,
  canonicalNetlessDirectory,
  ensurePrivateNetlessDirectory,
  FIXED_NETLESS_PATH,
  resolveInterpreterChain,
  resolveNetlessGitCommonDirs,
} from '../netlessProjection'
import { runtimeContainmentAdmissionFromPrepared } from '../opencode/containment'
import { executionIdentityFailure } from '../opencode/failure'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'
import {
  materializeNetlessWrapper,
  sanitizeMcpAuthoredEnvironment,
  sanitizeNetlessEnvironment,
  type NetlessSubprocessManifest,
} from '../opencode/sealedSubprocess'

/**
 * Same fixed base PATH the verified opencode wrapper uses. The child's own
 * directory — and, for an interpreted server, its interpreter's directory — are
 * prepended so a `#!/usr/bin/env node` launcher still resolves; nothing else is
 * added, and NOTHING from the daemon's PATH leaks.
 */

/** Names must be safe path/JSON keys before any of them reaches a wrapper dir. */
const SAFE_MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i

/** `#!/usr/bin/env node` → node → its own interpreter … a cycle is a failure. */

export interface ClaudeNetlessFenceDecision {
  fence: boolean
  /** Non-null ⇒ the fence is deliberately NOT applied; never silent. */
  skipReason: 'unconstrained' | 'no-local-mcp' | 'unfenced-shell' | 'test-runtime-head' | null
}

/**
 * The SINGLE decision "does this claude business node fence its local MCP?" —
 * consumed by `businessContainmentProfile` (the containment DEMAND, evaluated
 * before the spawn is built) and by `buildBusinessSpawn` (the MATERIALIZATION).
 * A drift between the two would either over-block a launch or promise a
 * boundary that never gets built, so BOTH callers feed it the same three
 * inputs — including `runtimeCmd`, whose absence used to make the demand and
 * the materialization disagree (impl-gate P2-7).
 *
 * Four exclusions, each deliberate:
 *
 *  - `unconstrained` — the agent declared no permission. The 2026-07-31 user
 *    decision keeps those nodes byte-identical, and raising their demand would
 *    let `sandboxMode=enforce` block launches that work today.
 *  - `no-local-mcp` — remote MCP has no child process to contain.
 *  - `test-runtime-head` — an injected multi-token runtime head is the mock
 *    seam (production never sets it). Its fake claude forks no MCP, so raising
 *    the demand would drop the runner's outer sandbox (see below) in exchange
 *    for a boundary nobody builds.
 *  - `unfenced-shell` — the gate grants Bash. This one is subtle and measured:
 *    a `model-controlled` childBoundary makes the coordinator move the platform
 *    boundary to the CHILD layer, and on a Seatbelt provider that means dropping
 *    the runner's outer sandbox entirely (RFC-227 `provider-child-only`) —
 *    nesting is impossible, verified hands-on 2026-07-31:
 *    `sandbox-exec: sandbox_apply: Operation not permitted`.
 *    That trade is sound only when EVERY model-controlled child goes through
 *    the child launcher, which is true for the verified opencode path (it routes
 *    shell AND local MCP) but not yet for claude: RFC-242 design §4 C-2 (Bash
 *    through the same wrapper) is deferred. Fencing a Bash-granting node would
 *    therefore buy a network boundary for its MCP servers at the cost of the
 *    filesystem boundary around claude and its shell children — a net loss.
 *    Until C-2 lands those nodes keep today's outer sandbox, and the skipped
 *    fence is logged rather than assumed.
 */
export function claudeLocalMcpFenceDecision(input: {
  gate: { tools: readonly string[] } | null
  mcps: readonly Mcp[]
  /** Test-only injected head (`BusinessNodeSpawnContext.runtimeCmd`). */
  runtimeCmd?: readonly string[] | undefined
}): ClaudeNetlessFenceDecision {
  if (input.gate === null) return { fence: false, skipReason: 'unconstrained' }
  if (!input.mcps.some((mcp) => mcp.enabled !== false && mcp.type === 'local')) {
    return { fence: false, skipReason: 'no-local-mcp' }
  }
  if (input.runtimeCmd !== undefined) return { fence: false, skipReason: 'test-runtime-head' }
  if (input.gate.tools.includes('Bash')) return { fence: false, skipReason: 'unfenced-shell' }
  return { fence: true, skipReason: null }
}

export interface ClaudeNetlessMcpInput {
  /** All MCP rows for the node; disabled + remote entries are skipped. */
  mcps: readonly Mcp[]
  /** The daemon's single frozen admission for this spawn (RFC-233). */
  containment: PreparedContainmentPlan
  /** `<appHome>/runs/<taskId>/<nodeRunId>` — private, daemon owned. */
  runRoot: string
  worktreePath: string
  appHome: string
  /** Runner-owned repo topology; each repo's git common dir is projected in. */
  repoWorktreePaths?: readonly string[]
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  log: Logger
  /** Test seam only — production reads the daemon's real environment. */
  sourceEnv?: Readonly<Record<string, string | undefined>>
}

export interface ClaudeNetlessMcpResult {
  /** MCP name → the 0500 wrapper claude is told to fork. */
  wrapperByName: ReadonlyMap<string, string>
  /** TOCTOU fence: re-checked immediately before Bun.spawn. */
  preSpawnVerify: () => Promise<void>
}

interface FrozenWrapper {
  wrapperPath: string
  manifestPath: string
  executable: string
  /** Identity of the planned executable — a same-path REPLACEMENT is a failure. */
  executableDev: number
  executableIno: number
  wrapperDigest: string
  manifestDigest: string
}

async function frozenFileDigest(path: string, expectedMode: number): Promise<string> {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== expectedMode)
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/**
 * Materialize one no-network wrapper per enabled LOCAL MCP and return the map
 * `toClaudeMcpConfig` uses to rewrite those entries.
 *
 * Callers must have decided the node is controlled; this function does not
 * re-derive that policy. It is a no-op (empty map) when no local MCP is enabled.
 */
export async function materializeClaudeNetlessMcp(
  input: ClaudeNetlessMcpInput,
): Promise<ClaudeNetlessMcpResult> {
  const sourceEnv = input.sourceEnv ?? process.env
  const local = input.mcps.filter((mcp) => mcp.enabled !== false && mcp.type === 'local')
  if (local.length === 0) {
    return { wrapperByName: new Map(), preSpawnVerify: async () => {} }
  }

  const admission = runtimeContainmentAdmissionFromPrepared(input.containment)
  if (admission.childProvider.providerId === 'none') {
    // warn/off containment (or an unqualified provider) still runs the wrapper,
    // but with NO boundary — RFC-227 semantics are "degrade atomically and say
    // so", never "silently promise a fence that was not admitted".
    input.log.warn('claude-mcp-netless-unfenced', {
      mcpCount: local.length,
      decision: input.containment.receipt.decision,
      mode: input.containment.receipt.mode,
      reasonCodes: [...input.containment.receipt.reasonCodes],
      detail: 'local MCP children run without a network boundary on this host',
    })
  }

  const canonicalWorktree = await canonicalNetlessDirectory(input.worktreePath)
  const canonicalAppHome = await canonicalNetlessDirectory(input.appHome)
  // The run root is daemon-owned and normally already exists (the binary seal
  // writes into it first); create it here anyway so this module does not depend
  // on that ordering. A run root that is a LINK still fails closed below.
  await mkdir(input.runRoot, { recursive: true, mode: 0o700 })
  const canonicalRunRoot = await canonicalNetlessDirectory(input.runRoot)
  const gitCommonDirs = await resolveNetlessGitCommonDirs({
    repoWorktreePaths: input.repoWorktreePaths,
    primaryWorktree: canonicalWorktree,
    // A claude business node may legitimately run in a plain (non-git) scratch
    // worktree; losing the projection only ever REMOVES an allow-back. A
    // REPORTED common dir is never tolerated — see netlessProjection.
    undescribableRepo: 'skip-projection',
  })

  // Wrappers live OUTSIDE the child's writable scratch: a model-controlled
  // child must not be able to rewrite the manifest that fences it. And every
  // one of these directories is (re)created without following a link — an
  // inline-clarify rerun reuses this run root, so the PREVIOUS run's fenced
  // child had write access to the scratch subtree and could otherwise redirect
  // HOME/TMPDIR (and with them a writable allow-back) anywhere on the host.
  // materializeNetlessWrapper writes O_EXCL; a re-entered node run must not
  // fail on its own leftovers, so the seal is rebuilt from scratch.
  await rm(join(canonicalRunRoot, 'claude-mcp-seal'), { recursive: true, force: true })
  const sealRoot = await ensurePrivateNetlessDirectory(canonicalRunRoot, 'claude-mcp-seal')
  const canonicalScratch = await ensurePrivateNetlessDirectory(
    canonicalRunRoot,
    'claude-mcp-scratch',
  )
  const canonicalHome = await ensurePrivateNetlessDirectory(canonicalScratch, 'home')
  const canonicalTmp = await ensurePrivateNetlessDirectory(canonicalScratch, 'tmp')

  // RFC-067 — the task's git identity. `runNetlessSubprocess` REPLACES the
  // child environment, so without this a fenced MCP that commits would use the
  // machine default (or fail outright against the private scratch HOME).
  const gitName = typeof input.gitUserName === 'string' ? input.gitUserName : ''
  const gitEmail = typeof input.gitUserEmail === 'string' ? input.gitUserEmail : ''
  const gitIdentityEnv =
    gitName.length > 0 && gitEmail.length > 0
      ? sanitizeNetlessEnvironment({
          GIT_AUTHOR_NAME: gitName,
          GIT_AUTHOR_EMAIL: gitEmail,
          GIT_COMMITTER_NAME: gitName,
          GIT_COMMITTER_EMAIL: gitEmail,
        })
      : {}

  const wrapperByName = new Map<string, string>()
  const frozen: FrozenWrapper[] = []
  for (const mcp of local) {
    // First-wins on a repeated name, byte-identical to toClaudeMcpConfig's
    // closure dedupe — the two MUST agree or the map would rewrite an entry the
    // config never emitted. An UNSAFE name fails closed instead: it would become
    // a wrapper directory segment. (McpNameSchema already forbids one, so this
    // only catches rows written around the schema.)
    if (!SAFE_MCP_NAME_RE.test(mcp.name)) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    if (wrapperByName.has(mcp.name)) continue
    if (mcp.type !== 'local') continue // narrowing only; filtered above
    const command = mcp.config.command
    if (command.length === 0) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const executable = await canonicalExecutable(command[0]!, sourceEnv, canonicalWorktree)
    const interpreters = await resolveInterpreterChain(executable, sourceEnv)
    const args = command.slice(1)
    if (args.some((entry) => entry.includes('\0'))) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    // MCP-authored env is validated (never silently dropped) and then lives ONLY
    // in the 0400 manifest — it used to travel inside `--mcp-config`'s inline
    // JSON, i.e. in argv, visible to every process listing on the host.
    const configuredEnv = sanitizeMcpAuthoredEnvironment(mcp.config.env ?? {}, mcp.name)

    const wrapperDir = join(sealRoot, mcp.name)
    const wrapperPath = join(wrapperDir, 'run')
    const manifestPath = join(wrapperDir, 'netless.json')
    const manifest: NetlessSubprocessManifest = {
      codec: 1,
      mode: 'mcp',
      provider: admission.childProvider,
      worktreePath: canonicalWorktree,
      scratchPath: canonicalScratch,
      appHome: canonicalAppHome,
      realHome: await realpath(homedir()),
      gitCommonDirs,
      // Bind the executable (and any interpreter it needs) INODE only.
      // Re-binding a parent after the boundary masks realHome/appHome could
      // hand the child SSH keys, cloud creds or daemon state that merely happen
      // to sit beside a legitimate MCP binary.
      bindReadOnly: [...new Set([executable, ...interpreters])],
      env: {
        ...sanitizeNetlessEnvironment({
          LANG: sourceEnv.LANG,
          LC_ALL: sourceEnv.LC_ALL,
          LC_CTYPE: sourceEnv.LC_CTYPE,
          TERM: sourceEnv.TERM,
          TZ: sourceEnv.TZ,
        }),
        ...gitIdentityEnv,
        ...configuredEnv,
        PATH: [
          ...new Set([dirname(executable), ...interpreters.map((path) => dirname(path))]),
          FIXED_NETLESS_PATH,
        ].join(':'),
        HOME: canonicalHome,
        TMPDIR: canonicalTmp,
        PWD: canonicalWorktree,
      },
      command: [executable, ...args],
    }
    await materializeNetlessWrapper({ wrapperPath, manifestPath, manifest })
    wrapperByName.set(mcp.name, wrapperPath)
    const executableMetadata = await lstat(executable)
    frozen.push({
      wrapperPath,
      manifestPath,
      executable,
      executableDev: executableMetadata.dev,
      executableIno: executableMetadata.ino,
      wrapperDigest: await frozenFileDigest(wrapperPath, 0o500),
      manifestDigest: await frozenFileDigest(manifestPath, 0o400),
    })
  }

  input.log.info('claude-mcp-netless', {
    providerId: admission.childProvider.providerId,
    mcpKeys: [...wrapperByName.keys()],
  })

  return {
    wrapperByName,
    preSpawnVerify: async () => {
      for (const entry of frozen) {
        const [wrapperDigest, manifestDigest] = await Promise.all([
          frozenFileDigest(entry.wrapperPath, 0o500),
          frozenFileDigest(entry.manifestPath, 0o400),
        ])
        if (wrapperDigest !== entry.wrapperDigest || manifestDigest !== entry.manifestDigest) {
          return executionIdentityFailure('execution-identity-mismatch')
        }
        // The fenced command must still be the exact FILE that was planned —
        // identity, not merely shape: swapping another regular file into the
        // same path passed the previous lstat-only check.
        const executableMetadata = await lstat(entry.executable)
        if (
          executableMetadata.isSymbolicLink() ||
          !assertSameFileIdentityForHost(
            { dev: entry.executableDev, ino: entry.executableIno },
            executableMetadata,
          ).trusted
        ) {
          return executionIdentityFailure('execution-identity-mismatch')
        }
      }
    },
  }
}
