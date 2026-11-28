import type { ConversionRule } from '../conversion/rule'
import { rowBlock } from '../conversion/blockCodes'
import { lookupKey, type LookupBuilder } from '../conversion/lookups'
import type { DecodedSourceRow } from '../sourceTypes'

/**
 * Whether a legacy mission (`development_missions`) has not ended: `terminal_at` is NULL
 * (`open`), or it is not a number (`unproven` — in practice a row the frozen codec rejected).
 * RFC-626 §3.4 row 13: the automatic upgrade sets these missions aside
 * (`alignment/developmentMissions.ts`) and lists them here, so both use this one test.
 */
export function legacyMissionUnfinished(values: DecodedSourceRow): 'open' | 'unproven' | null {
  if (values.terminal_at === null) return 'open'
  return typeof values.terminal_at === 'number' ? null : 'unproven'
}
/** RFC-626 §3.4 row 13: the code a set-aside unfinished legacy mission carries. */
export const LEGACY_MISSION_UNFINISHED = 'v2-legacy-mission-unfinished'
export const WRITER_TAKEN_OVER = 'v2-writer-not-os-active-kept'
export const WRITER_STATE_MISSING_TAKEN_OVER = 'v2-writer-state-missing-kept'

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
      const unfinished = legacyMissionUnfinished(row.values)
      if (unfinished === 'open') openMissions.push(row.encodedKey)
      else if (unfinished === 'unproven') unprovenMissions.push(row.encodedKey)
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
    // RFC-626 §3.4 row 13: the new version's writer state is always "the new flow took over"
    // (`writerCutoverPersistence.ts`); it has no draining state to carry an unfinished legacy
    // mission into. With automatic resolution those missions are set aside where they are
    // converted, and the writer state is recorded as taken over, listing them.
    const automatic = ctx.resolution === 'automatic'
    const setAside = [...new Set([...facts.openMissions, ...facts.unprovenMissions])].sort()
    if (!facts.globalPresent && automatic)
      ctx.out.record({
        kind: 'decision',
        code: WRITER_STATE_MISSING_TAKEN_OVER,
        payload: {
          automatic: 'kept',
          sourceTable: table,
          writerState: 'os-active',
          setAsideMissions: setAside,
        },
      })
    if (!facts.globalPresent && !automatic) {
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
      const drained = facts.openMissions.length === 0 && facts.unprovenMissions.length === 0
      const takenOver = global && automatic && !drained
      const confirmedOsActive = global && (drained || takenOver)
      if (takenOver)
        ctx.out.record(
          {
            kind: 'decision',
            code: WRITER_TAKEN_OVER,
            payload: {
              automatic: 'kept',
              sourceTable: table,
              sourceKey: row.encodedKey,
              mode: row.values.mode as string,
              writerState: 'os-active',
              setAsideMissions: setAside,
            },
          },
          row,
        )
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
                    // A set-aside mission is not in the new database to be drained.
                    legacyOpenMissionCount: takenOver ? 0 : facts.openMissions.length,
                    updatedAt: ctx.planTime,
                  },
                  openMissions: facts.openMissions,
                  unprovenMissions: facts.unprovenMissions,
                  ...(takenOver ? { setAsideMissions: setAside } : {}),
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
