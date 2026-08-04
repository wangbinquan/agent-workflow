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
import { run as runCommit } from './mode-commit'
import { run as runIntent } from './mode-intent'
import { run as runSlow } from './mode-slow'

type ModeRunner = (argv: readonly string[]) => void | Promise<void>

const MODES: Record<string, ModeRunner> = {
  basic: runBasic,
  commit: runCommit,
  intent: runIntent,
  slow: runSlow,
}

function main(): void {
  const mode = process.env.AW_STUB_MODE ?? ''
  const runner = MODES[mode]
  if (runner === undefined) {
    process.stderr.write(
      `stub-opencode: unknown AW_STUB_MODE ${JSON.stringify(mode)}; ` +
        `known modes: ${Object.keys(MODES).sort().join(', ')}\n`,
    )
    process.exit(2)
  }
  runner(process.argv.slice(2))
}

main()
