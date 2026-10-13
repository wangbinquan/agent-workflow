import { expect, spyOn, test } from 'bun:test'
import { sweepMissionWakes } from '@/modules/development-automation/application/missionWakeSweep'
import { listUnconsumedWakeHintMissionIds } from '@/modules/development-automation/infrastructure/reconcilerReaders'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

describeEachProvider('RFC-370 development wake durable handoff', (harness) => {
  test('a delayed due-list cannot consume an unadmitted wake after loss', async () => {
    const fixture = await buildPr3Fixture({ db: harness.db }),
      deps = fixture.deps()
    const missionId = await fixture.launchDirect('host-late-due'),
      now = Date.now()
    await fixture.store.armWake({
      id: 'host-late-wake',
      missionId,
      decisionId: 'host-late-decision',
      reason: 'poll',
      resumeAt: now - 1_000,
      wakeSources: ['manual'],
      attemptOrdinal: 0,
      now,
    })
    let current = true
    const original = deps.store.listDueWakes.bind(deps.store)
    const read = spyOn(deps.store, 'listDueWakes').mockImplementation(async (time) => {
      const rows = await original(time)
      current = false
      return rows
    })
    try {
      expect(
        await sweepMissionWakes(
          deps,
          {
            listUnconsumedWakeHintMissionIds: async () => {
              throw new Error('unadmitted hint scan')
            },
          },
          { current: () => current },
        ),
      ).toEqual({ reconciled: 0 })
      expect((await fixture.store.getWake(missionId, 'host-late-decision'))?.state).toBe('armed')
    } finally {
      read.mockRestore()
    }
  })

  test('loss during fireWake ACK persists a continuation hint without starting the mission', async () => {
    const fixture = await buildPr3Fixture({ db: harness.db }),
      deps = fixture.deps()
    const missionId = await fixture.launchDirect('host-fired-wake'),
      now = Date.now()
    await fixture.store.armWake({
      id: 'host-fired-wake',
      missionId,
      decisionId: 'host-fired-decision',
      reason: 'poll',
      resumeAt: now - 1_000,
      wakeSources: ['manual'],
      attemptOrdinal: 0,
      now,
    })
    const before = await fixture.store.getMission(missionId)
    let current = true
    const original = deps.store.fireWake.bind(deps.store)
    const fire = spyOn(deps.store, 'fireWake').mockImplementation(async (...input) => {
      const accepted = await original(...input)
      current = false
      return accepted
    })
    try {
      const readers = {
        listUnconsumedWakeHintMissionIds: () => listUnconsumedWakeHintMissionIds(harness.db),
      }
      expect(await sweepMissionWakes(deps, readers, { current: () => current })).toEqual({
        reconciled: 1,
      })
      expect((await fixture.store.getWake(missionId, 'host-fired-decision'))?.state).toBe('fired')
      expect(await fixture.store.getMission(missionId)).toEqual(before)
      expect(await readers.listUnconsumedWakeHintMissionIds()).toContain(missionId)
      // The next owner uses the existing stored hint, not a second wake claim.
      fire.mockRestore()
      current = true
      expect(
        (await sweepMissionWakes(deps, readers, { current: () => current })).reconciled,
      ).toBeGreaterThanOrEqual(1)
      expect((await fixture.store.getWake(missionId, 'host-fired-decision'))?.state).toBe('fired')
    } finally {
      fire.mockRestore()
    }
  })
})
