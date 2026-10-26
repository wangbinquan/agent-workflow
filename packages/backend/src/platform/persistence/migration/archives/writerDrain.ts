import type { ConversionRule } from '../conversion/rule'
import { rowBlock } from '../conversion/blockCodes'
import { lookupKey, type LookupBuilder } from '../conversion/lookups'

interface WriterDrainFacts {
  readonly globalPresent: boolean
  readonly openMissions: readonly string[]
  readonly unprovenMissions: readonly string[]
}
const WRITER_DRAIN = lookupKey<WriterDrainFacts>('history/writer-drain', 1)
export const writerDrainLookup: LookupBuilder<WriterDrainFacts> = {
  key: WRITER_DRAIN,
  sources: ['employee_os_writer_state', 'development_missions'],
  build(staged, put) {
    const openMissions: string[] = []
    const unprovenMissions: string[] = []
    for (const row of staged.rows('development_missions')) {
      if (row.values.terminal_at === null) openMissions.push(row.encodedKey)
      else if (typeof row.values.terminal_at !== 'number') unprovenMissions.push(row.encodedKey)
    }
    put('global', {
      globalPresent: [...staged.rows('employee_os_writer_state')].some(
        (row) => row.values.id === 'global',
      ),
      openMissions: openMissions.sort(),
      unprovenMissions: unprovenMissions.sort(),
    })
  },
}

const table = 'employee_os_writer_state'
export const writerDrainRule: ConversionRule = {
  ref: { id: 'history/writer-drain', version: 2 },
  owner: 'platform/persistence/migration/archives',
  claims: [table],
  produces: [],
  lookups: [WRITER_DRAIN],
  unit: { kind: 'source-chunk', table },
  convert(unit, ctx) {
    const facts = ctx.lookup(WRITER_DRAIN).require('global')
    if (!facts.globalPresent) {
      ctx.out.block({
        code: 'v2-writer-state-missing',
        scope: 'table',
        sourceTable: table,
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: ['mode'],
        detail: 'activate() requires the global writer-state row',
      })
    }
    for (const row of unit.rows.get(table)!) {
      const global = row.values.id === 'global'
      // writerCutoverPersistence.activate(): recompute from terminal_at, even
      // when the stored mode/count already claim os-active. No source writes.
      const confirmedOsActive =
        global && facts.openMissions.length === 0 && facts.unprovenMissions.length === 0
      ctx.out.record(
        {
          kind: 'writer-drain',
          payload: {
            sourceGeneration: ctx.sourceGenerationId,
            sourceContract: ctx.preflight.contract!.digest,
            sourceKey: row.encodedKey,
            original: row.canonical,
            confirmedOsActive,
            activation: global ? 'boot-equivalent' : 'not-global',
            ...(global
              ? {
                  next: {
                    activeGeneration: Math.max(1, row.values.active_generation as number),
                    mode: confirmedOsActive ? 'os-active' : 'legacy-draining',
                    legacyAdmissionsEnabled: false,
                    legacyOpenMissionCount: facts.openMissions.length,
                    updatedAt: ctx.planTime,
                  },
                  openMissions: facts.openMissions,
                  unprovenMissions: facts.unprovenMissions,
                }
              : {}),
          },
        },
        row,
      )
      if (global && !confirmedOsActive)
        ctx.out.block(
          rowBlock(
            'v2-writer-not-os-active',
            row,
            {
              mode: row.values.mode as string,
              openMissions: facts.openMissions,
              unprovenMissions: facts.unprovenMissions,
            },
            ['development_missions.terminal_at'],
          ),
        )
    }
  },
}
