// RFC-216 test fixture — runs the REAL sandboxCommand in a child process so its
// read-only behavior (real Bun.spawn / Bun.which / readConfig) can be observed
// under an isolated env. NOT a test file (no `.test.ts`) — invoked via
// process.execPath by rfc216-sandbox-readonly-subprocess.test.ts.
//
// It imports ONLY cli/sandbox (→ config/guidance/probe/process/paths), so it
// loads cleanly regardless of unrelated in-flight work elsewhere in the tree.

import { sandboxCommand } from '../../src/cli/sandbox'

// A test-only platform override lets the Linux (bwrap) scenarios run on a macOS
// host: the probe still does a REAL Bun.spawn of whatever `bwrap` is on PATH.
const fakePlatform = process.env.RFC216_FAKE_PLATFORM as NodeJS.Platform | undefined

const result = await sandboxCommand(
  process.argv.slice(2),
  fakePlatform ? { platform: fakePlatform } : {},
)
process.stdout.write(result.output)
process.exit(result.exitCode)
