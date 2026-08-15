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

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptLanguage } from '@agent-workflow/shared'
import { parseEnvelope } from '@/services/envelope'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { assembleScriptEnv, INTERPRETER_SPEC } from '@/services/scriptRun'
import type { StageDef } from '@/modules/code-capability/domain/stageContract'

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

export interface HookRunEnvironment {
  /** Where the hook runs and writes; the round's worktree. */
  worktreePath: string
  /** Scratch dir for the script file and spilled inputs. */
  runDir: string
  repos: ReadonlyArray<{ name: string; path: string }>
  interpreterPath: string
  /** Work-item context the hook reads via `AW_CWI_*` (design §4.3 F10). */
  workItem: {
    capability: string
    anchorKind: string
    anchorId: string
    roundId: string
    roundSeq: number
    baselineSha: string | null
  }
  envelopeNonce: string
  timeoutMs?: number
}

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

  const spec = INTERPRETER_SPEC[hook.language]
  const inputDir = join(env.runDir, 'inputs')
  mkdirSync(inputDir, { recursive: true })
  const scriptPath = join(env.runDir, `hook.${spec.ext}`)
  writeFileSync(scriptPath, hook.script, 'utf8')

  const allowlist = injectableKeysFor(stage, hook.phase)

  const assembly = assembleScriptEnv({
    language: hook.language,
    // Hooks always speak the envelope: a hook's stdout is not a port value, it
    // is a channel that may or may not carry an injection. Treating bare stdout
    // as data would make every debug `print` an injection attempt.
    outputMode: 'envelope',
    envOverlay: hook.env ?? {},
    inputs: {},
    runDir: env.runDir,
    inputDir,
    worktreePath: env.worktreePath,
    repos: env.repos,
    // Hooks are not node runs. These identifiers exist in the script protocol,
    // so they are filled with the round's identity rather than left blank —
    // a hook author debugging a failure needs to know WHICH round ran it.
    taskId: env.workItem.roundId,
    nodeId: `${hook.phase}:${hook.stage}`,
    nodeRunId: env.workItem.roundId,
    iteration: 0,
    retryIndex: 0,
    shardKey: null,
    envelopeNonce: env.envelopeNonce,
    interpreterPath: env.interpreterPath,
    depsEnv: null,
  })
  for (const file of assembly.spillFiles) writeFileSync(file.path, file.content, 'utf8')

  // Work-item context (design §4.3 F10). Written after the assembly so these
  // cannot be shadowed by an author overlay.
  const childEnv: Record<string, string> = { ...assembly.env }
  childEnv.AW_CWI_CAPABILITY = env.workItem.capability
  childEnv.AW_CWI_ANCHOR_KIND = env.workItem.anchorKind
  childEnv.AW_CWI_ANCHOR_ID = env.workItem.anchorId
  childEnv.AW_CWI_ROUND_ID = env.workItem.roundId
  childEnv.AW_CWI_ROUND_SEQ = String(env.workItem.roundSeq)
  childEnv.AW_CWI_BASELINE_SHA = env.workItem.baselineSha ?? ''
  childEnv.AW_CWI_STAGE = hook.stage
  childEnv.AW_CWI_PHASE = hook.phase
  // Telling the hook what it MAY inject turns a silent drop into a fixable
  // mistake: the author can print the allowlist while debugging.
  childEnv.AW_CWI_INJECTABLE = JSON.stringify(allowlist)

  const result = await runManagedProcess({
    argv: spec.argv(env.interpreterPath, scriptPath),
    cwd: env.worktreePath,
    env: childEnv,
    captureRawStdout: true,
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
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

  const parsed = parseEnvelope(result.rawStdout, [...allowlist], env.envelopeNonce)
  const injected: Record<string, string> = {}
  for (const key of allowlist) {
    const value = parsed.ports.get(key)
    // A declared-but-absent port comes back as ''. Injecting an empty string
    // would blank an artifact the hook simply did not mention.
    if (value !== undefined && value !== '') injected[key] = value
  }
  return {
    status: 'ok',
    injected,
    // Reported, not silently swallowed: "my hook's output did nothing" is
    // otherwise an unanswerable support question.
    droppedKeys: parsed.undeclared.map((p) => p.name),
  }
}
