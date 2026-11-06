// RFC-427: the e2e-only compiled-chain oracle behind `agent-workflow __managed-process-output-probe`, moved verbatim
// from `main.ts`. A source `bun test` parent cannot reproduce the production hop (compiled daemon -> compiled launcher
// -> compiled runtime), so the e2e artifact owns this narrow executable check; `main.ts` still refuses it outside
// e2e builds before anything spawns.
import { runManagedProcess } from '@/platform/execution/local/managedProcess'

export async function runManagedProcessOutputProbe(
  target: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly output: string; readonly exitCode: 0 | 1 }> {
  const env = Object.fromEntries(
    Object.entries(processEnv).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      runManagedProcess({
        argv: [target, '--version'],
        cwd: process.cwd(),
        env: { ...env, AW_STUB_MODE: 'basic' },
        requireSpawnReceipt: true,
        captureRawStdout: true,
        onSpawned: () => {},
      }),
    ),
  )
  const expected = 'stub-opencode custom-build'
  const failures = attempts
    .map((result, index) => ({ index, result }))
    .filter(
      ({ result }) =>
        result.outcome !== 'exited' ||
        result.exitCode !== 0 ||
        !result.rawStdout.includes(expected) ||
        result.stderrTail.includes('AW_MANAGED_PROCESS_LAUNCH_'),
    )
  const output = JSON.stringify({
    standaloneHost: {
      processExecPath: process.execPath,
      argv0: Bun.argv[0],
      argv1: Bun.argv[1],
      main: Bun.main,
    },
    attempts: attempts.length,
    failures: failures.map(({ index, result }) => ({
      index,
      outcome: result.outcome,
      exitCode: result.exitCode,
      rawStdout: result.rawStdout,
      stderrTail: result.stderrTail,
      spawnError: result.spawnError,
      pumpError: result.pumpError,
      launcherOutputBytes: result.launcherOutputBytes,
    })),
  })
  return { output, exitCode: failures.length === 0 ? 0 : 1 }
}
