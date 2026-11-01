/** Compile on the host with Bun 1.4.3; no product code or old binary is patched. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// Sandboxed releases (v0.16.x seatbelt) launch the runtime with a scrubbed environment. Each
// scenario home therefore gets its own shim copy with `shim.json` beside it; the environment
// still wins when it is passed through.
const settingsPath = join(dirname(process.execPath), 'shim.json')
const settings = (
  existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
) as Record<string, string | undefined>
const setting = (name: string) => process.env[name] ?? settings[name]
const argv = process.argv.slice(2)
if (argv.includes('--version') || argv[0] === '-v' || argv[0] === 'version') {
  console.log(setting('AW_RELEASE_OPENCODE_VERSION') ?? '1.18.3')
  process.exit(0)
}
const stub = setting('AW_RELEASE_STUB_EXECUTABLE')
if (!stub) throw new Error('AW_RELEASE_STUB_EXECUTABLE is required')
let delimiter = argv.indexOf('--')
if (argv[0] === 'run' && delimiter < 0) {
  // Earliest releases use `run <prompt> --agent ...`; newer ones delimit the
  // final positional, or use stdin for prompts over the native argv budget.
  const input = argv[1] && !argv[1].startsWith('-') ? argv.splice(1, 1)[0]! : await Bun.stdin.text()
  argv.push('--', input)
  delimiter = argv.indexOf('--')
}
const prompt = argv[delimiter + 1] ?? ''
const legacy = setting('AW_RELEASE_LEGACY_ENVELOPE') === '1'
if (legacy && delimiter >= 0)
  argv[delimiter + 1] = `${prompt}\n<workflow-output nonce="rfc398-legacy-transport">`
// Lifecycle variants are selected by the fixture prompt, so one daemon can
// run all five states. Business content still comes from the compiled repo stub.
let mode = 'business-workflows'
if (prompt.includes('RFC398_HOLD_UNTIL_CANCEL')) {
  const keepAlive = setInterval(() => {}, 60_000)
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  clearInterval(keepAlive)
  process.exit(143)
}
if (prompt.includes('RFC398_AWAIT_HUMAN')) mode = 'clarify'
const stateEnv = Object.fromEntries(
  ['BUSINESS_WORKFLOW_STATE_DIR', 'CLARIFY_STUB_STATE'].flatMap((name) => {
    const value = setting(name)
    return value === undefined ? [] : [[name, value]]
  }),
)
const proc = Bun.spawn([stub, ...argv], {
  env: { ...process.env, ...stateEnv, AW_STUB_MODE: mode },
  stdin: 'inherit',
  stdout: 'pipe',
  stderr: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => proc.kill(signal))
// Strip only the synthetic nonce used for pre-RFC-200 binaries; preserve values.
const decoder = new TextDecoder()
let pending = ''
for await (const chunk of proc.stdout) {
  pending += decoder.decode(chunk, { stream: true })
  let newline: number
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    process.stdout.write(
      `${legacy ? line.replaceAll(' nonce=\\"rfc398-legacy-transport\\"', '') : line}\n`,
    )
  }
}
pending += decoder.decode()
if (pending)
  process.stdout.write(
    legacy ? pending.replaceAll(' nonce=\\"rfc398-legacy-transport\\"', '') : pending,
  )
process.exit(await proc.exited)
