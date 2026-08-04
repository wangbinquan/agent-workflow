// RFC-254 T28b — differential proof that the ported stub matches the shell one.
//
// The design gate (P1-5) was explicit: a mapping table is not a contract, and
// the migration is only safe if the NEW implementation is compared against the
// OLD one on identical inputs before the old one is deleted. So this runs both,
// on the same argv and env, and compares stdout / stderr / exit code / side
// effects byte-for-byte.
//
// Several stubs are ROUND-DRIVEN: what they emit depends on how many times they
// have already been called for a given key. A single invocation would only ever
// exercise round 1 and would call the port proven while the interesting half —
// the state file naming, the counter arithmetic, the round-2 branch — went
// unobserved. Those cases therefore run a SEQUENCE of invocations against one
// state directory per side, and compare the whole transcript plus the resulting
// state files.
//
// It runs on POSIX only — the shell stub cannot execute on Windows, which is
// the entire reason for the port. That is not a coverage gap: what Windows
// needs proven is that the PORTED stub works there, which the Windows CI job
// and the real-machine acceptance cover.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

/** One invocation of the stub. */
interface Step {
  args: string[]
  env?: Record<string, string>
}

interface DiffCase {
  name: string
  /** Shorthand for a single-invocation case. */
  args?: string[]
  env?: Record<string, string>
  /** Several invocations sharing one state directory, in order. */
  steps?: Step[]
  /** Files, relative to the run cwd, whose presence must match on both sides. */
  sideEffects?: string[]
}

interface ModeSpec {
  /** `AW_STUB_MODE` value. */
  mode: string
  /** The shell script it replaces. */
  script: string
  /** Env vars the stub reads as a state DIRECTORY; given a fresh path per side. */
  stateDirEnv?: string[]
  /** Env vars the stub appends to as a LOG FILE; contents compared per side. */
  logFileEnv?: string[]
}

interface SideResult {
  steps: Capture[]
  /** `<env var>/<relative path>` → contents, for every state file written. */
  state: Record<string, string>
  /** Env var name → log contents (null when the stub never wrote it). */
  logs: Record<string, string | null>
  sideEffects: Record<string, boolean>
}

function readTree(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  const out: Record<string, string> = {}
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    out[full.slice(root.length + 1)] = readFileSync(full, 'utf8')
  }
  return out
}

async function runSide(
  cmd: string[],
  modeEnv: Record<string, string>,
  spec: ModeSpec,
  testCase: DiffCase,
): Promise<SideResult> {
  const root = mkdtempSync(join(tmpdir(), 'aw-stub-side-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const sharedEnv: Record<string, string> = { ...modeEnv }
  // Deliberately NOT pre-created: the stubs `mkdir -p` their own state, and a
  // pre-made directory would hide a port that forgot to.
  for (const name of spec.stateDirEnv ?? []) sharedEnv[name] = join(root, `state-${name}`)
  for (const name of spec.logFileEnv ?? []) sharedEnv[name] = join(root, `log-${name}`)
  try {
    const steps: Capture[] = []
    for (const step of testCase.steps ?? [{ args: testCase.args ?? [], env: testCase.env }]) {
      steps.push(await capture(cmd, step.args, { ...sharedEnv, ...step.env }, cwd))
    }
    const state: Record<string, string> = {}
    for (const name of spec.stateDirEnv ?? []) {
      for (const [path, contents] of Object.entries(readTree(sharedEnv[name] ?? ''))) {
        state[`${name}/${path}`] = contents
      }
    }
    const logs: Record<string, string | null> = {}
    for (const name of spec.logFileEnv ?? []) {
      const path = sharedEnv[name] ?? ''
      logs[name] = existsSync(path) ? readFileSync(path, 'utf8') : null
    }
    const sideEffects: Record<string, boolean> = {}
    for (const file of testCase.sideEffects ?? []) sideEffects[file] = existsSync(join(cwd, file))
    return { steps, state, logs, sideEffects }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Register the differential suite for one mode.
 *
 * Every assertion is byte-exact, INCLUDING stderr: the ported stubs are handed
 * their diagnostic name explicitly (see `skeleton.parseInvocation`) precisely so
 * that this comparison can be exact rather than "both produced something".
 */
function differentialSuite(spec: ModeSpec, cases: readonly DiffCase[]): void {
  describe.skipIf(process.platform === 'win32')(
    `RFC-254 T28b — \`${spec.mode}\` mode matches ${spec.script}`,
    () => {
      for (const testCase of cases) {
        test(`byte-identical: ${testCase.name}`, async () => {
          const [shell, ported] = await Promise.all([
            runSide([shellStub(spec.script)], {}, spec, testCase),
            runSide(
              [process.execPath, 'run', PORTED_STUB],
              { AW_STUB_MODE: spec.mode },
              spec,
              testCase,
            ),
          ])

          expect(ported.steps.length, 'step count').toBe(shell.steps.length)
          for (const [index, expected] of shell.steps.entries()) {
            const actual = ported.steps[index]
            const at = `step ${index + 1}`
            expect(actual?.exitCode, `${at} exit code`).toBe(expected.exitCode)
            expect(actual?.stdout, `${at} stdout`).toBe(expected.stdout)
            expect(actual?.stderr, `${at} stderr`).toBe(expected.stderr)
            expect(actual?.promptOut, `${at} AW_STUB_PROMPT_OUT`).toBe(expected.promptOut)
            if (expected.inventory === null) {
              expect(actual?.inventory, `${at} inventory not written`).toBeNull()
            } else {
              expect(JSON.parse(actual?.inventory ?? 'null'), `${at} inventory`).toEqual(
                JSON.parse(expected.inventory),
              )
            }
          }
          // The state files ARE the round counter: if the two sides name or
          // fill them differently then "round 2" means different things on
          // each side, and the transcript above only agreed by luck.
          expect(ported.state, 'state files').toEqual(shell.state)
          expect(ported.logs, 'log files').toEqual(shell.logs)
          expect(ported.sideEffects, 'cwd side effects').toEqual(shell.sideEffects)
        }, 60_000)
      }
    },
  )
}

const NONCE = 'aw-nonce-differential-1234'
const runArgs = (prompt: string, agent = 'coder'): string[] => [
  'run',
  '--agent',
  agent,
  '--format',
  'json',
  '--',
  prompt,
]

differentialSuite({ mode: 'basic', script: 'stub-opencode.sh' }, [
  { name: '--version', args: ['--version'] },
  { name: '-v', args: ['-v'] },
  { name: 'version', args: ['version'] },
  { name: 'unsupported mode', args: ['frobnicate'] },
  { name: 'no args at all', args: [] },
  { name: 'plain run', args: runArgs(`do the thing <workflow-output nonce="${NONCE}">`) },
  {
    name: 'run with inventory drop requested',
    args: runArgs(`do the thing <workflow-output nonce="${NONCE}">`),
    env: { WANT_INVENTORY: '1' },
  },
  {
    name: 'prompt without a nonce (exit 3 path)',
    args: runArgs('do the thing with no envelope marker'),
  },
  {
    name: 'workgroup leader (wg_decision)',
    args: runArgs(`nonce="${NONCE}" protocol <port name="wg_decision">`),
  },
  {
    name: 'workgroup batch (wg_task_results, batch of 3)',
    args: runArgs(`nonce="${NONCE}" batch of 3 <port name="wg_task_results">`),
  },
  {
    name: 'workgroup batch without an explicit count defaults to 1',
    args: runArgs(`nonce="${NONCE}" <port name="wg_task_results">`),
  },
  {
    name: 'workgroup member (wg_result)',
    args: runArgs(`nonce="${NONCE}" <port name="wg_result">`),
  },
  {
    name: 'batch declaration wins over a prose mention of wg_result',
    args: runArgs(
      `nonce="${NONCE}" batch of 2 <port name="wg_task_results"> ... mentions wg_result in prose`,
    ),
  },
  {
    name: 'LAST nonce wins when the prompt quotes an earlier envelope',
    args: runArgs(`quoted nonce="stale-one" ... real nonce="${NONCE}"`),
  },
])

differentialSuite({ mode: 'commit', script: 'stub-opencode-commit.sh' }, [
  { name: '--version', args: ['--version'] },
  { name: 'unsupported mode', args: ['nope'] },
  {
    name: 'commit agent role (prompt mentions commit_message)',
    args: runArgs(`nonce="${NONCE}" please produce a commit_message for this diff`),
    sideEffects: ['e2e-change.txt'],
  },
  {
    name: 'worker role dirties the worktree',
    args: runArgs(`nonce="${NONCE}" do some work`),
    sideEffects: ['e2e-change.txt'],
  },
  { name: 'missing nonce still exits 3', args: runArgs('no envelope marker here') },
])

differentialSuite({ mode: 'intent', script: 'stub-opencode-intent.sh' }, [
  { name: '--version', args: ['--version'] },
  { name: 'unsupported mode', args: ['nope'] },
  { name: 'missing nonce exits 3', args: runArgs('no marker') },
  { name: 'default (agent) variant', args: runArgs(`nonce="${NONCE}" build me an auditor`) },
  {
    name: 'workflow variant (the old intent-workflow launcher)',
    args: runArgs(`nonce="${NONCE}" build me a workflow`),
    env: { STUB_INTENT_VARIANT: 'workflow' },
  },
])

differentialSuite({ mode: 'slow', script: 'stub-opencode-slow.sh' }, [
  { name: '--version', args: ['--version'] },
  { name: 'unsupported mode', args: ['nope'] },
  { name: 'missing nonce exits 3', args: runArgs('no marker') },
  { name: 'plain run', args: runArgs(`nonce="${NONCE}" work`) },
  {
    name: 'sub-second sleep is floored to zero (shell integer division)',
    args: runArgs(`nonce="${NONCE}" work`),
    env: { STUB_OPENCODE_SLEEP_MS: '500' },
  },
  {
    name: 'no-envelope path',
    args: runArgs(`nonce="${NONCE}" work`),
    env: { STUB_OPENCODE_SKIP_ENVELOPE: '1' },
  },
  {
    name: 'non-zero exit path',
    args: runArgs(`nonce="${NONCE}" work`),
    env: { STUB_OPENCODE_EXIT_CODE: '7' },
  },
  {
    name: 'no envelope AND non-zero exit',
    args: runArgs(`nonce="${NONCE}" work`),
    env: { STUB_OPENCODE_SKIP_ENVELOPE: '1', STUB_OPENCODE_EXIT_CODE: '9' },
  },
  {
    name: 'inventory drop requested',
    args: runArgs(`nonce="${NONCE}" work`),
    env: { WANT_INVENTORY: '1' },
  },
])

differentialSuite(
  {
    mode: 'clarify',
    script: 'stub-opencode-clarify.sh',
    stateDirEnv: ['CLARIFY_STUB_STATE'],
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing nonce exits 3', args: runArgs('no marker') },
    {
      name: 'round 1 asks, round 2 finalises',
      steps: [
        { args: runArgs(`nonce="${NONCE}" design it`, 'designer') },
        { args: runArgs(`nonce="${NONCE}" design it`, 'designer') },
        { args: runArgs(`nonce="${NONCE}" design it`, 'designer') },
      ],
    },
    {
      name: 'rounds are counted per agent, not globally',
      steps: [
        { args: runArgs(`nonce="${NONCE}" go`, 'alpha') },
        { args: runArgs(`nonce="${NONCE}" go`, 'beta') },
        { args: runArgs(`nonce="${NONCE}" go`, 'alpha') },
        { args: runArgs(`nonce="${NONCE}" go`, 'beta') },
      ],
    },
    {
      name: 'an agent name needing sanitising still shares one counter',
      // `tr -c 'A-Za-z0-9._-' '_'` folds the slash and the space; if the port
      // folded them differently the two calls would land on different files and
      // round 2 would ask again instead of finalising.
      steps: [
        { args: runArgs(`nonce="${NONCE}" go`, 'weird name/v2') },
        { args: runArgs(`nonce="${NONCE}" go`, 'weird name/v2') },
      ],
    },
    {
      name: 'a repeated --agent resolves the way the shell walk does',
      // The shell CONSUMES the value it read, so `--agent --agent x` names the
      // agent `--agent`; a "find the flag, take the next token" scan would say
      // `x`. Nothing else in this suite tells those two apart, so without this
      // case the consuming walk in `parseFlags` would be untested reasoning.
      steps: [
        {
          args: ['run', '--agent', '--agent', 'x', '--format', 'json', '--', `nonce="${NONCE}" go`],
        },
      ],
    },
    {
      name: 'a trailing --agent with no value falls back to `default`',
      steps: [{ args: ['run', '--', `nonce="${NONCE}" go`, '--agent'] }],
    },
    {
      name: 'MOCK_OPENCODE_SHARD_KEY separates counters for the same agent',
      steps: [
        {
          args: runArgs(`nonce="${NONCE}" go`, 'auditor'),
          env: { MOCK_OPENCODE_SHARD_KEY: 'a.ts' },
        },
        {
          args: runArgs(`nonce="${NONCE}" go`, 'auditor'),
          env: { MOCK_OPENCODE_SHARD_KEY: 'b.ts' },
        },
        {
          args: runArgs(`nonce="${NONCE}" go`, 'auditor'),
          env: { MOCK_OPENCODE_SHARD_KEY: 'a.ts' },
        },
      ],
    },
    {
      name: 'ASK_SHARDS: only the named shard asks on its first call',
      // The T29 shape: three shards, one asks back. The shard is recovered from
      // the rendered prompt (`Audit <shard>.`), not from the env, because the
      // runner does not forward the shard key into the child.
      steps: [
        {
          args: runArgs(`nonce="${NONCE}" Audit src/a.ts.`, 'auditor'),
          env: { CLARIFY_STUB_ASK_SHARDS: 'src/a.ts' },
        },
        {
          args: runArgs(`nonce="${NONCE}" Audit src/b.ts.`, 'auditor'),
          env: { CLARIFY_STUB_ASK_SHARDS: 'src/a.ts' },
        },
        {
          args: runArgs(`nonce="${NONCE}" Audit src/a.ts.`, 'auditor'),
          env: { CLARIFY_STUB_ASK_SHARDS: 'src/a.ts' },
        },
      ],
    },
    {
      name: 'ASK_SHARDS with several entries picks the FIRST that matches',
      steps: [
        {
          args: runArgs(`nonce="${NONCE}" Audit two.ts and one.ts.`, 'auditor'),
          env: { CLARIFY_STUB_ASK_SHARDS: 'one.ts  two.ts' },
        },
      ],
    },
    {
      name: 'ASK_SHARDS set but nothing matches: finalises immediately',
      steps: [
        {
          args: runArgs(`nonce="${NONCE}" Audit zzz.ts.`, 'auditor'),
          env: { CLARIFY_STUB_ASK_SHARDS: 'one.ts' },
        },
      ],
    },
  ],
)

differentialSuite(
  {
    mode: 'clarify-inline',
    script: 'stub-opencode-clarify-inline.sh',
    stateDirEnv: ['CLARIFY_STUB_STATE'],
    logFileEnv: ['CLARIFY_INLINE_ARGV_LOG', 'CLARIFY_INLINE_SESSION_LOG'],
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing nonce exits 3 (but still logs argv)', args: runArgs('no marker') },
    {
      name: 'round 0 asks and mints a session; round 1 resumes it and finalises',
      steps: [
        { args: runArgs(`nonce="${NONCE}" design it`, 'designer') },
        {
          args: [
            'run',
            '--agent',
            'designer',
            '--session',
            'opc_e2e_designer',
            '--format',
            'json',
            '--',
            `nonce="${NONCE}" design it`,
          ],
        },
      ],
    },
    {
      name: 'the session log records the PARSED flag, not a prompt that mentions it',
      // The prompt below contains the literal `--session opc_e2e_fake`; the
      // logged value must stay empty because the FLAG was never passed.
      steps: [{ args: runArgs(`nonce="${NONCE}" pass --session opc_e2e_fake to it`, 'designer') }],
    },
  ],
)

differentialSuite(
  {
    mode: 'cross-clarify',
    script: 'stub-opencode-cross-clarify.sh',
    stateDirEnv: ['CROSS_CLARIFY_STUB_STATE'],
    logFileEnv: ['CROSS_CLARIFY_PROMPT_LOG'],
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing nonce exits 3', args: runArgs('no marker') },
    {
      name: 'the RFC-162 sequence: designer once, questioner asks twice then finalises',
      steps: [
        { args: runArgs(`nonce="${NONCE}" design it`, 'designer') },
        { args: runArgs(`nonce="${NONCE}" review it`, 'questioner') },
        { args: runArgs(`nonce="${NONCE}" review it ## Clarify Q&A`, 'questioner') },
        { args: runArgs(`nonce="${NONCE}" review it ## Clarify Q&A`, 'questioner') },
      ],
    },
    {
      name: 'an unknown agent takes the `other vN` branch and keeps its own count',
      steps: [
        { args: runArgs(`nonce="${NONCE}" go`, 'someone-else') },
        { args: runArgs(`nonce="${NONCE}" go`, 'someone-else') },
      ],
    },
    {
      name: 'the designer never asks, however many times it runs',
      steps: [
        { args: runArgs(`nonce="${NONCE}" go`, 'designer') },
        { args: runArgs(`nonce="${NONCE}" go`, 'designer') },
        { args: runArgs(`nonce="${NONCE}" go`, 'designer') },
      ],
    },
  ],
)

describe.skipIf(process.platform === 'win32')(
  'RFC-254 T28b — where the shell original had no single answer',
  () => {
    test('a non-ASCII agent name still lands on ONE state file across rounds', async () => {
      // The shell derived its state-file name with `tr -c 'A-Za-z0-9._-' '_'`,
      // whose granularity is locale-dependent: BSD tr under a UTF-8 locale folds
      // `设计者` to 3 underscores, the same tr under LC_ALL=C — and GNU tr always
      // — folds it to 9. A differential assertion here would only be pinning
      // whichever shell happened to run, so what is asserted instead is the
      // property the counter actually needs: two calls for one agent must share
      // one file, so round 2 finalises rather than asking again forever.
      const root = mkdtempSync(join(tmpdir(), 'aw-stub-fold-'))
      try {
        const args = runArgs(`nonce="${NONCE}" go`, '设计者')
        const env = { AW_STUB_MODE: 'clarify', CLARIFY_STUB_STATE: root }
        const first = await capture([process.execPath, 'run', PORTED_STUB], args, env)
        const second = await capture([process.execPath, 'run', PORTED_STUB], args, env)
        expect(first.stdout).toContain('<workflow-clarify')
        expect(second.stdout).toContain('<workflow-output')
        expect(Object.keys(readTree(root)), 'exactly one counter file').toHaveLength(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  },
)

describe.skipIf(process.platform === 'win32')('RFC-254 T28b — dispatcher', () => {
  test('refuses an unknown mode instead of falling back', async () => {
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

  test('the workflow launcher is the same mode with a variable, not a separate stub', async () => {
    // `intent-workflow-opencode.sh` was two lines: export the variant, exec the
    // intent stub. Proving the ported mode reproduces IT too is what lets the
    // launcher file be deleted rather than ported.
    const args = runArgs(`nonce="${NONCE}" build me a workflow`)
    const [launcher, ported] = await Promise.all([
      capture([shellStub('intent-workflow-opencode.sh')], args, {}),
      capture([process.execPath, 'run', PORTED_STUB], args, {
        AW_STUB_MODE: 'intent',
        STUB_INTENT_VARIANT: 'workflow',
      }),
    ])
    expect(ported.stdout).toBe(launcher.stdout)
    expect(ported.exitCode).toBe(launcher.exitCode)
  }, 30_000)
})
