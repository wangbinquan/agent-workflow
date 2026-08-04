// RFC-254 T28b — the ported e2e stub must reproduce the behaviour of the stub
// it replaced, byte for byte.
//
// The design gate (P1-5) was explicit: a mapping table is not a contract, and
// the migration is only safe if the NEW implementation is compared against the
// OLD one on identical inputs before the old one is deleted.
//
// HOW THE PROOF SURVIVED THE DELETION
// -----------------------------------
// The originals were nine `#!/bin/sh` scripts and three `bun run` files. They
// could not stay: a shell script is not executable on Windows, which is the
// whole reason for the port. So before deleting them their actual observable
// behaviour — stdout, stderr, exit code, state files, log files, worktree side
// effects, across every case below — was RECORDED into
// `fixtures/stub-goldens/`, and this suite now replays the ported stub against
// those recordings. The comparison is the same one that ran against the live
// originals; only the other side of it is now a file.
//
// Re-record with `UPDATE_STUB_GOLDENS=1`, which runs the ORIGINAL — so it works
// only in a checkout that still has them, i.e. it is not a way to bless a
// regression. Deleting a golden is not a way either: a missing one fails.
//
// Several stubs are ROUND-DRIVEN: what they emit depends on how many times they
// have already been called for a given key. A single invocation would only ever
// exercise round 1 and would call the port proven while the interesting half —
// the state file naming, the counter arithmetic, the round-2 branch — went
// unobserved. Those cases therefore run a SEQUENCE of invocations against one
// state directory, and the whole transcript plus the resulting state is what
// gets compared.
//
// Unlike the live-comparison form, this runs on Windows too: replaying a
// recording needs no `sh`.

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const originalStub = (name: string): string => join(REPO_ROOT, 'e2e', 'fixtures', name)
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
  /**
   * Record this case against a DIFFERENT original than the mode's own.
   * `intent-workflow-opencode.sh` was two lines — export a variant, exec the
   * intent stub — so the ported mode has to reproduce it too, and that is what
   * lets the launcher be deleted rather than ported.
   */
  originalScript?: string
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
  /**
   * Rewrite stdout before comparing. Needed only where the ORIGINAL stub was
   * already non-deterministic — the three TypeScript ones stamp `Date.now()`
   * into every event. Scoped per mode so it cannot quietly loosen the others.
   */
  normalizeStdout?: (text: string) => string
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
    // Forward slashes in the KEY: a golden recorded on POSIX is replayed on
    // Windows, where `join` yields backslashes and every entry would otherwise
    // miss. (The platform-surface guard had this exact defect — the one it
    // exists to catch — until Windows CI found it.)
    out[
      full
        .slice(root.length + 1)
        .split(sep)
        .join('/')
    ] = readFileSync(full, 'utf8')
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
  // Each side runs under its own temp root, so any path a stub records differs
  // between them BY CONSTRUCTION. Mask this side's own root — and its realpath,
  // because macOS resolves /var to /private/var and `process.cwd()` returns the
  // resolved form while `mkdtemp` returned the symlinked one.
  // Longest first: the cwd is INSIDE the root, so replacing the root first
  // would leave a bare `/cwd` (or `\\cwd`) behind and the two platforms would
  // still disagree. The stubs record their cwd — the business ones write it
  // into prompts.jsonl — so it has to become a stable token too.
  const masks: Array<[string, string]> = [
    [realpathSync(cwd), '<SIDE_CWD>'],
    [cwd, '<SIDE_CWD>'],
    [realpathSync(root), '<SIDE_ROOT>'],
    [root, '<SIDE_ROOT>'],
  ]
  const redact = (text: string): string => {
    let out = text
    for (const [path, token] of masks) out = out.replaceAll(path, token)
    return out
  }
  const sharedEnv: Record<string, string> = { ...modeEnv }
  // Deliberately NOT pre-created: the stubs `mkdir -p` their own state, and a
  // pre-made directory would hide a port that forgot to.
  for (const name of spec.stateDirEnv ?? []) sharedEnv[name] = join(root, `state-${name}`)
  for (const name of spec.logFileEnv ?? []) sharedEnv[name] = join(root, `log-${name}`)
  try {
    const steps: Capture[] = []
    for (const step of testCase.steps ?? [{ args: testCase.args ?? [], env: testCase.env }]) {
      const run = await capture(cmd, step.args, { ...sharedEnv, ...step.env }, cwd)
      steps.push({ ...run, stdout: redact(run.stdout), stderr: redact(run.stderr) })
    }
    const state: Record<string, string> = {}
    for (const name of spec.stateDirEnv ?? []) {
      for (const [path, contents] of Object.entries(readTree(sharedEnv[name] ?? ''))) {
        state[`${name}/${path}`] = redact(contents)
      }
    }
    const logs: Record<string, string | null> = {}
    for (const name of spec.logFileEnv ?? []) {
      const path = sharedEnv[name] ?? ''
      logs[name] = existsSync(path) ? redact(readFileSync(path, 'utf8')) : null
    }
    const sideEffects: Record<string, boolean> = {}
    for (const file of testCase.sideEffects ?? []) sideEffects[file] = existsSync(join(cwd, file))
    return { steps, state, logs, sideEffects }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The TypeScript stubs stamp a real clock into every event. That was fine when
// each was its own program; comparing two runs of it needs the clock masked.
const maskTimestamps = (text: string): string =>
  text.replaceAll(/"timestamp":\d+/g, '"timestamp":T')

const GOLDEN_DIR = join(import.meta.dir, 'fixtures', 'stub-goldens')
const RECORDING = process.env.UPDATE_STUB_GOLDENS === '1'

/** Everything about a run that the comparison looks at, in a JSON-safe shape. */
type Golden = Record<string, SideResult>

function goldenPath(mode: string): string {
  return join(GOLDEN_DIR, `${mode}.json`)
}

function readGolden(mode: string): Golden {
  const path = goldenPath(mode)
  if (!existsSync(path)) {
    throw new Error(
      `missing golden ${path}. It records what the stub this mode replaced actually did; ` +
        `re-create it with UPDATE_STUB_GOLDENS=1 in a checkout that still has the original.`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Golden
}

/**
 * Register the suite for one mode.
 *
 * Every assertion is byte-exact, INCLUDING stderr: the ported stubs are handed
 * their diagnostic name explicitly (see `skeleton.parseInvocation`) precisely so
 * that this comparison can be exact rather than "both produced something".
 */
function differentialSuite(spec: ModeSpec, cases: readonly DiffCase[]): void {
  describe(`RFC-254 T28b — \`${spec.mode}\` mode reproduces ${spec.script}`, () => {
    const recorded: Golden = {}

    for (const testCase of cases) {
      test(`byte-identical: ${testCase.name}`, async () => {
        if (RECORDING) {
          // The three that were already TypeScript were run as `bun run <file>`.
          const script = testCase.originalScript ?? spec.script
          const original = script.endsWith('.ts')
            ? [process.execPath, 'run', originalStub(script)]
            : [originalStub(script)]
          recorded[testCase.name] = await runSide(original, {}, spec, testCase)
          writeFileSync(goldenPath(spec.mode), `${JSON.stringify(recorded, null, 2)}\n`)
          return
        }

        const expectedRun = readGolden(spec.mode)[testCase.name]
        expect(expectedRun, `golden entry for "${testCase.name}"`).toBeDefined()
        const ported = await runSide(
          [process.execPath, 'run', PORTED_STUB],
          { AW_STUB_MODE: spec.mode },
          spec,
          testCase,
        )

        expect(ported.steps.length, 'step count').toBe(expectedRun!.steps.length)
        for (const [index, expected] of expectedRun!.steps.entries()) {
          const actual = ported.steps[index]
          const at = `step ${index + 1}`
          expect(actual?.exitCode, `${at} exit code`).toBe(expected.exitCode)
          const norm = spec.normalizeStdout ?? ((text: string) => text)
          expect(norm(actual?.stdout ?? ''), `${at} stdout`).toBe(norm(expected.stdout))
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
        // The state files ARE the round counter: if the port names or fills
        // them differently then "round 2" means something different, and the
        // transcript above only agreed by luck.
        expect(ported.state, 'state files').toEqual(expectedRun!.state)
        expect(ported.logs, 'log files').toEqual(expectedRun!.logs)
        expect(ported.sideEffects, 'cwd side effects').toEqual(expectedRun!.sideEffects)
      }, 60_000)
    }
  })
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
    name: 'workflow variant',
    args: runArgs(`nonce="${NONCE}" build me a workflow`),
    env: { STUB_INTENT_VARIANT: 'workflow' },
  },
  {
    name: 'the old intent-workflow launcher, reproduced by the same mode',
    args: runArgs(`nonce="${NONCE}" build me a workflow`),
    env: { STUB_INTENT_VARIANT: 'workflow' },
    originalScript: 'intent-workflow-opencode.sh',
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

const matrixPrompt = (marker: string, extra = ''): string =>
  `nonce="${NONCE}" ${marker}${extra === '' ? '' : `\n${extra}`}`

/** An `<aw-input>` block the way the framework renders one: tag line, then value. */
const awInput = (name: string, value: string): string => `<aw-input name="${name}">\n${value}`

differentialSuite(
  {
    mode: 'workflow-matrix',
    script: 'stub-opencode-workflow-matrix.sh',
    stateDirEnv: ['MATRIX_STATE_DIR'],
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing nonce exits 3', args: runArgs('no marker') },
    // The catch-all: a prompt the framework routed to this stub with no marker
    // is a workflow wiring bug, and it must not look like a passing run.
    { name: 'no MATRIX_* marker exits 4', args: runArgs(`nonce="${NONCE}" plain prompt`) },
    {
      name: 'inventory drop is compact, not pretty',
      args: runArgs(matrixPrompt('MATRIX_SOURCE_A')),
      env: { WANT_INVENTORY: '1' },
    },

    { name: 'MATRIX_SOURCE_A', args: runArgs(matrixPrompt('MATRIX_SOURCE_A')) },
    { name: 'MATRIX_SOURCE_B', args: runArgs(matrixPrompt('MATRIX_SOURCE_B')) },
    { name: 'MATRIX_MERGE', args: runArgs(matrixPrompt('MATRIX_MERGE')) },
    { name: 'MATRIX_GIT_SUMMARY', args: runArgs(matrixPrompt('MATRIX_GIT_SUMMARY')) },
    { name: 'MATRIX_GIT_NOOP', args: runArgs(matrixPrompt('MATRIX_GIT_NOOP')) },
    { name: 'MATRIX_FANOUT_AGG', args: runArgs(matrixPrompt('MATRIX_FANOUT_AGG')) },
    { name: 'MATRIX_CROSS_DESIGN', args: runArgs(matrixPrompt('MATRIX_CROSS_DESIGN')) },
    { name: 'MATRIX_LOOP_EXHAUST', args: runArgs(matrixPrompt('MATRIX_LOOP_EXHAUST')) },

    {
      name: 'MATRIX_PROMPT_INPUTS with every required fragment present',
      args: runArgs(
        matrixPrompt(
          'MATRIX_PROMPT_INPUTS',
          [
            'literal {{auto_text}}',
            'thorough',
            '## auto_text',
            'auto-appended',
            '## files',
            'docs/a.md',
            'docs/b.md',
            '## tags',
            '["api","docs"]',
            '## branch',
            '{"kind":"branch","ref":"main"}',
            'node=prompt_auditor iteration=0 repo_count=1',
          ].join('\n'),
        ),
      ),
    },
    {
      name: 'MATRIX_PROMPT_INPUTS missing a fragment exits 10 and names it',
      args: runArgs(matrixPrompt('MATRIX_PROMPT_INPUTS', 'literal {{auto_text}}')),
    },
    {
      name: 'MATRIX_UPLOAD_INPUT without the uploaded files exits 11',
      args: runArgs(matrixPrompt('MATRIX_UPLOAD_INPUT', 'matrix-uploads/one.md')),
    },
    {
      name: 'MATRIX_OUTPUT_KINDS writes both generated files and emits every port kind',
      args: runArgs(matrixPrompt('MATRIX_OUTPUT_KINDS')),
      sideEffects: ['matrix-generated/kinds/one.md', 'matrix-generated/kinds/two.md'],
    },
    {
      name: 'MATRIX_GIT_MUTATE dirties the worktree',
      args: runArgs(matrixPrompt('MATRIX_GIT_MUTATE')),
      sideEffects: ['matrix-generated/source.txt', 'matrix-generated/docs/report.md'],
    },

    {
      name: 'MATRIX_LOOP_EMPTY: iteration 0 continues, iteration 1 empties the port',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_LOOP_EMPTY', 'iteration=0')) },
        { args: runArgs(matrixPrompt('MATRIX_LOOP_EMPTY', 'iteration=1')) },
      ],
    },
    {
      name: 'MATRIX_LOOP_EQUALS switches on iteration',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_LOOP_EQUALS', 'iteration=0')) },
        { args: runArgs(matrixPrompt('MATRIX_LOOP_EQUALS', 'iteration=2')) },
      ],
    },
    {
      name: 'MATRIX_LOOP_COUNT switches on iteration',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_LOOP_COUNT', 'iteration=0')) },
        { args: runArgs(matrixPrompt('MATRIX_LOOP_COUNT', 'iteration=1')) },
      ],
    },
    {
      name: 'MATRIX_LOOP_FANOUT_AGG switches on iteration',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_LOOP_FANOUT_AGG', 'iteration=0')) },
        { args: runArgs(matrixPrompt('MATRIX_LOOP_FANOUT_AGG', 'iteration=1')) },
      ],
    },
    {
      name: 'MATRIX_NESTED_CHECK switches on iteration',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_NESTED_CHECK', 'iteration=0')) },
        { args: runArgs(matrixPrompt('MATRIX_NESTED_CHECK', 'iteration=3')) },
      ],
    },
    {
      name: 'MATRIX_NESTED_MUTATE names its file after the iteration',
      args: runArgs(matrixPrompt('MATRIX_NESTED_MUTATE', 'iteration=2')),
      sideEffects: ['matrix-generated/nested/iter-2.txt', 'matrix-generated/nested/iter-0.txt'],
    },
    {
      name: 'an absent iteration marker reads as 0',
      args: runArgs(matrixPrompt('MATRIX_NESTED_MUTATE')),
      sideEffects: ['matrix-generated/nested/iter-0.txt'],
    },
    {
      name: 'the LAST iteration= on the first matching line wins',
      // A prompt that quotes an earlier iteration before stating its own must
      // not be read as the quoted one.
      args: runArgs(matrixPrompt('MATRIX_NESTED_MUTATE', 'prior iteration=0 now iteration=5')),
      sideEffects: ['matrix-generated/nested/iter-5.txt', 'matrix-generated/nested/iter-0.txt'],
    },

    {
      name: 'MATRIX_FANOUT_WORKER reads its shard from the aw-input block',
      args: runArgs(matrixPrompt('MATRIX_FANOUT_WORKER', awInput('doc', 'docs/ok.md'))),
    },
    {
      name: 'MATRIX_FANOUT_WORKER with no doc input falls back to `unknown`',
      args: runArgs(matrixPrompt('MATRIX_FANOUT_WORKER')),
    },
    {
      name: 'MATRIX_FANOUT_WORKER fails shard docs/fail.md with exit 9',
      args: runArgs(matrixPrompt('MATRIX_FANOUT_WORKER', awInput('doc', 'docs/fail.md'))),
    },
    {
      name: 'MATRIX_FANOUT_MUTATE strips the directory and the .md suffix',
      args: runArgs(matrixPrompt('MATRIX_FANOUT_MUTATE', awInput('doc', 'docs/deep/note.md'))),
      sideEffects: ['matrix-generated/fanout/note.txt'],
    },

    {
      name: 'MATRIX_MIXED_DRAFT: clarify, then answer, then the rejection rerun',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_MIXED_DRAFT')) },
        {
          args: runArgs(
            matrixPrompt('MATRIX_MIXED_DRAFT', 'Deployment target?\n## Clarify Q&A\nstaging'),
          ),
        },
        {
          args: runArgs(
            matrixPrompt(
              'MATRIX_MIXED_DRAFT',
              [
                '## Review Rejection',
                'preserve the clarified target and revise the implementation',
                '## Prior Output',
                'mixed-document-v1 target=staging',
              ].join('\n'),
            ),
          ),
        },
      ],
      sideEffects: ['matrix-generated/mixed/release.md', 'matrix-generated/mixed/checks.md'],
    },
    {
      name: 'MATRIX_MIXED_DRAFT: the rejection block outranks a quoted clarify question',
      // The shell tested `## Review Rejection` FIRST, so a rerun prompt that
      // still carries the earlier Q&A must take the rejection branch and emit
      // v2 — not re-answer the question and emit v1 again, which would loop.
      args: runArgs(
        matrixPrompt(
          'MATRIX_MIXED_DRAFT',
          [
            'Deployment target?',
            '## Clarify Q&A',
            '## Review Rejection',
            'preserve the clarified target and revise the implementation',
            '## Prior Output',
            'mixed-document-v1 target=staging',
          ].join('\n'),
        ),
      ),
      sideEffects: ['matrix-generated/mixed/release.md'],
    },
    {
      name: 'MATRIX_MIXED_DRAFT rejection missing its prior output exits 10',
      args: runArgs(matrixPrompt('MATRIX_MIXED_DRAFT', '## Review Rejection')),
    },
    {
      name: 'MATRIX_MIXED_AUDIT accepts a matching shard key',
      args: runArgs(
        matrixPrompt(
          'MATRIX_MIXED_AUDIT',
          [
            awInput('changed_file', 'src/a.ts'),
            awInput('shared_goal', 'ship the reviewed release'),
            awInput('shard-key', 'src/a.ts'),
          ].join('\n'),
        ),
      ),
    },
    {
      name: 'MATRIX_MIXED_AUDIT rejects a shard key that disagrees with the input (exit 15)',
      args: runArgs(
        matrixPrompt(
          'MATRIX_MIXED_AUDIT',
          [
            awInput('changed_file', 'src/a.ts'),
            awInput('shared_goal', 'ship the reviewed release'),
            awInput('shard-key', 'src/b.ts'),
          ].join('\n'),
        ),
      ),
    },
    {
      name: 'MATRIX_MIXED_AUDIT with no shard path exits 15',
      args: runArgs(matrixPrompt('MATRIX_MIXED_AUDIT')),
    },
    {
      name: 'MATRIX_MIXED_AUDIT with the wrong broadcast goal exits 15',
      args: runArgs(
        matrixPrompt(
          'MATRIX_MIXED_AUDIT',
          [awInput('changed_file', 'src/a.ts'), awInput('shared_goal', 'something else')].join(
            '\n',
          ),
        ),
      ),
    },
    {
      name: 'MATRIX_MIXED_SUMMARY requires both upstream fragments',
      args: runArgs(
        matrixPrompt('MATRIX_MIXED_SUMMARY', 'aggregated-fanout-report\nship the reviewed release'),
      ),
    },
    {
      name: 'MATRIX_MIXED_SUMMARY missing a fragment exits 10',
      args: runArgs(matrixPrompt('MATRIX_MIXED_SUMMARY', 'aggregated-fanout-report')),
    },

    {
      name: 'MATRIX_SELF_CLARIFY asks, then finalises once the question is echoed',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_SELF_CLARIFY')) },
        { args: runArgs(matrixPrompt('MATRIX_SELF_CLARIFY', 'Choose a delivery mode\nsafe')) },
      ],
    },
    {
      name: 'MATRIX_CROSS_QUESTION asks, then finalises',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_CROSS_QUESTION')) },
        {
          args: runArgs(
            matrixPrompt('MATRIX_CROSS_QUESTION', 'Which trade-off should win?\nlatency'),
          ),
        },
      ],
    },
    {
      name: 'MATRIX_REVIEW_WRITE switches on the rejection block',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_REVIEW_WRITE')) },
        { args: runArgs(matrixPrompt('MATRIX_REVIEW_WRITE', '## Review Rejection')) },
      ],
    },

    {
      name: 'MATRIX_RUNTIME retry: first attempt exits 12, the retry succeeds',
      // The marker file is the whole point — it lives in MATRIX_STATE_DIR so a
      // worktree rollback between attempts cannot erase it.
      steps: [
        {
          args: runArgs(matrixPrompt('MATRIX_RUNTIME', `${awInput('mode', 'retry')}\ntask=alpha`)),
        },
        {
          args: runArgs(matrixPrompt('MATRIX_RUNTIME', `${awInput('mode', 'retry')}\ntask=alpha`)),
        },
      ],
    },
    {
      name: 'MATRIX_RUNTIME retry keys the marker per task',
      steps: [
        {
          args: runArgs(matrixPrompt('MATRIX_RUNTIME', `${awInput('mode', 'retry')}\ntask=alpha`)),
        },
        {
          args: runArgs(matrixPrompt('MATRIX_RUNTIME', `${awInput('mode', 'retry')}\ntask=beta`)),
        },
      ],
    },
    {
      name: 'MATRIX_RUNTIME retry with no task= falls back to `unknown`',
      steps: [
        { args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'retry'))) },
        { args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'retry'))) },
      ],
    },
    {
      name: 'MATRIX_RUNTIME fail exits 13',
      args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'fail'))),
    },
    {
      name: 'MATRIX_RUNTIME with an unknown mode exits 14',
      args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'frobnicate'))),
    },
    {
      name: 'MATRIX_RUNTIME with no mode input at all exits 14',
      args: runArgs(matrixPrompt('MATRIX_RUNTIME')),
    },
    {
      // Deliberately the slowest case in the file: it is the only one that
      // proves the ported stub actually WAITS. The timeout / cancel specs work
      // by killing this branch mid-sleep, so a port that returned immediately
      // would turn both of them green against nothing.
      name: 'MATRIX_RUNTIME timeout sleeps ~10s before emitting',
      args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'timeout'))),
    },
    {
      name: 'MATRIX_RUNTIME cancel takes the same sleeping branch',
      args: runArgs(matrixPrompt('MATRIX_RUNTIME', awInput('mode', 'cancel'))),
    },
  ],
)

differentialSuite(
  {
    mode: 'business-workflows',
    script: 'stub-opencode-business-workflows.ts',
    stateDirEnv: ['BUSINESS_WORKFLOW_STATE_DIR'],
    normalizeStdout: maskTimestamps,
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'version', args: ['version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing --agent', args: ['run', '--', 'x'] },
    { name: 'missing nonce', args: runArgs('no marker', 'business-fix-engineer') },
    {
      name: 'an unknown agent is rejected rather than answered',
      args: runArgs(`nonce="${NONCE}" go`, 'not-a-business-agent'),
    },
    {
      name: 'every prompt is appended to the shared prompts.jsonl',
      steps: [
        { args: runArgs(`nonce="${NONCE}" go`, 'business-code-auditor') },
        { args: runArgs(`nonce="${NONCE}" go`, 'business-code-auditor') },
      ],
    },
    {
      name: 'inventory drop',
      args: runArgs(`nonce="${NONCE}" go`, 'business-code-auditor'),
      env: { WANT_INVENTORY: '1' },
    },
  ],
)

differentialSuite(
  {
    mode: 'business-workgroups',
    script: 'stub-opencode-business-workgroups.ts',
    stateDirEnv: ['BUSINESS_WORKGROUP_STATE_DIR'],
    normalizeStdout: maskTimestamps,
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing --agent', args: ['run', '--', 'x'] },
    { name: 'missing nonce', args: runArgs('no marker', 'anyone') },
    { name: 'an unrecognised turn exits 14', args: runArgs(`nonce="${NONCE}" go`, 'anyone') },
  ],
)

differentialSuite(
  {
    mode: 'workgroup-matrix',
    script: 'stub-opencode-workgroup-matrix.ts',
    stateDirEnv: ['WORKGROUP_MATRIX_STATE_DIR'],
    normalizeStdout: maskTimestamps,
  },
  [
    { name: '--version', args: ['--version'] },
    { name: 'unsupported mode', args: ['nope'] },
    { name: 'missing --agent', args: ['run', '--', 'x'] },
    { name: 'missing nonce', args: runArgs('no marker', 'showcase-wg-lead') },
    { name: 'an unexpected agent exits 15', args: runArgs(`nonce="${NONCE}" go`, 'nobody') },
    {
      name: 'the researcher turn',
      args: runArgs(`nonce="${NONCE}" <port name="wg_result"> go`, 'showcase-wg-researcher'),
    },
  ],
)

describe('RFC-254 T28b — where the shell original had no single answer', () => {
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
})

describe('RFC-254 T28b — dispatcher', () => {
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

  test('every mode has a golden, and every golden has a mode', () => {
    // A mode with no recording is unproven; a recording with no mode is a
    // deleted behaviour nobody noticed. Both are silent by default.
    const modes = new Set(
      [...readFileSync(PORTED_STUB, 'utf8').matchAll(/^\s*'?([a-z-]+)'?: run[A-Z]/gm)].map(
        (match) => match[1],
      ),
    )
    const goldens = new Set(
      readdirSync(GOLDEN_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    )
    expect([...modes].sort()).toEqual([...goldens].sort())
  })
})
