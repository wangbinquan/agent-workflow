// RFC-304 T7 — capability hooks: a team's own script at a stage boundary.
//
// Hooks are NOT script nodes (design D4). They have no canvas position, no
// ports, no edges — they mount on a stage NAME and run around it. What they DO
// reuse is the script node's execution machinery: `assembleScriptEnv` builds
// the child environment and `runManagedProcess` runs it under the same timeout,
// output-cap, and TERM→KILL discipline. A second script-execution
// implementation is explicitly not acceptable, so T7's first move was to
// decouple `assembleScriptEnv` from `WorkflowNode` rather than to copy it.
//
// A hook has exactly three powers (design §4.3 F6), and the boundaries between
// them are the interesting part:
//
//   - side effects: it writes the worktree directly. Nothing mediates this; the
//     worktree IS the shared medium.
//   - injecting data: through an envelope, merged against a per-stage
//     ALLOWLIST. An unlisted key is dropped, not merged — otherwise a hook
//     could redefine any artifact the sequence depends on, and the "program
//     stages are deterministic" claim would hold only until someone wrote a
//     creative hook.
//   - aborting: a non-zero exit from a hook that declared `blocking: true`
//     stops the round. A non-blocking hook's failure is recorded and the round
//     continues (design §4.3 F8) — a team's optional lint hook going red should
//     not strand an MR.

import type { ScriptLanguage } from '@agent-workflow/shared'
import type { StageDef } from '@/modules/code-capability/domain/stageContract'
import type { CapabilityScriptEnvironment } from '@/modules/code-capability/application/capabilityScriptRun'
import { runCapabilityScript } from '@/modules/code-capability/application/capabilityScriptRun'

export interface CapabilityHook {
  /** The stage this mounts on; `<parent>/<sub>` inside an invoke sub-sequence. */
  stage: string
  phase: 'pre' | 'post'
  language: ScriptLanguage
  script: string
  /** Author env overlay; product-reserved keys are filtered by the assembler. */
  env?: Record<string, string>
  /**
   * A non-zero exit aborts the round. Default false: a hook that has not
   * claimed the power to stop the line does not get it by accident.
   */
  blocking?: boolean
  /**
   * Which stage-contract version this hook was written against. A hook
   * declaring an older version is reported as needing migration rather than
   * being run or silently skipped (T8) — both alternatives are worse: running
   * it feeds it a shape it does not understand, skipping it means a team's gate
   * quietly stops gating.
   */
  stageContractVer: number
}

/**
 * Hooks run in the same environment as every other capability script; the type
 * is an alias rather than a copy so a field added there reaches hooks too.
 */
export type HookRunEnvironment = CapabilityScriptEnvironment

export type HookOutcome =
  /** Ran, exit 0. `injected` is already allowlist-filtered. */
  | { status: 'ok'; injected: Record<string, string>; droppedKeys: string[] }
  /** Non-zero exit on a blocking hook — the round stops. */
  | { status: 'blocked'; reason: string }
  /** Non-zero exit on a non-blocking hook — recorded, round continues. */
  | { status: 'failed-nonblocking'; reason: string }
  /** Contract version mismatch — never executed. */
  | { status: 'needs-migration'; declared: number; current: number }

/**
 * What a hook at this stage/phase is allowed to inject. Empty (the default)
 * means a hook may still write the worktree and abort, but may not hand data
 * back — which is the right default for a stage nobody has designed an
 * injection point for.
 */
export function injectableKeysFor(stage: StageDef, phase: 'pre' | 'post'): readonly string[] {
  if (phase !== 'pre') return []
  return stage.injectable ?? []
}

export interface RunCapabilityHookArgs {
  hook: CapabilityHook
  stage: StageDef
  env: HookRunEnvironment
  /** The contract version the platform is currently running. */
  currentStageContractVer: number
  signal?: AbortSignal
}

export async function runCapabilityHook(args: RunCapabilityHookArgs): Promise<HookOutcome> {
  const { hook, stage, env } = args

  if (hook.stageContractVer !== args.currentStageContractVer) {
    return {
      status: 'needs-migration',
      declared: hook.stageContractVer,
      current: args.currentStageContractVer,
    }
  }

  const allowlist = injectableKeysFor(stage, hook.phase)

  const result = await runCapabilityScript({
    spec: {
      language: hook.language,
      script: hook.script,
      ...(hook.env === undefined ? {} : { env: hook.env }),
      fileStem: 'hook',
      nodeId: `${hook.phase}:${hook.stage}`,
      declaredPorts: allowlist,
      extraEnv: {
        AW_CWI_STAGE: hook.stage,
        AW_CWI_PHASE: hook.phase,
        // Telling the hook what it MAY inject turns a silent drop into a
        // fixable mistake: the author can print the allowlist while debugging.
        AW_CWI_INJECTABLE: JSON.stringify(allowlist),
      },
    },
    env,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })

  if (result.exitCode !== 0) {
    const reason =
      result.stderrTail.trim().length > 0
        ? result.stderrTail.trim()
        : `hook exited with code ${String(result.exitCode)}`
    return hook.blocking === true
      ? { status: 'blocked', reason }
      : { status: 'failed-nonblocking', reason }
  }

  const injected: Record<string, string> = {}
  for (const key of allowlist) {
    const value = result.ports.get(key)
    // A declared-but-absent port comes back as ''. Injecting an empty string
    // would blank an artifact the hook simply did not mention.
    if (value !== undefined && value !== '') injected[key] = value
  }
  return {
    status: 'ok',
    injected,
    // Reported, not silently swallowed: "my hook's output did nothing" is
    // otherwise an unanswerable support question.
    droppedKeys: result.undeclared.map((p) => p.name),
  }
}
