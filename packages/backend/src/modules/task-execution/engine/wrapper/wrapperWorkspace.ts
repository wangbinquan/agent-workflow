// RFC-413 — the wrapper workspace (RFC-339's purpose-specific port, RFC-130 T11 isolation): the opened scenes, the
// repositories a git wrapper diffs, its entry snapshot (baseline + RFC-098 B3 preDirty) and changed-file subtraction,
// and the merge-back. Moved verbatim from composition/wrapperMechanics.ts; the composition binds the isolation ports
// over the state the wrapper node lives in and resolves a handle's scope.
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { describeEffectError } from '../../domain/effectErrorDescription'
import type { WrapperNodeKind } from '../../domain/wrapperExecution'
import type { Logger } from '../../application/ports/executionKernel'
import type {
  WrapperGitScope,
  WrapperWorkspaceEnginePorts,
  WrapperWorkspacePort,
  WrapperWorkspaceScene,
  WrapperWorkspaceScenes,
} from '../../application/ports/wrapperWorkspace'
import { createOrRebuildWrapperIso, mergeBackWrapperIso } from '../kernel/wrapperIsolation'

/** The wrapper workspace port over one execution state, and the resolver of the scenes it opened. */
export function createWrapperWorkspace(
  ports: WrapperWorkspaceEnginePorts,
  executionLog: Logger,
): WrapperWorkspaceScenes {
  const scenes = new Map<symbol, { readonly handle: IsoHandle; readonly kind: WrapperNodeKind }>()
  const sceneRecord = (scene: WrapperWorkspaceScene) => {
    const record = scenes.get(scene.key)
    if (record === undefined) throw new Error(`wrapper-workspace-scene-missing:${scene.kind}`)
    return record
  }
  const diffableRepos = (scene: WrapperWorkspaceScene) => {
    const { handle } = sceneRecord(scene)
    return (
      handle.passthrough
        ? ports.isolation.repos.map((repo) => ({
            path: repo.worktreePath,
            mountPath: repo.mountPath,
            readonly: repo.readonly,
          }))
        : handle.repos.map((repo, index) => ({
            path: repo.isoWorktreePath,
            mountPath: ports.isolation.repos[index]?.mountPath ?? repo.mountPath,
            readonly: ports.isolation.repos[index]?.readonly ?? false,
          }))
    )
      .filter((repo) => !repo.readonly)
      .map((repo) => ({ path: repo.path, mountPath: repo.mountPath }))
  }

  const workspace: WrapperWorkspacePort = {
    async open(generation) {
      const handle = await createOrRebuildWrapperIso(
        ports.isolation,
        generation.runId,
        generation.previous,
      )
      const key = Symbol(generation.runId)
      scenes.set(key, { handle, kind: generation.kind })
      return Object.freeze({ key, kind: generation.kind, passthrough: handle.passthrough })
    },
    async captureGitEntry(scene, capturePreDirty) {
      const scope = ports.scopeOf(sceneRecord(scene).handle)
      const repos = diffableRepos(scene)
      const primaryMount = repos.some((repo) => repo.mountPath === '')
        ? ''
        : (repos[0]?.mountPath ?? '')
      const entry = await ports.isolation.writeSem.run(async () => {
        const baselines: Record<string, string> = {}
        const preDirtyByRepo: Record<string, Record<string, string>> = {}
        for (const repo of repos) {
          const baseline = await captureHead(scope, repo.path)
          baselines[repo.mountPath] = baseline
          preDirtyByRepo[repo.mountPath] = capturePreDirty
            ? await captureGitPreDirty(scope, repo.path, baseline, executionLog)
            : {}
        }
        return { baselines, preDirtyByRepo }
      })
      return { ...entry, primaryMount }
    },
    changedFiles(scene, baselines, preDirtyByRepo) {
      const scope = ports.scopeOf(sceneRecord(scene).handle)
      return ports.isolation.writeSem.run(async () => {
        const output: string[] = []
        for (const repo of diffableRepos(scene)) {
          const baseline = baselines[repo.mountPath] ?? ''
          const preDirty = preDirtyByRepo[repo.mountPath] ?? {}
          const all = await scope.changedFiles(repo.path, baseline || 'HEAD')
          const candidates = all.filter((path) => preDirty[path] !== undefined)
          const kept =
            candidates.length === 0
              ? all
              : await (async () => {
                  const post = await scope.blobHashes(repo.path, candidates)
                  return all.filter(
                    (path) => preDirty[path] === undefined || post[path] !== preDirty[path],
                  )
                })()
          for (const path of kept) {
            output.push(repo.mountPath === '' ? path : `${repo.mountPath}/${path}`)
          }
        }
        return output
      })
    },
    async merge(input) {
      const { handle } = sceneRecord(input.scene)
      const result = await mergeBackWrapperIso(
        ports.isolation,
        handle,
        input.runId,
        input.node,
        input.iteration,
        executionLog,
      )
      return result.kind === 'merge-failed' ? { kind: 'merge-failed', message: result.msg } : result
    },
  }

  return { port: workspace, resolve: sceneRecord }
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03) — RFC-040 makes it bubble
// awaiting_* and resumable.
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop). On RFC-040 resume the baseline is read from
// persisted progress — we MUST NOT re-capture HEAD on resume because the
// worktree has already diverged from the original pre-inner state while the
// inner agent was running; the final diff is meant to be against pre-inner,
// not pre-resume.
// -----------------------------------------------------------------------------

async function captureHead(scope: WrapperGitScope, worktreePath: string): Promise<string> {
  try {
    const r = await scope.head(worktreePath)
    if (r.exitCode === 0) return r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }
  return ''
}

// RFC-098 B3 (audit S-4, adversarial-review revision #9) — preDirty caps.
// Beyond either limit the capture DEGRADES TO THE EMPTY SET: the finalize
// subtraction then removes nothing, which is exactly the pre-fix cumulative
// behavior — over-report, never drop a real change. (A "paths-only" degrade
// was explicitly rejected: subtracting by bare path would drop files the
// inner scope genuinely rewrote.)
const GIT_PRE_DIRTY_MAX_ENTRIES = 4096
const GIT_PRE_DIRTY_MAX_JSON_BYTES = 256 * 1024

/**
 * RFC-098 B3 (audit S-4) — sample the worktree's pre-existing dirty set
 * `{path: blobSha | 'deleted'}` at git-wrapper FRESH MINT, right after the
 * baseline capture and inside the same task-write-lock window (no sibling
 * writer can be mid-write while we sample). Best-effort by design: any git
 * failure (no commits yet, fixture without a repo, hash race) degrades to the
 * empty set with a warn — entry must never fail the wrapper, and the empty
 * set only over-reports. Resume NEVER calls this (it reads the persisted map
 * from wrapperProgress; re-capturing after the inner scope started would
 * swallow the inner scope's own writes into the pre-set — silent UNDER-report,
 * worse than today).
 */
async function captureGitPreDirty(
  scope: WrapperGitScope,
  worktreePath: string,
  baseline: string,
  log: Logger,
): Promise<Record<string, string>> {
  try {
    const paths = await scope.changedFiles(worktreePath, baseline || 'HEAD')
    if (paths.length === 0) return {}
    if (paths.length > GIT_PRE_DIRTY_MAX_ENTRIES) {
      log.warn('git wrapper preDirty over entry cap — degrading to empty set (over-report)', {
        worktreePath,
        entries: paths.length,
        cap: GIT_PRE_DIRTY_MAX_ENTRIES,
      })
      return {}
    }
    const hashes = await scope.blobHashes(worktreePath, paths)
    const bytes = new TextEncoder().encode(JSON.stringify(hashes)).byteLength
    if (bytes > GIT_PRE_DIRTY_MAX_JSON_BYTES) {
      log.warn('git wrapper preDirty over JSON-size cap — degrading to empty set (over-report)', {
        worktreePath,
        bytes,
        cap: GIT_PRE_DIRTY_MAX_JSON_BYTES,
      })
      return {}
    }
    return hashes
  } catch (err) {
    log.warn('git wrapper preDirty capture failed — degrading to empty set (over-report)', {
      worktreePath,
      error: describeEffectError(err),
    })
    return {}
  }
}
