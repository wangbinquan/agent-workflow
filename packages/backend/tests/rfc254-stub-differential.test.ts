// RFC-254 T28b — differential proof that the ported stub matches the shell one.
//
// The design gate (P1-5) was explicit: a mapping table is not a contract, and
// the migration is only safe if the NEW implementation is compared against the
// OLD one on identical inputs before the old one is deleted. So this runs both,
// on the same argv and env, and compares stdout / exit code / side effects
// byte-for-byte.
//
// It runs on POSIX only — the shell stub cannot execute on Windows, which is
// the entire reason for the port. That is not a coverage gap: what Windows
// needs proven is that the PORTED stub works there, which the Windows CI job
// and the real-machine acceptance cover.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const shellStub = (name: string): string => join(REPO_ROOT, 'e2e', 'fixtures', name)
const PORTED_STUB = join(REPO_ROOT, 'e2e', 'fixtures', 'stub', 'dispatch.ts')

interface Capture {
  stdout: string
  stderr: string
  exitCode: number | null
  promptOut: string | null
  inventory: string | null
}

async function capture(
  cmd: string[],
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-stub-diff-'))
  const promptOut = join(dir, 'prompt.txt')
  const inventoryOut = join(dir, 'inventory.json')
  try {
    const child = Bun.spawn({
      cmd: [...cmd, ...args],
      ...(cwd === undefined ? {} : { cwd }),
      env: {
        ...process.env,
        ...env,
        AW_STUB_PROMPT_OUT: promptOut,
        ...(env.WANT_INVENTORY === '1' ? { OPENCODE_AW_INVENTORY_OUT: inventoryOut } : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      stdout,
      stderr,
      exitCode,
      promptOut: existsSync(promptOut) ? readFileSync(promptOut, 'utf8') : null,
      inventory: existsSync(inventoryOut) ? readFileSync(inventoryOut, 'utf8') : null,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NONCE = 'aw-nonce-differential-1234'
const runArgs = (prompt: string): string[] => [
  'run',
  '--agent',
  'coder',
  '--format',
  'json',
  '--',
  prompt,
]

/** Every case the frozen contract calls out for `basic`. */
const CASES: Array<{ name: string; args: string[]; env: Record<string, string> }> = [
  { name: '--version', args: ['--version'], env: {} },
  { name: '-v', args: ['-v'], env: {} },
  { name: 'version', args: ['version'], env: {} },
  { name: 'unsupported mode', args: ['frobnicate'], env: {} },
  { name: 'no args at all', args: [], env: {} },
  {
    name: 'plain run',
    args: runArgs(`do the thing <workflow-output nonce="${NONCE}">`),
    env: {},
  },
  {
    name: 'run with inventory drop requested',
    args: runArgs(`do the thing <workflow-output nonce="${NONCE}">`),
    env: { WANT_INVENTORY: '1' },
  },
  {
    name: 'prompt without a nonce (exit 3 path)',
    args: runArgs('do the thing with no envelope marker'),
    env: {},
  },
  {
    name: 'workgroup leader (wg_decision)',
    args: runArgs(`nonce="${NONCE}" protocol <port name="wg_decision">`),
    env: {},
  },
  {
    name: 'workgroup batch (wg_task_results, batch of 3)',
    args: runArgs(`nonce="${NONCE}" batch of 3 <port name="wg_task_results">`),
    env: {},
  },
  {
    name: 'workgroup batch without an explicit count defaults to 1',
    args: runArgs(`nonce="${NONCE}" <port name="wg_task_results">`),
    env: {},
  },
  {
    name: 'workgroup member (wg_result)',
    args: runArgs(`nonce="${NONCE}" <port name="wg_result">`),
    env: {},
  },
  {
    name: 'batch declaration wins over a prose mention of wg_result',
    args: runArgs(
      `nonce="${NONCE}" batch of 2 <port name="wg_task_results"> ... mentions wg_result in prose`,
    ),
    env: {},
  },
  {
    name: 'LAST nonce wins when the prompt quotes an earlier envelope',
    args: runArgs(`quoted nonce="stale-one" ... real nonce="${NONCE}"`),
    env: {},
  },
]

describe.skipIf(process.platform === 'win32')(
  'RFC-254 T28b — ported stub matches the shell stub',
  () => {
    for (const testCase of CASES) {
      test(`byte-identical: ${testCase.name}`, async () => {
        const [shell, ported] = await Promise.all([
          capture([shellStub('stub-opencode.sh')], testCase.args, testCase.env),
          capture([process.execPath, 'run', PORTED_STUB], testCase.args, {
            ...testCase.env,
            AW_STUB_MODE: 'basic',
          }),
        ])

        expect(ported.exitCode, 'exit code').toBe(shell.exitCode)
        expect(ported.stdout, 'stdout').toBe(shell.stdout)
        expect(ported.promptOut, 'AW_STUB_PROMPT_OUT contents').toBe(shell.promptOut)
        // stderr messages name the stub, which differs by construction; compare
        // only whether an error was produced at all.
        expect(ported.stderr.length > 0, 'produced stderr').toBe(shell.stderr.length > 0)
        if (shell.inventory !== null) {
          expect(JSON.parse(ported.inventory ?? 'null'), 'inventory payload').toEqual(
            JSON.parse(shell.inventory),
          )
        } else {
          expect(ported.inventory, 'inventory not written').toBeNull()
        }
      }, 30_000)
    }

    test('the dispatcher refuses an unknown mode instead of falling back', async () => {
      // A spec that forgets AW_STUB_MODE must fail loudly. Silently running
      // `basic` would produce a green test over the wrong stub.
      const out = await capture([process.execPath, 'run', PORTED_STUB], ['--version'], {
        AW_STUB_MODE: 'no-such-mode',
      })
      expect(out.exitCode).toBe(2)
      expect(out.stderr).toContain('unknown AW_STUB_MODE')
      const missing = await capture([process.execPath, 'run', PORTED_STUB], ['--version'], {})
      expect(missing.exitCode).toBe(2)
    }, 30_000)
  },
)

const COMMIT_CASES: Array<{ name: string; args: string[] }> = [
  { name: '--version', args: ['--version'] },
  { name: 'unsupported mode', args: ['nope'] },
  {
    name: 'commit agent role (prompt mentions commit_message)',
    args: runArgs(`nonce="${NONCE}" please produce a commit_message for this diff`),
  },
  {
    name: 'worker role dirties the worktree',
    args: runArgs(`nonce="${NONCE}" do some work`),
  },
  {
    name: 'missing nonce still exits 3',
    args: runArgs('no envelope marker here'),
  },
]

describe.skipIf(process.platform === 'win32')(
  'RFC-254 T28b — commit mode matches its shell stub',
  () => {
    for (const testCase of COMMIT_CASES) {
      test(`byte-identical: ${testCase.name}`, async () => {
        // Each side runs in its OWN temp cwd: the worker role writes
        // `e2e-change.txt` into the working directory, so a shared cwd would let
        // one side observe the other's side effect.
        const shellCwd = mkdtempSync(join(tmpdir(), 'aw-stub-sh-'))
        const portedCwd = mkdtempSync(join(tmpdir(), 'aw-stub-ts-'))
        try {
          const [shell, ported] = await Promise.all([
            capture([shellStub('stub-opencode-commit.sh')], testCase.args, {}, shellCwd),
            capture(
              [process.execPath, 'run', PORTED_STUB],
              testCase.args,
              { AW_STUB_MODE: 'commit' },
              portedCwd,
            ),
          ])
          expect(ported.exitCode, 'exit code').toBe(shell.exitCode)
          expect(ported.stdout, 'stdout').toBe(shell.stdout)
          expect(ported.stderr.length > 0, 'produced stderr').toBe(shell.stderr.length > 0)
          // The side effect is the point of the worker role: same file, same
          // presence. Content differs only by pid, which is not a contract.
          const shellDirty = existsSync(join(shellCwd, 'e2e-change.txt'))
          const portedDirty = existsSync(join(portedCwd, 'e2e-change.txt'))
          expect(portedDirty, 'worktree dirtied').toBe(shellDirty)
        } finally {
          rmSync(shellCwd, { recursive: true, force: true })
          rmSync(portedCwd, { recursive: true, force: true })
        }
      }, 30_000)
    }
  },
)
