// RFC-098 WP-8 — UNcooperative mock opencode (scheduler audit S-15).
//
// mock-opencode.ts is "cooperative": it exits on its own and never traps
// signals, so it can NOT exercise the SIGTERM→SIGKILL escalation, the
// process-group kill, or the bounded reaping the audit demanded. This
// fixture is the adversarial counterpart:
//
//   * traps SIGTERM (ignores it — like a wedged opencode with a hung MCP)
//   * holds itself alive with a setInterval
//   * spawns a grandchild (`bun -e`, also SIGTERM-trapping) that inherits
//     the process group AND our stdout pipe FD, so only a group kill — not
//     a single-pid kill — can both reap it and let the runner's pumps EOF
//   * writes the grandchild pid to $STUBBORN_OPENCODE_GRANDCHILD_PID_FILE
//     so tests can assert the grandchild died with the group
//   * 60s ABSOLUTE self-destruct (design 对抗检视修订 #4): if a buggy
//     implementation/test never kills us, we exit on our own instead of
//     leaking detached process trees on developer machines / CI.
//
// Invoked exactly like mock-opencode:
//   bun run stubborn-opencode.ts run --agent NAME --format json ... -- "<prompt>"

import process from 'node:process'
import { writeFileSync } from 'node:fs'

const SELF_DESTRUCT_MS = 60_000

process.on('SIGTERM', () => {
  // deliberately ignored — that's the whole point of this fixture
})

// Keep the event loop (and therefore the process) alive.
const keepAlive = setInterval(() => {}, 1_000)

// Grandchild: same group (no setsid here), traps SIGTERM too, keeps a copy
// of our stdout FD open, and self-destructs on the same absolute timer.
const grandchildScript = [
  'process.on("SIGTERM", () => {})',
  'setInterval(() => {}, 1000)',
  `setTimeout(() => process.exit(0), ${SELF_DESTRUCT_MS})`,
].join(';')
const grandchild = Bun.spawn({
  cmd: ['bun', '-e', grandchildScript],
  stdout: 'inherit', // hold the parent pipe open so pumps can't EOF early
  stderr: 'ignore',
  stdin: 'ignore',
})

const pidFile = process.env.STUBBORN_OPENCODE_GRANDCHILD_PID_FILE
if (pidFile !== undefined && pidFile.length > 0) {
  writeFileSync(pidFile, String(grandchild.pid))
}

// Emit one parseable line so the runner's stdout pump sees activity.
process.stdout.write(
  JSON.stringify({ type: 'text', text: `stubborn-opencode up pid=${process.pid}` }) + '\n',
)

// Absolute self-destruct — never outlive the suite.
setTimeout(() => {
  clearInterval(keepAlive)
  try {
    grandchild.kill('SIGKILL')
  } catch {
    // already gone
  }
  process.exit(1)
}, SELF_DESTRUCT_MS)
