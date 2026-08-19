// RFC-310 PR-4 —— attempt 编排的 infrastructure 支撑件（composition 注入用）。
//
// 1. AttemptContextStore：pre-state JSON 冻结为 evidence 内容寻址 blob（Agent
//    workspace 之外、Agent 不可达——伪造 pre 快照即伪造回退基准）。
// 2. WorkspaceValidation adapter：K 的 protectedSnapshot/workspaceValidator 与
//    application 端口之间的序列化 glue——protected roots 约定（git-meta =
//    `<ws>/.git`、evidence = `<ws>/.agent-workflow`）也钉在这里，launch 轮拍
//    与 collect 轮重拍必须同一约定。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type {
  AttemptContextStorePort,
  WorkspaceValidationPort,
} from '../application/ports/reconcilerPorts'
import type { EvidenceStore } from './evidenceStore'
import { snapshotProtectedRoots, type ProtectedRootSnapshot } from './protectedSnapshot'
import { businessTreeSnapshot, validateWorkspaceOutcome } from './workspaceValidator'
import type { CapabilityWorkspaceMode } from '../domain/capabilityDefinition'

export function createAttemptContextStore(evidence: EvidenceStore): AttemptContextStorePort {
  return {
    async save(json) {
      const staging = mkdtempSync(join(tmpdir(), 'aw-attempt-ctx-'))
      try {
        const file = join(staging, 'context.json')
        writeFileSync(file, json)
        const blob = await evidence.putBlobFromFile(file)
        return blob.sha256
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    },
    load(ref) {
      if (!/^[0-9a-f]{64}$/.test(ref)) return null
      const path = evidence.blobPath(ref)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}

/** launch/collect 两轮共用的 protected roots 约定。 */
function protectedRootsOf(workspacePath: string): Record<string, string> {
  return {
    'git-meta': join(workspacePath, '.git'),
    evidence: join(workspacePath, PLATFORM_WORKSPACE_DIR),
  }
}

/**
 * TaskEngine owns these paths across one whole attempt: RFC-130 creates and
 * removes isolated worktrees, snapshots full state into its private ref
 * namespace, and refreshes the common object store/index/config. They cannot
 * identify an Agent-side Git command in an attempt-wide byte snapshot.
 *
 * The runner therefore enforces the Agent's no-Git contract over the exact
 * child-process window (HEAD, refs, index and config semantic state). Keep the
 * evidence root completely unfiltered here.
 */
export const PLATFORM_OWNED_GIT_METADATA_PREFIXES = [
  'ORIG_HEAD',
  'agent-workflow',
  'config',
  'config.worktree',
  'index',
  'logs',
  'objects',
  'refs/agent-workflow',
  'worktrees',
] as const

const PROTECTED_SKIP_PREFIXES_BY_ROOT = {
  'git-meta': PLATFORM_OWNED_GIT_METADATA_PREFIXES,
} as const

interface SerializedPreState {
  readonly protected: {
    readonly digest: string
    readonly entries: readonly (readonly [string, readonly (readonly [string, string])[]])[]
  }
  readonly business: readonly (readonly [string, string])[]
}

function serializeProtected(snapshot: ProtectedRootSnapshot): SerializedPreState['protected'] {
  return {
    digest: snapshot.digest,
    entries: [...snapshot.entries.entries()].map(
      ([root, files]) => [root, [...files.entries()]] as const,
    ),
  }
}

function reviveProtected(value: SerializedPreState['protected']): ProtectedRootSnapshot {
  return {
    digest: value.digest,
    entries: new Map(value.entries.map(([root, files]) => [root, new Map(files)])),
  }
}

export function createWorkspaceValidationAdapter(): WorkspaceValidationPort {
  return {
    capturePreState(workspacePath) {
      const pre: SerializedPreState = {
        protected: serializeProtected(
          snapshotProtectedRoots(protectedRootsOf(workspacePath), {
            skipPrefixesByRoot: PROTECTED_SKIP_PREFIXES_BY_ROOT,
          }),
        ),
        business: [...businessTreeSnapshot(workspacePath).entries()],
      }
      return JSON.stringify(pre)
    },
    validate(input) {
      const pre = JSON.parse(input.preStateJson) as SerializedPreState
      return validateWorkspaceOutcome({
        workspacePath: input.workspacePath,
        preProtected: reviveProtected(pre.protected),
        protectedRoots: protectedRootsOf(input.workspacePath),
        protectedSkipPrefixesByRoot: PROTECTED_SKIP_PREFIXES_BY_ROOT,
        preBusinessTree: new Map(pre.business),
        outcome: input.outcome,
        workspaceMode: input.workspaceMode as CapabilityWorkspaceMode,
        writablePrefixes: input.writablePrefixes,
        preservePaths: input.preservePaths,
        editablePaths: input.editablePaths,
        budget: input.budget,
      })
    },
  }
}
