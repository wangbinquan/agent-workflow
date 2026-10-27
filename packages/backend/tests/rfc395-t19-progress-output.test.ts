// RFC-395 T19: synchronous rate limiting and stderr must not alter CLI JSON.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMigrationProgressReporter,
  type MigrationProgress,
} from '@/platform/persistence/migration/run/progress'
import { epochMigrationCommand } from '@/cli/epochMigration'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'

test('T19 reporter emits boundaries immediately and limits each phase independently without timers', () => {
  let now = 1000
  const lines: string[] = []
  const progress = createMigrationProgressReporter((line) => lines.push(line), { now: () => now })
  progress({ phase: 'conversion', detail: 'start', boundary: true })
  for (let i = 1; i <= 1000; i++)
    progress({ phase: 'conversion', detail: 'copy', completed: i, total: 1000 })
  expect(lines).toHaveLength(1)
  now += 3000
  progress({ phase: 'conversion', detail: 'copy', completed: 1000, total: 1000 })
  progress({ phase: 'load', detail: 'load', completed: 1 })
  progress({ phase: 'conversion', detail: 'done', boundary: true })
  expect(lines).toHaveLength(4)
  expect(lines[1]).toContain('1000/1000 units (3.0s elapsed)')
  expect(lines[2]).toContain('load: load 1 units')
  expect(lines.at(-1)).toContain('conversion: done')
})

test('T19 orchestration phases reach the callback; library callers stay silent by default', async () => {
  const f = makeSwitchFixture()
  const events: MigrationProgress[] = []
  const app = createEpochSwitchApplication({ ...f.deps, progress: (event) => events.push(event) })
  try {
    const plan = await app.plan({})
    await app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
    await app.verify({ operationId: f.operationId })
    const phases = events
      .filter((event) => event.boundary)
      .map((event) => `${event.phase}:${event.detail}`)
    expect(phases).toEqual([
      'backup:live backup',
      'backup:live backup complete',
      'freeze:quiesce writers',
      'load:start',
      'load:complete',
      'validation:constraints and content',
      'validation:complete',
      'activation:prepare',
      'activation:activated',
      'validation:verify target',
      'validation:verified',
    ])
    const count = events.length
    await f.app.verify({ operationId: f.operationId })
    expect(events).toHaveLength(count)
  } finally {
    f.close()
  }
})

test('T19 CLI JSON is byte-identical with a progress callback writing stderr', async () => {
  const f = makeSwitchFixture()
  try {
    const planned = await f.app.plan({})
    for (const verb of ['plan', 'run', 'verify'] as const) {
      const result = { ...planned, operationId: 't19-stable-output' }
      let stderr = ''
      const progress = createMigrationProgressReporter(
        (line) => {
          stderr += line
        },
        { now: () => 0 },
      )
      const application = { ...f.app, [verb]: async () => result }
      const argv = [verb, ...(verb === 'plan' ? [] : [f.operationId]), '--json']
      const silent = await epochMigrationCommand(argv, { application })
      const observed = await epochMigrationCommand(argv, {
        application: {
          ...application,
          [verb]: async () => {
            progress({
              phase: verb === 'verify' ? 'validation' : 'conversion',
              detail: verb,
              boundary: true,
            })
            return result
          },
        },
      })
      expect(observed).toEqual(silent)
      expect(observed.output).toBe(JSON.stringify(result))
      expect(stderr).toContain('[db migration]')
      expect(observed.output).not.toContain('[db migration]')
    }
    // Keep the actual entry-to-stderr wiring under regression coverage as well.
    for (const entry of ['epochMigrationEntry.ts', 'epochMigrationHostedEntry.ts']) {
      const text = readFileSync(join(import.meta.dir, '../src/bootstrap', entry), 'utf8')
      expect(text).toContain('progress: createMigrationProgressReporter(')
      expect(text).toContain('writeSync(2, line)')
    }
  } finally {
    f.close()
  }
})

test('T19 child CLI writes human progress only to fd 2; all three stdout JSON lines are byte-identical', async () => {
  const run = async (progress: boolean) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'helpers/rfc395T19ProgressCli.ts'),
        ...(progress ? ['--progress'] : []),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    return { stdout, stderr }
  }
  const silent = await run(false)
  const observed = await run(true)
  expect(silent.stderr).toBe('')
  expect(observed.stdout).toBe(silent.stdout)
  expect(
    observed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).method),
  ).toEqual(['plan', 'run', 'verify'])
  expect(observed.stderr.trim().split('\n')).toHaveLength(3)
  expect(observed.stderr).toContain('validation: verify 3 units (0.0s elapsed)')
})
