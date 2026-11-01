// RFC-398 §7.6 / AC-4 (design §10 `rfc398-auto-upgrade-resume`): every durable boundary uses real
// start -> auto children and SIGKILL of the child, the parent or both, then `start` again.
//
// Each interruption point registers from its own test file. The whole matrix needs about 26 CI
// minutes, beyond one 15-minute backend shard (CI run 41287820486: shard 24/36 was cancelled while
// the single combined file was still running). Bun shards by file, so one point per file spreads
// the cases. `rfc398-split-test-coverage.test.ts` requires every point exactly once.
import { expect, test } from 'bun:test'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessAlive } from '@/util/process'
import {
  autoUpgradeFixture,
  acknowledgeFixture,
  type AutoUpgradeFixture,
} from './rfc398AutoUpgrade'
import { postgresqlAutoUpgradeFixture } from './rfc398AutoUpgradePostgresql'
import { describeRfc398Postgresql } from './rfc398Postgresql'
import { frozenValues } from './rfc395V2/contentFixtures'

const ordinary = [
  'intent',
  'discovered',
  'plan',
  'refused',
  'phase-frozen',
  'conversion-finished',
  'phase-validated',
  'awaiting-approval',
  'phase-activated',
  'phase-verified',
  'failure-source-changed',
] as const
const committed: readonly string[] = [
  'acceptance-published',
  'acceptance-referenced',
  'acceptance-journal-failed',
  'verify-failed',
  'rollback-retired',
  'rollback-pointer-restored',
]
export const RESUME_POINTS: readonly string[] = [
  ...ordinary,
  'acceptance-unpublished',
  ...committed,
]
export const POSTGRESQL_RESUME_POINTS: readonly string[] = [
  'phase-frozen',
  'run-returned',
  'acceptance-published',
]
const victims = ['child', 'parent', 'both'] as const

async function atPoint(f: AutoUpgradeFixture, point: string) {
  if (point === 'failure-source-changed') {
    f.barriers(['phase-frozen'])
    const first = f.start()
    const frozen = await f.reached('phase-frozen')
    f.kill(first.process.pid)
    f.kill(frozen.pid)
    await first.exited
    f.release('phase-frozen')
    f.flag('source-changed')
  }
  if (point === 'awaiting-approval') {
    // A built-in runtime row whose binary is inherited from config.json at boot upgrade.
    const row = frozenValues('runtimes', {
      id: 'rfc398-opencode',
      name: 'opencode',
      protocol: 'opencode',
      binary_path: null,
      model: null,
      variant: null,
      temperature: null,
      steps: null,
      max_steps: null,
    })
    const source = new Database(join(f.home, 'db.sqlite'))
    try {
      source
        .query(
          `INSERT INTO runtimes (${Object.keys(row)
            .map((c) => `"${c}"`)
            .join(',')}) VALUES (${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .run(
          ...Object.values(row).map(
            (v) => (typeof v === 'boolean' ? Number(v) : v) as SQLQueryBindings,
          ),
        )
    } finally {
      source.close()
    }
  }
  f.barriers(point === 'awaiting-approval' ? ['phase-backed-up', point] : [point])
  const parent = f.start()
  if (point === 'awaiting-approval') {
    await f.reached('phase-backed-up')
    // A real change between planning and freeze: the inherited runtime binary (a material boot
    // upgrade effect bound by the approval digest) changes, so the frozen plan needs re-approval.
    // Row content alone (e.g. a maintenance_state insert) never changes the approval digest.
    const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')) as object
    writeFileSync(
      join(f.home, 'config.json'),
      JSON.stringify({ ...config, opencodePath: process.execPath }),
    )
    f.release('phase-backed-up')
  }
  const reached = await f.reached(point)
  return { parent, child: reached.pid }
}

/** SQLite: SIGKILL child / parent / both at `point`, then `start` again. */
export function registerResumePoint(point: string): void {
  if (!RESUME_POINTS.includes(point)) throw new Error(`unknown RFC-398 resume point ${point}`)
  for (const victim of victims) {
    test(`${point}: SIGKILL ${victim} preserves one operation and the durable acceptance decision`, async () => {
      const f = await autoUpgradeFixture({ blocked: point === 'refused' })
      try {
        const negative = point === 'acceptance-unpublished' || committed.includes(point)
        if (negative) f.flag('negative-health')
        const { parent, child } = await atPoint(f, point)
        if (point === 'intent') expect(f.journals()).toHaveLength(0)
        const firstId = f.sessions()[0]!.operationId
        const sourceBefore = readFileSync(join(f.home, 'db.sqlite'))
        const verifyCalls = f.events().filter((e) => e.point === 'verify-called').length
        if (victim !== 'parent') f.kill(child)
        if (victim !== 'child') f.kill(parent.process.pid)
        await parent.exited
        f.flag('negative-health', false)
        f.flag('source-changed', false)
        f.release(point)
        if (point === 'refused') {
          await f.wait(() =>
            !isProcessAlive(child) ||
            !existsSync(join(f.home, 'database-migrations/auto-upgrade/active.json'))
              ? true
              : null,
          )
          await acknowledgeFixture(f)
        }
        const next = f.start()
        // Killing P alone does not interrupt C's already computed negative result. C must
        // publish it and roll back. Killing C before publication allows a new healthy verify.
        const mustRollback =
          committed.includes(point) || (point === 'acceptance-unpublished' && victim === 'parent')
        if (mustRollback) {
          expect(await next.exited).toBe(1)
          expect(f.sessions()[0]).toMatchObject({
            operationId: firstId,
            outcome: 'failed',
            verificationFailed: true,
          })
          expect(f.journals()[0]!.payload.status).toBe('rolled-back')
          expect(readFileSync(join(f.home, 'db.sqlite'))).toEqual(sourceBefore)
          expect(f.events().filter((e) => e.point === 'verify-called')).toHaveLength(verifyCalls)
          expect(existsSync(join(f.home, 'database-generation.json'))).toBe(false)
          expect(next.error).toContain('--retry')
        } else {
          await f.ready()
          expect(f.sessions()[0]).toMatchObject({
            operationId: firstId,
            outcome: 'completed',
            verificationFailed: false,
          })
          expect(f.journals()[0]!.payload.phase).toBe('verified')
          expect(f.sessions()[0]!.records.some((r) => r.kind === 'verify-failed')).toBe(false)
          if (point === 'failure-source-changed')
            expect(f.journals()[0]!.payload.run!.ordinal).toBe(1)
          if (point === 'acceptance-unpublished')
            expect(f.events().filter((e) => e.point === 'verify-called').length).toBeGreaterThan(
              verifyCalls,
            )
        }
        expect(f.sessions()).toHaveLength(1)
        expect(f.journals()).toHaveLength(1)
      } finally {
        await f.close()
      }
    }, 240_000)
  }
}

/** PostgreSQL: the same interruption keeps the session's database allocations. */
export function registerPostgresqlResumePoint(point: string): void {
  if (!POSTGRESQL_RESUME_POINTS.includes(point))
    throw new Error(`unknown RFC-398 PostgreSQL resume point ${point}`)
  describeRfc398Postgresql('PostgreSQL interrupted sessions retain allocations', () => {
    for (const victim of victims)
      test(`${point}: kill ${victim}; same operation/run never creates another database`, async () => {
        const f = await postgresqlAutoUpgradeFixture()
        try {
          if (point === 'acceptance-published') f.flag('negative-health')
          f.barriers([point])
          const parent = f.start()
          const child = await f.reached(point)
          const allocations = f.allocations()
          expect(allocations).toHaveLength(2)
          if (victim !== 'parent') f.kill(child.pid)
          if (victim !== 'child') f.kill(parent.process.pid)
          await parent.exited
          f.flag('negative-health', false)
          f.release(point)
          const next = f.start()
          if (point === 'acceptance-published') {
            expect(await next.exited).toBe(1)
            expect(f.sessions()[0]!.outcome).toBe('failed')
            expect(f.journals()[0]!.payload.status).toBe('rolled-back')
          } else {
            await f.ready()
            expect(f.sessions()[0]!.outcome).toBe('completed')
          }
          expect(f.allocations()).toEqual(allocations)
          expect(f.journals()).toHaveLength(1)
        } finally {
          await f.close()
        }
      }, 300_000)
  })
}
