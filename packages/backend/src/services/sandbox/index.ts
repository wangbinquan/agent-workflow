// RFC-205 T3 — the spawn-boundary wrapper.
//
// SpawnPlan stays byte-identical (golden argv locks, shell stubs,
// spawnBinaryPath = plan.cmd[0], version-registry keys — see design §1 红线);
// the sandbox is applied at the LAST moment, wrapping the final argv that
// reaches Bun.spawn. No ctx (tests, sandboxMode=off, mechanism unavailable)
// → the argv passes through untouched.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { resolveGitCommonDirSync } from '@/util/git'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
  type SandboxPolicy,
} from './policy'
import type { SandboxStatus } from './probe'

export {
  CONTAINMENT_REASON_CODES,
  CONTAINMENT_REQUIREMENT_PROFILES,
  ContainmentAdmissionAborted,
  ContainmentAdmissionError,
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
  containmentRequirementDigest,
  type ContainmentAdmissionReceipt,
  type ContainmentCapabilityStrength,
  type ContainmentDecision,
  type ContainmentReasonCode,
  type ContainmentRequirementProfileId,
  type ContainmentRuntimeProjection,
  type ContainmentTopology,
  type PreparedContainmentPlan,
  type QualifiedContainmentProvider,
} from './containmentCoordinator'
export {
  ContainmentJsonObjectSchema,
  ContainmentJsonValueSchema,
  PreparedChildContainmentPlanSchema,
  type ContainmentJsonObject,
  type ContainmentJsonPrimitive,
  type ContainmentJsonValue,
  type PreparedChildContainmentPlan,
} from './containmentContract'

export type SandboxMode = 'enforce' | 'warn' | 'off'
export type SpawnSandboxTopology = 'runner-outer' | 'provider-child-only'

export interface SandboxCtx {
  mode: SandboxMode
  status: SandboxStatus
  appHome: string
  /** THIS task's worktree roots. */
  taskWorktrees: readonly string[]
  /** THIS run's private dir. */
  runDir: string
  /** Immutable artifacts below an allowed subtree, overlaid read-only. */
  readOnlySubtrees?: readonly string[]
  /** RFC-251 — read-only allow-backs with no RW parent (e.g. the plugin cache). */
  readOnlyAllowSubtrees?: readonly string[]
  /**
   * RFC-253 — deny ALL network access for this process. Only set by a caller
   * that admitted through a fail-closed netless profile, so the fence and the
   * admission decision can never disagree.
   */
  networkDeny?: boolean
  /**
   * RFC-253 — task worktrees + the git mirror are readable but NOT writable.
   * Set for a `readonly` script node, which skips isolation and runs against
   * the canonical tree: without this, "read-only" would be a convention the
   * script is trusted to honour rather than a boundary.
   */
  readOnlyWorktrees?: boolean
  /** Provider-owned renderer for mechanisms added after the built-ins. */
  wrapCommand?: (cmd: readonly string[], policy: SandboxPolicy) => string[]
}

/** True when `child` is `parent` itself or a descendant of it. */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Should this spawn be wrapped at all? (off / unavailable → no) */
export function sandboxActive(ctx: SandboxCtx | undefined): boolean {
  return ctx !== undefined && ctx.mode !== 'off' && ctx.status.available
}

/**
 * RFC-205 impl-gate P0-1 (Codex 2026-07-22): true when the mode is `enforce` but
 * the platform sandbox is unavailable — the spawn MUST fail closed instead of
 * running the agent unsandboxed. The launch-time 409 only guards NEW tasks; every
 * launch/resume/retry/auto-resume path funnels through the runner spawn, so the
 * single decision point there calls this to close the resume/retry/auto-resume
 * bypass. (`warn` + unavailable degrades loudly; `off` never blocks.)
 */
export function sandboxEnforceBlocked(ctx: SandboxCtx | undefined): boolean {
  return ctx !== undefined && ctx.mode === 'enforce' && !ctx.status.available
}

/**
 * Wrap a final argv in the platform sandbox. Returns a NEW array — the input
 * (plan.cmd) is never mutated (spawnBinaryPath/registry keep reading it).
 */
export function wrapSandbox(cmd: readonly string[], ctx: SandboxCtx | undefined): string[] {
  if (!sandboxActive(ctx) || ctx === undefined) return [...cmd]
  // Seatbelt matches KERNEL paths: a profile written against a symlinked
  // prefix (macOS $TMPDIR = /var → /private/var; a symlinked $HOME) silently
  // matches NOTHING and the deny evaporates — caught live by the gated
  // integration test. Resolve every policy root to its real path; a path that
  // does not exist yet (runDir pre-mkdir) stays as given.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const appHome = real(ctx.appHome)
  const policy = computeSandboxPolicy({
    appHome,
    taskWorktrees: ctx.taskWorktrees.map(real),
    runDir: real(ctx.runDir),
    readOnlySubtrees: ctx.readOnlySubtrees?.map(real),
    readOnlyAllowSubtrees: ctx.readOnlyAllowSubtrees?.map(real),
    networkDeny: ctx.networkDeny === true,
    readOnlyWorktrees: ctx.readOnlyWorktrees === true,
    // bwrap aborts the spawn when a --bind SOURCE is missing, and the mirror
    // root only appears once something has been cloned. Probe it here (the one
    // place in this module that is allowed to touch the filesystem) rather than
    // letting a repo-less deployment fail every sandboxed spawn.
    gitMirrorPresent: existsSync(join(appHome, 'repos')),
  })
  if (ctx.wrapCommand !== undefined) return ctx.wrapCommand(cmd, policy)
  if (ctx.status.mechanism === 'seatbelt') {
    return ['/usr/bin/sandbox-exec', '-p', renderSeatbeltProfile(policy), ...cmd]
  }
  if (ctx.status.mechanism === 'bwrap') {
    return ['bwrap', ...renderBwrapArgs(policy), '--', ...cmd]
  }
  return [...cmd]
}

/**
 * Select the process layer that owns containment for this spawn plan.
 *
 * macOS Seatbelt cannot safely enter a second `sandbox-exec` profile from an
 * already-sandboxed process. Verified OpenCode business plans therefore keep
 * the trusted server outside the generic runner wrapper when their
 * model-controlled shell/MCP children are already forced through the sealed
 * Seatbelt wrapper. Linux remains runner-outer + child bwrap.
 *
 * Only the built-in Seatbelt mechanism may request the child-only topology.
 * Any stale or malformed request on another provider falls back to the outer
 * wrapper instead of weakening containment.
 */
export function wrapSpawnPlanSandbox(
  cmd: readonly string[],
  ctx: SandboxCtx | undefined,
  topology: SpawnSandboxTopology | undefined,
): string[] {
  if (topology === 'provider-child-only' && ctx?.status.mechanism === 'seatbelt') {
    return [...cmd]
  }
  return wrapSandbox(cmd, ctx)
}

export interface SandboxProvider {
  mode: SandboxMode
  status: SandboxStatus
  appHome: string
  /**
   * RFC-227 extension seam. OpenCode consumes only the capability receipt and
   * opaque child plan; platform-specific process/path code remains owned by
   * the provider that registers the matching subprocess renderer.
   */
  runtimeContainment?: {
    providerId: string
    capabilities: Readonly<Record<string, 'strong' | 'best-effort' | 'absent'>>
    childProviderPlan?: unknown
  }
  /** Outer-process renderer for a provider not built into RFC-205. */
  wrapCommand?: (cmd: readonly string[], policy: SandboxPolicy) => string[]
}

/**
 * Per-run ctx.
 *
 * Worktree allow-scope used to be GUESSED from the cwd's path shape: "parent
 * dir named after the task ⇒ allow the whole parent". That was written for the
 * pre-RFC-130 canonical layout `worktrees/multi/{taskId}/{repo}` and is wrong
 * for the layout production actually runs, `iso/{taskId}/{nodeRunId}/{member}`
 * — the parent is named after the NODE RUN, so a multi-repo task allowed only
 * `repos[0]` while the prompt handed the agent every member's path. On macOS
 * the siblings failed EPERM; on Linux they were masked by the appHome tmpfs,
 * which is itself writable, so writes "succeeded" and evaporated at exit and
 * merge-back silently produced an empty delta (2026-08-04 audit, three
 * independent finders).
 *
 * The heuristic is kept only as the fallback for single-worktree callers; any
 * run with more than one worktree root MUST pass `worktreeRoots` (the iso
 * handle's members, or the container that holds them).
 */
export function buildRunSandboxCtx(
  p: SandboxProvider | null,
  taskId: string,
  worktreePath: string,
  runDir: string,
  /** Every worktree root this run may touch — all repos, not just the primary. */
  worktreeRoots: readonly string[] = [],
): SandboxCtx | undefined {
  if (p === null) return undefined
  const parent = dirname(worktreePath)
  const taskWorktrees = [
    ...new Set([basename(parent) === taskId ? parent : worktreePath, ...worktreeRoots]),
  ]
  // A task whose BASE repository lives INSIDE appHome needs its git COMMON dir
  // allowed back, or every git command in the agent's cwd dies under the
  // appHome-wide deny while file writes still succeed (2026-07-22 task …QGENNV:
  // members declared the workspace unusable and went to work in the user's REAL
  // repo, outside the boundary).
  //
  // This used to be the literal string `scratch/{taskId}/.git`, which covered
  // exactly ONE of the three shapes that hit it. Derive it instead — from the
  // worktree's own on-disk pointers — so a skill-fusion engine task
  // (`fusions/{id}/iter{n}/work`) and a call-workflow child of a scratch parent
  // (common dir carries the PARENT task id) are covered by construction rather
  // than by a third hand-written literal (2026-08-04 audit).
  //
  // Only the common dir, never the canonical working tree: canonical files are
  // writable solely through the daemon's writeSem merge-back, and an iso agent
  // handed the whole canonical tree could race sibling nodes or leave dirt that
  // survives a failed run (RFC-130 boundary; Codex impl-gate P1 2026-07-22).
  // Gated on existence + on living inside appHome: a common dir outside appHome
  // is not denied in the first place, and bwrap `--bind` of a missing source
  // path errors the spawn.
  //
  // Probe the ACTUAL worktrees, not the (possibly broadened) allow roots: the
  // heuristic widens `iso/{taskId}/{runId}` to `iso/{taskId}`, which holds no
  // `.git` pointer of its own.
  for (const root of new Set([worktreePath, ...worktreeRoots])) {
    const commonDir = resolveGitCommonDirSync(root)
    if (
      commonDir === null ||
      !isInside(p.appHome, commonDir) ||
      !existsSync(commonDir) ||
      taskWorktrees.some((allowed) => allowed === commonDir || isInside(allowed, commonDir))
    ) {
      continue
    }
    taskWorktrees.push(commonDir)
  }
  return {
    mode: p.mode,
    status: p.status,
    appHome: p.appHome,
    taskWorktrees,
    runDir,
    ...(p.wrapCommand === undefined ? {} : { wrapCommand: p.wrapCommand }),
  }
}
