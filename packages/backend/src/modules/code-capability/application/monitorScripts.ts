// RFC-304 T35/T35b — running the monitor's four core scripts.
//
// The mechanics live in `capabilityScriptRun` (design D4: one script-execution
// implementation). What is here is the part that differs from a hook, and the
// difference is the whole file.
//
// A hook declares its own `blocking` flag because it is an optional gate a team
// bolted on. A core script produces a REQUIRED INPUT for the next step:
// `collect` failing means there is no `CollectResult`, and under constitution R5
// there is nothing to continue with. So a non-zero exit here ALWAYS blocks the
// round and `blocking` does not apply to these scripts at all (design §7 table).
//
// The tempting alternative — "treat a failed collect as an empty collect" — is
// the exact shape the determinism constitution forbids: it would arbitrate
// against a merge request the platform never actually read, conclude nothing is
// outstanding, and stay silent while a conflict sits there.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import type { ScriptLanguage } from '@agent-workflow/shared'
import type { CapabilityScriptEnvironment } from '@/modules/code-capability/application/capabilityScriptRun'
import { runCapabilityScript } from '@/modules/code-capability/application/capabilityScriptRun'

/** The four core scripts, in the order the loop runs them. */
export const MONITOR_SCRIPTS = ['collect', 'classify', 'arbitrate', 'select'] as const
export type MonitorScriptName = (typeof MONITOR_SCRIPTS)[number]

export interface MonitorScriptDefinition {
  name: MonitorScriptName
  language: ScriptLanguage
  script: string
  env?: Record<string, string>
}

export type MonitorScriptEnvironment = CapabilityScriptEnvironment

export type MonitorScriptOutcome<T> =
  | { status: 'ok'; value: T }
  /**
   * The script failed, or produced something its contract rejects. Both block.
   *
   * One shape for both because the caller's action is identical — stop the round
   * and say why. `reason` is what distinguishes them for the person reading it,
   * and it is written for that person: which script, and what was wrong with
   * what it produced.
   */
  | { status: 'blocked'; reason: string }

export interface RunMonitorScriptArgs<T> {
  definition: MonitorScriptDefinition
  schema: ZodType<T>
  env: MonitorScriptEnvironment
  /** The previous step's output. See `MONITOR_INPUT_FILE` for how it arrives. */
  input?: unknown
  signal?: AbortSignal
}

/**
 * Where the previous step's output is ALWAYS written, inside `runDir`.
 *
 * The standard port protocol hands a value inline as `AW_PORT_INPUT` — until it
 * crosses 32 KiB, at which point it spills to a file and the inline variable is
 * deliberately left absent (so nothing can read half a value and believe it read
 * all of it). That is right for a workflow author's hand-wired port, and wrong
 * here: this input is machine-generated JSON whose size tracks how busy the
 * merge request is. An adapter written as `os.environ["AW_PORT_INPUT"]` would
 * work all through development and then fail with a `KeyError` on exactly the
 * merge requests with the most comments — the ones the monitor exists for.
 *
 * So the input is additionally written to one stable path, every time, whatever
 * its size. The standard port variables are still set, for anyone who wants
 * them; this is the path the adapter guide points at, because it has no cliff.
 */
export const MONITOR_INPUT_FILE = 'monitor-input.json'

/**
 * Run one core script and validate what it produced.
 *
 * Every failure path returns `blocked`. There is deliberately no "continue with
 * a default" branch: a default here is an assertion about a merge request that
 * nobody read.
 */
export async function runMonitorScript<T>(
  args: RunMonitorScriptArgs<T>,
): Promise<MonitorScriptOutcome<T>> {
  const { definition } = args

  const extraEnv: Record<string, string> = { AW_CWI_SCRIPT: definition.name }
  if (args.input !== undefined) {
    mkdirSync(args.env.runDir, { recursive: true })
    const inputPath = join(args.env.runDir, MONITOR_INPUT_FILE)
    writeFileSync(inputPath, JSON.stringify(args.input), 'utf8')
    extraEnv.AW_CWI_INPUT_FILE = inputPath
  }

  const result = await runCapabilityScript({
    spec: {
      language: definition.language,
      script: definition.script,
      ...(definition.env === undefined ? {} : { env: definition.env }),
      fileStem: definition.name,
      nodeId: `monitor:${definition.name}`,
      // The script writes its result to a port named after itself, so an author
      // reading the protocol block never has to guess the port name.
      declaredPorts: [definition.name],
      ...(args.input === undefined ? {} : { inputs: { input: JSON.stringify(args.input) } }),
      extraEnv,
    },
    env: args.env,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })

  if (result.exitCode !== 0) {
    // No `blocking` field is consulted — see the header. These produce required
    // inputs, so "non-blocking failure" would mean continuing with nothing.
    const detail = result.stderrTail.trim()
    return {
      status: 'blocked',
      reason: `the '${definition.name}' script exited ${String(result.exitCode)} — the monitor cannot continue without its result${
        detail === '' ? '' : `: ${detail.slice(0, 400)}`
      }`,
    }
  }

  const raw = result.ports.get(definition.name) ?? ''
  if (raw.trim() === '') {
    return {
      status: 'blocked',
      reason: `the '${definition.name}' script exited 0 but wrote no '${definition.name}' port, so there is no result to use`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      status: 'blocked',
      reason: `the '${definition.name}' script's '${definition.name}' port is not valid JSON`,
    }
  }

  const validated = args.schema.safeParse(parsed)
  if (!validated.success) {
    const first = validated.error.issues[0]
    return {
      status: 'blocked',
      reason: `the '${definition.name}' script's output does not match its contract${
        first === undefined
          ? ''
          : `: ${first.path.length === 0 ? '(root)' : first.path.join('.')} — ${first.message}`
      }`,
    }
  }

  return { status: 'ok', value: validated.data }
}
