// RFC-062 PR-B — replay every e2e-snapshots/*.json through the
// production launcher + ScriptedRunnerAdapter and assert the
// expected terminal kind + event ordering.
//
// Failure modes this catches:
//   - Lazy-cascade scanner re-introducing a feedback-edge gate
//     (cross-clarify-roundtrip.json deadlocks → no agent attempt,
//     "expected attempt-started" assertion fires).
//   - Launcher's findEntryNodes regressing (entry nodes never seeded
//     → events table has only task-started, terminal never reached
//     → timeout).
//   - Actor dispatching extra logical_runs not anticipated by the
//     fixture (ScriptedRunnerAdapter throws unexpected dispatch).
//
// Add a new fixture under e2e-snapshots/ whenever:
//   - A new NodeKind / SignalKind lands → at least one fixture must
//     exercise it in a workflow containing feedback edges.
//   - A workflow schema bump ($schema_version) changes the shape →
//     update all existing fixtures.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

import { createInMemoryDb } from '../src/db/client'

import {
  driveSnapshotToCompletion,
  seedFixtureTask,
  assertContainsInOrder,
  type SnapshotFixture,
} from './_rfc062-fixture-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SNAPSHOTS_DIR = resolve(import.meta.dir, 'e2e-snapshots')

const FIXTURES = readdirSync(SNAPSHOTS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()

describe('RFC-062 PR-B — e2e snapshot replay', () => {
  test('at least 3 fixtures are present', () => {
    // The plan committed to ≥3 fixtures (linear-data-chain control +
    // self-clarify-only + cross-clarify-roundtrip). Adding more is
    // welcome; dropping below 3 needs an explicit RFC update.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3)
  })

  for (const file of FIXTURES) {
    test(
      `${file} reaches its expectedTerminalKind with the expected event sequence`,
      async () => {
        const raw = readFileSync(join(SNAPSHOTS_DIR, file), 'utf-8')
        const fixture = JSON.parse(raw) as SnapshotFixture

        const db = createInMemoryDb(MIGRATIONS)
        const taskId = `t-${file.replace(/\.json$/, '')}`
        const paths = seedFixtureTask(db, fixture, taskId)

        const { events, finalStatus } = await driveSnapshotToCompletion({
          db,
          taskId,
          fixture,
          worktreePath: paths.worktreePath,
          repoPath: paths.repoPath,
          appHome: paths.appHome,
          timeoutMs: 5000,
        })

        // Final tasks.status must match the expected terminal kind.
        // task-completed → status='done'; task-failed → status='failed';
        // task-canceled → status='canceled'.
        const expectedStatus =
          fixture.expectedTerminalKind === 'task-completed'
            ? 'done'
            : fixture.expectedTerminalKind === 'task-failed'
              ? 'failed'
              : 'canceled'
        if (finalStatus !== expectedStatus) {
          // Surface the event log so failures pinpoint where progress stalled.
          const tokens = events.map((e) => `${e.kind}${e.nodeId ? ':' + e.nodeId : ''}@${e.ts}`)
          throw new Error(
            `${file}: expected terminal status "${expectedStatus}" (from "${fixture.expectedTerminalKind}"), got "${finalStatus}". ` +
              `Events (${events.length}):\n  ${tokens.join('\n  ')}`,
          )
        }

        // The event log must contain the must-have tokens in order.
        assertContainsInOrder(events, fixture.expectedEvents.mustContainInOrder)
      },
      { timeout: 10000 },
    )
  }
})
