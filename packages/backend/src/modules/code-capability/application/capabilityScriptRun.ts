// RFC-304 — the one way this module runs a department-supplied script.
//
// Two callers need it and they are NOT variants of each other:
//
//   - `hookRunner` runs a team's optional gate at a stage boundary. Its failure
//     semantics come off the hook's own `blocking` flag, and its output is an
//     allowlist-filtered injection.
//   - `monitorScripts` runs the four core adapter scripts. Their failure always
//     blocks and their output is a JSON contract (T35b).
//
// What they share is the mechanic: write the script, assemble the child
// environment, run it under the managed-process discipline, parse one envelope.
// Design D4 says a second script-execution implementation is not acceptable —
// so the mechanic lives here once, and each caller supplies only the parts that
// genuinely differ. The interpretation of the result deliberately stays OUT of
// this file: collapsing "blocking hook failed" and "core script failed" into one
// policy is exactly how the T35b distinction would get lost.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptLanguage } from '@agent-workflow/shared'
import { parseEnvelope } from '@/services/envelope'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { assembleScriptEnv, INTERPRETER_SPEC } from '@/services/scriptRun'

/** Work-item context every capability script reads via `AW_CWI_*` (§4.3 F10). */
export interface CapabilityWorkItemContext {
  capability: string
  anchorKind: string
  anchorId: string
  roundId: string
  roundSeq: number
  baselineSha: string | null
}

export interface CapabilityScriptEnvironment {
  /** Where the script runs and writes; the round's worktree. */
  worktreePath: string
  /** Scratch dir for the script file and spilled inputs. */
  runDir: string
  repos: ReadonlyArray<{ name: string; path: string }>
  interpreterPath: string
  workItem: CapabilityWorkItemContext
  envelopeNonce: string
  timeoutMs?: number
}

export interface CapabilityScriptSpec {
  language: ScriptLanguage
  script: string
  /** Author env overlay; product-reserved keys are filtered by the assembler. */
  env?: Record<string, string>
  /** Basename (no extension) for the file written into `runDir`. */
  fileStem: string
  /** Value of `AW_NODE_ID` in the script protocol — how an author identifies a failure. */
  nodeId: string
  /** Envelope ports to parse out. Anything else comes back as `undeclared`. */
  declaredPorts: readonly string[]
  /** Port inputs handed to the script (spilled to files past the env-size cap). */
  inputs?: Record<string, string>
  /**
   * Written AFTER the assembly, so an author overlay cannot shadow them — the
   * whole point of the work-item context is that it describes reality.
   */
  extraEnv?: Record<string, string>
}

export interface CapabilityScriptResult {
  /** null when the child never started. */
  exitCode: number | null
  stderrTail: string
  /** Every declared port; absent ones are `''`, per `parseEnvelope`. */
  ports: Map<string, string>
  /** Declared ports the script never emitted — distinct from emitted-but-empty. */
  missingDeclared: string[]
  /** Ports the script emitted that nothing declared. */
  undeclared: Array<{ name: string; content: string }>
}

export async function runCapabilityScript(args: {
  spec: CapabilityScriptSpec
  env: CapabilityScriptEnvironment
  signal?: AbortSignal
}): Promise<CapabilityScriptResult> {
  const { spec, env } = args
  const interpreter = INTERPRETER_SPEC[spec.language]
  const inputDir = join(env.runDir, 'inputs')
  mkdirSync(inputDir, { recursive: true })
  const scriptPath = join(env.runDir, `${spec.fileStem}.${interpreter.ext}`)
  writeFileSync(scriptPath, spec.script, 'utf8')

  const assembly = assembleScriptEnv({
    language: spec.language,
    // Always the envelope, never bare stdout: a capability script's stdout is a
    // channel that may or may not carry data, so treating it as data would make
    // every debug `print` a contribution to the round.
    outputMode: 'envelope',
    envOverlay: spec.env ?? {},
    inputs: spec.inputs ?? {},
    runDir: env.runDir,
    inputDir,
    worktreePath: env.worktreePath,
    repos: env.repos,
    // Capability scripts are not node runs. These protocol identifiers are
    // filled with the round's identity rather than left blank — an author
    // debugging a failure needs to know WHICH round ran it.
    taskId: env.workItem.roundId,
    nodeId: spec.nodeId,
    nodeRunId: env.workItem.roundId,
    iteration: 0,
    retryIndex: 0,
    shardKey: null,
    envelopeNonce: env.envelopeNonce,
    interpreterPath: env.interpreterPath,
    depsEnv: null,
  })
  for (const file of assembly.spillFiles) writeFileSync(file.path, file.content, 'utf8')

  const childEnv: Record<string, string> = { ...assembly.env }
  childEnv.AW_CWI_CAPABILITY = env.workItem.capability
  childEnv.AW_CWI_ANCHOR_KIND = env.workItem.anchorKind
  childEnv.AW_CWI_ANCHOR_ID = env.workItem.anchorId
  childEnv.AW_CWI_ROUND_ID = env.workItem.roundId
  childEnv.AW_CWI_ROUND_SEQ = String(env.workItem.roundSeq)
  childEnv.AW_CWI_BASELINE_SHA = env.workItem.baselineSha ?? ''
  for (const [key, value] of Object.entries(spec.extraEnv ?? {})) childEnv[key] = value

  const result = await runManagedProcess({
    argv: interpreter.argv(env.interpreterPath, scriptPath),
    cwd: env.worktreePath,
    env: childEnv,
    captureRawStdout: true,
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })

  const parsed = parseEnvelope(result.rawStdout, [...spec.declaredPorts], env.envelopeNonce)
  return {
    exitCode: result.exitCode,
    stderrTail: result.stderrTail,
    ports: parsed.ports,
    missingDeclared: parsed.missingDeclared,
    undeclared: parsed.undeclared,
  }
}
