// RFC-254 T28b — the single compiled e2e stub.
//
// `AW_STUB_MODE` selects the behaviour; every mode is a separate module bundled
// into this one artifact by `bun build --compile`. See ./skeleton.ts for why
// one artifact (and not one file, and not twelve artifacts).
//
// Unknown or missing mode is a HARD failure rather than a silent fallback to
// `basic`: a spec that forgets to set the variable would otherwise appear to
// pass while exercising the wrong stub, which is the class of "green test over
// the wrong thing" this whole RFC keeps running into.

import { run as runBasic } from './mode-basic'
import { run as runBranch } from './mode-branch'
import { run as runBusinessWorkflows } from './mode-business-workflows'
import { run as runBusinessWorkgroups } from './mode-business-workgroups'
import { run as runClarify } from './mode-clarify'
import { run as runClarifyInline } from './mode-clarify-inline'
import { run as runCommit } from './mode-commit'
import { run as runCrossClarify } from './mode-cross-clarify'
import { run as runDevelopment } from './mode-development'
import { run as runFusion } from './mode-fusion'
import { run as runIntent } from './mode-intent'
import { run as runRuntimeScenario } from './mode-runtime-scenario'
import { run as runSlow } from './mode-slow'
import { run as runWorkflowMatrix } from './mode-workflow-matrix'
import { run as runWorkgroupMatrix } from './mode-workgroup-matrix'

type ModeRunner = (argv: readonly string[]) => void | Promise<void>

const MODES: Record<string, ModeRunner> = {
  basic: runBasic,
  branch: runBranch,
  'business-workflows': runBusinessWorkflows,
  'business-workgroups': runBusinessWorkgroups,
  clarify: runClarify,
  'clarify-inline': runClarifyInline,
  commit: runCommit,
  'cross-clarify': runCrossClarify,
  development: runDevelopment,
  fusion: runFusion,
  intent: runIntent,
  'runtime-scenario': runRuntimeScenario,
  slow: runSlow,
  'workflow-matrix': runWorkflowMatrix,
  'workgroup-matrix': runWorkgroupMatrix,
}

async function main(): Promise<void> {
  const mode = process.env.AW_STUB_MODE ?? ''
  const runner = MODES[mode]
  if (runner === undefined) {
    process.stderr.write(
      `stub-opencode: unknown AW_STUB_MODE ${JSON.stringify(mode)}; ` +
        `known modes: ${Object.keys(MODES).sort().join(', ')}\n`,
    )
    process.exit(2)
  }
  // Awaited, not fired and forgotten. The sleeping modes only survive an
  // un-awaited call because a pending timer happens to hold the event loop
  // open; anything that awaits I/O instead would exit early and silently skip
  // its own output.
  await runner(process.argv.slice(2))
}

await main()
