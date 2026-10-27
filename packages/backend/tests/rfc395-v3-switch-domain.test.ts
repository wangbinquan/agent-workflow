// RFC-395 V3-S: pure transitions; reusable ports live in a helper without test registration.
import { describe, expect, test } from 'bun:test'
import { unfinishedTasks } from '@/modules/system-operations/application/epochSwitch/planner'
import {
  createEpochSwitchJournal,
  EPOCH_SWITCH_PHASES,
  type EpochSwitchJournal,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  reviseEpochSwitch,
  takeOverEpochSwitch,
  newEpochRun,
  rollbackEligibility,
  assertJournalSuccessor,
} from '@/modules/system-operations/domain/epochSwitch/transitions'
import { assertEpochSwitchSupported } from '@/modules/system-operations/domain/epochSwitch/supportMatrix'
import { makeSwitchFixture, plannedFixture, fixtureDigest } from './helpers/rfc395V3SwitchFixture'

describe('V3 switch domain', () => {
  test('legal successors, approvals, failure resume and fenced takeover', async () => {
    const f = await plannedFixture()
    try {
      let j = (await f.deps.journal.read(f.operationId))!
      expect(() => reviseEpochSwitch(j, { phase: 'backed-up' }, 123)).toThrow('approval-required')
      j = reviseEpochSwitch(
        j,
        {
          plan: {
            ...j.payload.plan!,
            approvedDigest: j.payload.plan!.approvalDigest,
            approvedAt: 123,
          },
        },
        123,
      )
      for (const phase of EPOCH_SWITCH_PHASES.slice(2)) j = reviseEpochSwitch(j, { phase }, 123)
      expect(j.payload.phase).toBe('completed')
      expect(() => reviseEpochSwitch(j, { phase: 'planned' }, 123)).toThrow('illegal-transition')
      const original = (await f.deps.journal.read(f.operationId))!
      const takeover = takeOverEpochSwitch(original, 'next-owner', 124)
      expect(takeover.payload.owner.fence).toBe(original.payload.owner.fence + 1)
      expect(() =>
        assertJournalSuccessor(
          original,
          createEpochSwitchJournal({
            ...takeover.payload,
            owner: { ...takeover.payload.owner, fence: 0 },
          }),
        ),
      ).toThrow('stale-revision-or-owner')
      const failed = reviseEpochSwitch(original, { status: 'failed' }, 124)
      expect(reviseEpochSwitch(failed, { status: 'running' }, 125).payload.status).toBe('running')
      expect(newEpochRun(failed, 125).payload.plan).toBeNull()
    } finally {
      f.close()
    }
  })
  test('every non-successor is rejected and rollback respects phase and first write', async () => {
    const f = await plannedFixture()
    try {
      const base = (await f.deps.journal.read(f.operationId))!
      for (let index = 0; index < EPOCH_SWITCH_PHASES.length; index++) {
        const phase = EPOCH_SWITCH_PHASES[index]!
        const j: EpochSwitchJournal = createEpochSwitchJournal({ ...base.payload, phase })
        for (let next = 0; next < EPOCH_SWITCH_PHASES.length; next++)
          if (next !== index && next !== index + 1)
            expect(() => reviseEpochSwitch(j, { phase: EPOCH_SWITCH_PHASES[next]! }, 123)).toThrow(
              'illegal-transition',
            )
        expect(rollbackEligibility(j).allowed).toBe(phase !== 'completed')
        expect(
          rollbackEligibility({ ...j, payload: { ...j.payload, firstLiveWriteAt: 123 } }).allowed,
        ).toBe(false)
      }
    } finally {
      f.close()
    }
  })
  test('the support matrix preserves SQLite to PostgreSQL and refuses the reverse', () => {
    for (const [sourceProvider, targetProvider] of [
      ['sqlite', 'sqlite'],
      ['sqlite', 'postgresql'],
      ['postgresql', 'postgresql'],
    ] as const)
      expect(() =>
        assertEpochSwitchSupported({
          sourceProvider,
          targetProvider,
          sourceEpoch: 1,
          targetEpoch: 2,
        }),
      ).not.toThrow()
    expect(() =>
      assertEpochSwitchSupported({
        sourceProvider: 'postgresql',
        targetProvider: 'sqlite',
        sourceEpoch: 1,
        targetEpoch: 2,
      }),
    ).toThrow('unsupported')
    expect(() =>
      assertEpochSwitchSupported({
        sourceProvider: 'sqlite',
        targetProvider: 'sqlite',
        sourceEpoch: 2,
        targetEpoch: 2,
      }),
    ).toThrow('unsupported')
  })
})

test('unfinished task inventory uses the frozen epoch-one terminal status vocabulary', async () => {
  const f = makeSwitchFixture()
  try {
    const source = await f.deps.source.discover({
      location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      emptyTables: [],
      operationRoot: f.root,
    })
    const statuses = [
      'done',
      'failed',
      'canceled',
      'interrupted',
      'running',
      'pending',
      'running',
      'awaiting_review',
      'awaiting_human',
    ]
    const withTasks = {
      ...source,
      preflight: {
        ...source.preflight,
        tables: [
          {
            table: 'tasks',
            physicalTable: 'tasks',
            rows: statuses.length,
            destination: { kind: 'business' as const, tables: ['tasks'] },
            disposition: 'converted' as const,
            reason: 'fixture',
          },
        ],
      },
    }
    source.reader.readChunk = async () => ({
      version: 1,
      sourceVersion: source.preflight.sourceVersion,
      table: 'tasks',
      migrationKey: ['id'],
      afterKey: null,
      firstKey: null,
      lastKey: null,
      rows: statuses.map((status, index) => ({
        key: [{ type: 'integer', value: String(index) }],
        values: [{ type: 'text', value: status }],
      })),
      decodedRows: statuses.map((status) => ({ status })),
      sourceDigest: fixtureDigest,
    })
    expect(await unfinishedTasks(withTasks)).toEqual([
      { status: 'awaiting_human', count: 1 },
      { status: 'awaiting_review', count: 1 },
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 1 },
      { status: 'running', count: 2 },
    ])
  } finally {
    f.close()
  }
})
