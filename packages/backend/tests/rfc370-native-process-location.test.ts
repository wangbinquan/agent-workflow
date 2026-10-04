import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_PROCESS_LAUNCH_NONCE_ENV,
  MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX,
  MANAGED_PROCESS_LAUNCH_READY_PREFIX,
} from '../src/services/execution/managedProcessLauncher'

const roots: string[] = []
const entries = [
  {
    name: 'legacy',
    path: join(import.meta.dir, '..', 'src', 'services', 'execution', 'managedProcessLauncher.ts'),
  },
  {
    name: 'local',
    path: join(
      import.meta.dir,
      '..',
      'src',
      'platform',
      'execution',
      'local',
      'managedProcessLauncher.ts',
    ),
  },
] as const

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-rfc370-native-process-')))
  roots.push(root)
  return root
}

describe.each(entries)('RFC-370 $name launcher CLI compatibility', ({ path }) => {
  test('delivers the complete activation frame, cwd, environment and one-shot stdin', async () => {
    const root = fixtureRoot()
    const stdoutPath = join(root, 'stdout')
    const stderrPath = join(root, 'stderr')
    const controlPath = join(root, 'control')
    for (const output of [stdoutPath, stderrPath, controlPath]) writeFileSync(output, '')
    const launchNonce = 'rfc370-native-frame'
    const input = 'original one-shot stdin\n中文\n'
    const launcher = Bun.spawn({
      cmd: [process.execPath, 'run', path],
      cwd: root,
      env: { ...process.env, [MANAGED_PROCESS_LAUNCH_NONCE_ENV]: launchNonce },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const streamedStdout = new Response(launcher.stdout).text()
    const streamedStderr = new Response(launcher.stderr).text()
    const sink = launcher.stdin as { write(data: string): void; end(): void }
    sink.write(
      JSON.stringify({
        v: 1,
        launchNonce,
        targetArgv: [
          process.execPath,
          '-e',
          "const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env.AW_RFC370_FRAME_VALUE, input })); process.stderr.write('native-frame-stderr')",
        ],
        targetEnv: { ...process.env, AW_RFC370_FRAME_VALUE: 'selected-frame-value' },
        stdin: { mode: 'pipe', data: input },
        windowsOutputPaths: { stdoutPath, stderrPath, controlPath },
      }),
    )
    sink.end()

    const [exitCode, stdout, stderr] = await Promise.all([
      launcher.exited,
      streamedStdout,
      streamedStderr,
    ])
    expect(exitCode).toBe(0)
    const capturedStdout = process.platform === 'win32' ? readFileSync(stdoutPath, 'utf8') : stdout
    const capturedStderr = process.platform === 'win32' ? readFileSync(stderrPath, 'utf8') : stderr
    expect(JSON.parse(capturedStdout)).toEqual({
      cwd: root,
      value: 'selected-frame-value',
      input,
    })
    expect(capturedStderr).toBe('native-frame-stderr')
    const control = readFileSync(controlPath, 'utf8')
    expect(control).toContain(`${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${launchNonce}`)
    if (process.platform === 'win32') {
      expect(control).toContain(`${MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX}${launchNonce}:`)
    } else {
      expect(control).not.toContain(MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX)
    }
  }, 10_000)

  test('EOF without an activation frame returns the original failure and never runs the target', async () => {
    const root = fixtureRoot()
    const marker = join(root, 'must-not-run')
    const launchNonce = 'rfc370-native-eof'
    const launcher = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        path,
        '__managed-process-launcher',
        '--launch-nonce',
        launchNonce,
        '--',
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(marker)}, 'unexpected')`,
      ],
      cwd: root,
      env: { ...process.env, [MANAGED_PROCESS_LAUNCH_NONCE_ENV]: launchNonce },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const sink = launcher.stdin as { end(): void }
    sink.end()

    expect(await launcher.exited).toBe(125)
    expect(existsSync(marker)).toBe(false)
  }, 10_000)
})
