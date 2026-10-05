// Runner: spawn ONE opencode subprocess for one node_run, stream its output
// into the DB, persist the parsed envelope, and clean up.
//
// Runtime assembly:
//   * cwd = task worktree
//   * OPENCODE_CONFIG_DIR -> per-run dir for framework-managed skills
//   * OPENCODE_CONFIG_CONTENT -> inline JSON of the agent definition
//     (highest precedence in opencode's merge order; beats repo and $HOME)
//   * No DISABLE flags so repo .opencode/skills + $HOME/.opencode/* still load
//
// Lifecycle:
//   pending -> running    (node_runs row updated with pid + startedAt + prompt)
//   running -> done       (envelope parsed, outputs persisted)
//   running -> failed     (non-zero exit / missing envelope / timeout)
//   running -> canceled   (AbortSignal aborted)
//
// Caller (scheduler / tests) is responsible for INSERT-ing the node_runs row
// in 'pending' state before calling runNode().

// RFC-370: native compatibility delegates to the complete Task common core.
// Selected Task invocations call that same core with their required purpose.
export { runNativeTaskAgent as runNode } from '@/modules/task-execution/infrastructure/local/nativeTaskAgentRun'
export type { RunNodeOptions } from '@/modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions'
export type {
  RunFinalStatus,
  RunResult,
} from '@/modules/task-execution/application/ports/taskAgentRun'
export { detectPluginLoadFailure } from '@/modules/task-execution/infrastructure/local/nativeTaskAgentPluginLoadDiagnostics'
export {
  MAX_STREAM_LINE_CHARS,
  MAX_AGENT_TEXT_CHARS,
  MAX_STDERR_TAIL_CHARS,
  MAX_STDERR_TAIL_LINE_CHARS,
  clampTailLine,
  appendBoundedTail,
} from '@/modules/task-execution/application/taskAgentRun'
// RFC-143 PR-4: SkillSource / ResolvedSkill moved to runtime/types.ts (drivers
// type their skill inputs there); re-exported so scheduler/tests keep resolving.
export type { SkillSource, ResolvedSkill } from './runtime/types'

// RFC-143 PR-4: pickRuntimeHead moved to ./runtime/head.ts (both drivers select
// their argv head there); re-exported for the runtime-spawn-head contract lock.
export { pickRuntimeHead } from './runtime/head'

// RFC-111 PR-A moved opencode runtime helpers to ./runtime/opencode/*; the
// compatibility re-exports that used to live here were DELETED by RFC-282 C0
// (import sites go through @/services/runtime now, and
// rfc282-c0c2-runtime-fence.test.ts locks that this file re-exports nothing
// from the runtime directory). (2026-08-12 审计对账：原注释仍描述已删除的
// re-export 契约，已修正——不要按旧注释在这里恢复任何 runtime re-export。)
