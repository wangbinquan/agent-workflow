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
import { readProtectedRootSnapshot, type ProtectedRootSnapshot } from './protectedSnapshot'
import { readBusinessTreeSnapshot, validateWorkspaceOutcomeInScope } from './workspaceValidator'
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

export function createWorkspaceValidationAdapter(
  chosen?: AutomationWorkspaceEffectsFactory,
): WorkspaceValidationPort {
  const factory = selectedAutomationWorkspaceEffects(chosen)
  return {
    capturePreState(workspacePath) {
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
      return withAutomationWorkspaceEffects(factory, (effects) =>
        validateWorkspaceOutcomeInScope(
          {
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
          },
          factory,
          effects,
        ),
      )
    },
  }
}
