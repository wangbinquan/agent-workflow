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
// Scope guard: only a CONTROLLED node (its agent declared a permission map —
// `claudeBusinessGate`) is fenced. An unconstrained node keeps its historical
// shape by the user decision of 2026-07-31, and remote MCP is untouched on both
// paths: it has no child process to contain.

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import type { PreparedContainmentPlan } from '@/services/sandbox'
import type { Logger } from '@/util/log'
import { runtimeContainmentAdmissionFromPrepared } from '../opencode/containment'
import { executionIdentityFailure } from '../opencode/failure'
import {
  materializeNetlessWrapper,
  sanitizeNetlessEnvironment,
  type NetlessSubprocessManifest,
} from '../opencode/sealedSubprocess'

/**
 * Same fixed base PATH the verified opencode wrapper uses. The child's own
 * directory is prepended so an interpreted server (`#!/usr/bin/env node` next
 * to its launcher, the npm-global / Homebrew layout) still resolves its
 * toolchain; nothing else is added, and NOTHING from the daemon's PATH leaks.
 */
const FIXED_NETLESS_PATH = '/usr/bin:/bin'

/** Names must be safe path/JSON keys before any of them reaches a wrapper dir. */
const SAFE_MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i

export interface ClaudeNetlessFenceDecision {
  fence: boolean
  /** Non-null ⇒ the fence is deliberately NOT applied; never silent. */
  skipReason: 'unconstrained' | 'no-local-mcp' | 'unfenced-shell' | null
}

/**
 * The SINGLE decision "does this claude business node fence its local MCP?" —
 * consumed by `businessContainmentProfile` (the containment DEMAND, evaluated
 * before the spawn is built) and by `buildBusinessSpawn` (the MATERIALIZATION).
 * A drift between the two would either over-block a launch or promise a
 * boundary that never gets built.
 *
 * Three exclusions, each deliberate:
 *
 *  - `unconstrained` — the agent declared no permission. The 2026-07-31 user
 *    decision keeps those nodes byte-identical, and raising their demand would
 *    let `sandboxMode=enforce` block launches that work today.
 *  - `no-local-mcp` — remote MCP has no child process to contain.
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
}): ClaudeNetlessFenceDecision {
  if (input.gate === null) return { fence: false, skipReason: 'unconstrained' }
  if (!input.mcps.some((mcp) => mcp.enabled !== false && mcp.type === 'local')) {
    return { fence: false, skipReason: 'no-local-mcp' }
  }
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
 * Resolve the configured command head to one canonical regular file.
 *
 * The platform's local-MCP schema allows a bare token (`npx`), which is how
 * existing claude nodes are configured, so a PATH lookup is honored — but the
 * MANIFEST always carries the canonical absolute path, because the child's own
 * PATH is the fixed netless one and a token would simply not resolve inside the
 * boundary.
 */
async function canonicalExecutable(
  token: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (token.length === 0 || token.includes('\0')) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const located = isAbsolute(token)
    ? token
    : // Bun.which honors the supplied PATH; the daemon's own PATH is the only
      // sane interpretation of a bare token the user typed in the MCP form.
      (Bun.which(token, { PATH: sourceEnv.PATH ?? FIXED_NETLESS_PATH }) ?? null)
  if (located === null || !isAbsolute(located)) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const canonical = await realpath(located)
  if (resolve(canonical) !== canonical) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const metadata = await lstat(canonical)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return canonical
}

/** Absolute, canonical, existing directory — or a closed failure. */
async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const canonical = await realpath(path)
  const metadata = await stat(canonical)
  if (!metadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return canonical
}

function contained(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Only daemon-owned Git metadata projections (mirrors the opencode wrapper):
 * a linked worktree keeps objects/refs/index behind the appHome/HOME masks, so
 * without this every child `git` call fails inside the boundary. Asking Git
 * beats parsing an attacker-writable `.git` pointer file.
 *
 * Deliberately tolerant where opencode fails closed: a repo that Git cannot
 * describe simply gets no projection. That direction only ever REMOVES an
 * allow-back — the child loses a git capability, it never gains reach — so a
 * non-git scratch worktree must not take the whole node down.
 */
async function resolveGitCommonDirs(
  repoWorktreePaths: readonly string[] | undefined,
): Promise<string[]> {
  if (repoWorktreePaths === undefined || repoWorktreePaths.length === 0) return []
  if (repoWorktreePaths.length > 64) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const canonicalRepos: string[] = []
  const commonDirs: string[] = []
  for (const repoPath of repoWorktreePaths) {
    const canonicalRepo = await canonicalDirectory(repoPath)
    canonicalRepos.push(canonicalRepo)
    const git = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: canonicalRepo,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const reported = (await new Response(git.stdout).text()).trim()
    if ((await git.exited) !== 0 || reported.length === 0) continue
    const canonicalCommon = await realpath(reported).catch(() => null)
    if (
      canonicalCommon === null ||
      !isAbsolute(canonicalCommon) ||
      resolve(canonicalCommon) !== canonicalCommon
    ) {
      continue
    }
    commonDirs.push(canonicalCommon)
  }
  // Only EXTERNAL common dirs need projecting: a plain clone keeps `.git` inside
  // the worktree that is already bound. Sorted + deduped because the manifest
  // rejects repeats outright.
  return [
    ...new Set(commonDirs.filter((dir) => !canonicalRepos.some((repo) => contained(repo, dir)))),
  ].sort()
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

  const canonicalWorktree = await canonicalDirectory(input.worktreePath)
  const canonicalAppHome = await canonicalDirectory(input.appHome)
  const gitCommonDirs = await resolveGitCommonDirs(input.repoWorktreePaths)

  // Wrappers live OUTSIDE the child's writable scratch: a model-controlled
  // child must not be able to rewrite the manifest that fences it.
  const sealRoot = join(input.runRoot, 'claude-mcp-seal')
  const scratchRoot = join(input.runRoot, 'claude-mcp-scratch')
  const childHome = join(scratchRoot, 'home')
  const childTmp = join(scratchRoot, 'tmp')
  // materializeNetlessWrapper writes O_EXCL; a re-entered node run (inline
  // clarify resume reuses its runRoot) must not fail on its own leftovers.
  await rm(sealRoot, { recursive: true, force: true })
  await mkdir(sealRoot, { recursive: true, mode: 0o700 })
  for (const dir of [scratchRoot, childHome, childTmp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
  const canonicalScratch = await canonicalDirectory(scratchRoot)
  const canonicalHome = await canonicalDirectory(childHome)
  const canonicalTmp = await canonicalDirectory(childTmp)

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
    const executable = await canonicalExecutable(command[0]!, sourceEnv)
    const args = command.slice(1)
    if (args.some((entry) => entry.includes('\0'))) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    // MCP-authored env is validated (never silently dropped) and then lives ONLY
    // in the 0400 manifest — it used to travel inside `--mcp-config`'s inline
    // JSON, i.e. in argv, visible to every process listing on the host.
    const requestedEnv = mcp.config.env ?? {}
    const configuredEnv = sanitizeNetlessEnvironment(requestedEnv)
    if (Object.keys(configuredEnv).length !== Object.keys(requestedEnv).length) {
      return executionIdentityFailure('execution-identity-mismatch')
    }

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
      // Bind the executable INODE only. Re-binding its parent after the boundary
      // masks realHome/appHome could hand the child SSH keys, cloud creds or
      // daemon state that merely happen to sit beside a legitimate MCP binary.
      bindReadOnly: [executable],
      env: {
        ...sanitizeNetlessEnvironment({
          LANG: sourceEnv.LANG,
          LC_ALL: sourceEnv.LC_ALL,
          LC_CTYPE: sourceEnv.LC_CTYPE,
          TERM: sourceEnv.TERM,
          TZ: sourceEnv.TZ,
        }),
        ...configuredEnv,
        PATH: `${dirname(executable)}:${FIXED_NETLESS_PATH}`,
        HOME: canonicalHome,
        TMPDIR: canonicalTmp,
        PWD: canonicalWorktree,
      },
      command: [executable, ...args],
    }
    await materializeNetlessWrapper({ wrapperPath, manifestPath, manifest })
    wrapperByName.set(mcp.name, wrapperPath)
    frozen.push({
      wrapperPath,
      manifestPath,
      executable,
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
        // The fenced command must still be the exact file that was planned.
        const executableMetadata = await lstat(entry.executable)
        if (executableMetadata.isSymbolicLink() || !executableMetadata.isFile()) {
          return executionIdentityFailure('execution-identity-mismatch')
        }
      }
    },
  }
}
