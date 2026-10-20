import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import {
  selectedAutomationWorkspaceEffects,
  withAutomationWorkspaceEffects,
} from './automationWorkspaceEffects'
// RFC-310 PR-4 —— attempt 编排的 infrastructure 支撑件（composition 注入用）。
//
// 1. AttemptContextStore：pre-state JSON 冻结为 evidence 内容寻址 blob（Agent
//    workspace 之外、Agent 不可达——伪造 pre 快照即伪造回退基准）。
// 2. WorkspaceValidation adapter：K 的 protectedSnapshot/workspaceValidator 与
//    application 端口之间的序列化 glue——protected roots 约定（git-meta =
//    `<ws>/.git`、evidence = `<ws>/.agent-workflow`）也钉在这里，launch 轮拍
//    与 collect 轮重拍必须同一约定。

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { WorkspaceValidationPort } from '../application/ports/reconcilerPorts'
import {
  readProtectedRootSnapshot,
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
} from './protectedSnapshot'
import {
  businessTreeSnapshot,
  readBusinessTreeSnapshot,
  validateWorkspaceOutcome,
  validateWorkspaceOutcomeInScope,
} from './workspaceValidator'
import type { CapabilityWorkspaceMode } from '../domain/capabilityDefinition'

export { createAttemptContextStore } from './local/fileAttemptContextStore'

/** launch/collect 两轮共用的 protected roots 约定。 */
function protectedRootsOf(
  workspacePath: string,
  factory: AutomationWorkspaceEffectsFactory,
): Record<string, string> {
  return {
    'git-meta': factory.resolve(workspacePath, '.git'),
    evidence: factory.resolve(workspacePath, PLATFORM_WORKSPACE_DIR),
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

/**
 * The runtime's own cache in the Git common directory, written by the runtime
 * process rather than by an Agent-side Git command: OpenCode stores its project
 * id at `<git common dir>/opencode` every time it starts in a repository
 * (opencode packages/core/src/project.ts:124-126, called from
 * packages/opencode/src/project/project.ts:306-308). An Agent node runs in an
 * RFC-130 linked worktree whose common directory is the action workspace's
 * `.git`, so the first real OpenCode round of every action workspace reported
 * it as added (RFC-370 hosted acceptance, 2026-10-19). It is not Git state;
 * HEAD, refs, index and config stay covered by the runner's window check.
 */
export const RUNTIME_OWNED_GIT_METADATA_PREFIXES = ['opencode'] as const

/** What the `git-meta` protected root leaves out of its byte comparison. */
export const GIT_METADATA_SKIP_PREFIXES: readonly string[] = [
  ...PLATFORM_OWNED_GIT_METADATA_PREFIXES,
  ...RUNTIME_OWNED_GIT_METADATA_PREFIXES,
]

const PROTECTED_SKIP_PREFIXES_BY_ROOT = {
  'git-meta': GIT_METADATA_SKIP_PREFIXES,
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

export function createWorkspaceValidationAdapter(
  chosen?: AutomationWorkspaceEffectsFactory,
): WorkspaceValidationPort {
  const factory = selectedAutomationWorkspaceEffects(chosen)
  const tree = factory.treeOperations
  return {
    async capturePreState(workspacePath) {
      if (tree !== undefined) {
        // RFC-370 §9.2 V3: a remote volume snapshots both trees itself.
        const pre: SerializedPreState = {
          protected: serializeProtected(
            await snapshotProtectedRoots(
              protectedRootsOf(workspacePath, factory),
              { skipPrefixesByRoot: PROTECTED_SKIP_PREFIXES_BY_ROOT },
              factory,
            ),
          ),
          business: [...(await businessTreeSnapshot(workspacePath, factory)).entries()],
        }
        return JSON.stringify(pre)
      }
      return withAutomationWorkspaceEffects(factory, async (effects) => {
        const pre: SerializedPreState = {
          protected: serializeProtected(
            await readProtectedRootSnapshot(
              protectedRootsOf(workspacePath, factory),
              {
                skipPrefixesByRoot: PROTECTED_SKIP_PREFIXES_BY_ROOT,
              },
              factory,
              effects,
            ),
          ),
          business: [
            ...(await readBusinessTreeSnapshot(workspacePath, factory, effects)).entries(),
          ],
        }
        return JSON.stringify(pre)
      })
    },
    validate(input) {
      const pre = JSON.parse(input.preStateJson) as SerializedPreState
      const request = {
        workspacePath: input.workspacePath,
        preProtected: reviveProtected(pre.protected),
        protectedRoots: protectedRootsOf(input.workspacePath, factory),
        protectedSkipPrefixesByRoot: PROTECTED_SKIP_PREFIXES_BY_ROOT,
        preBusinessTree: new Map(pre.business),
        outcome: input.outcome,
        workspaceMode: input.workspaceMode as CapabilityWorkspaceMode,
        writablePrefixes: input.writablePrefixes,
        preservePaths: input.preservePaths,
        editablePaths: input.editablePaths,
        budget: input.budget,
      }
      if (tree !== undefined) return validateWorkspaceOutcome(request, factory)
      return withAutomationWorkspaceEffects(factory, (effects) =>
        validateWorkspaceOutcomeInScope(request, factory, effects),
      )
    },
  }
}
