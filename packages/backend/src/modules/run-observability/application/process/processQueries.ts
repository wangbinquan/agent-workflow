// RFC-616 §8 — the read use cases of process metrics.
//
// Scope follows run observation: an account that may read every task sees
// every unit; any other account sees the units it owns or takes part in, and
// never sees per-person detail. Statistics cover at most a fixed number of
// units; beyond it the newest ones are aggregated and the answer says so.

import {
  PROCESS_LIST_UNIT_LIMIT,
  PROCESS_SUMMARY_UNIT_LIMIT,
  PROCESS_UNIT_PAGE_SIZE,
  type ProcessIdentity,
  type ProcessOrigin,
  type ProcessSubjectKind,
  type ProcessSubjectList,
  type ProcessSubjectSummary,
  type ProcessSubjectsQuery,
  type ProcessSummaryQuery,
  type ProcessUnitDetail,
  type ProcessUnitFilter,
  type ProcessUnitPage,
  type ProcessUnitStatus,
  type ProcessUnitsQuery,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ValidationError } from '@/platform/errors/domainErrors'
import type {
  ProcessEmployeeCaseRow,
  ProcessTaskUnitRow,
  ProcessViewer,
} from '@/platform/contracts/processFacts'
import { previousWindow } from '../../domain/process/compare'
import type { ProcessLabel, ProcessStage, ProcessUnitFacts } from '../../domain/process/model'
import { stageLabels } from '../../domain/process/stages'
import {
  NO_ROW_EXTRAS,
  unitNumbers,
  unitRowOf,
  type ProcessUnitNumbers,
  type ProcessUnitRowExtras,
} from '../../domain/process/unitSummary'
import {
  employeeStagesOf,
  employeeSubjectRows,
  employeeSummary,
  employeeUnitStatus,
  loadEmployeeUnits,
} from './kinds/employee'
import { unitOfTask } from './kinds/taskUnits'
import {
  loadWorkflowUnits,
  unitStageRows,
  workflowStagesOf,
  workflowSubjectRows,
  workflowSummary,
} from './kinds/workflow'
import { loadWorkgroupUnits, workgroupSubjectRows, workgroupSummary } from './kinds/workgroup'
import { workflowNamesOf, type ProcessSources } from './sources'
import type { SummaryFrame } from './summaryBase'

export interface ProcessQueries {
  subjects(actor: Actor, query: ProcessSubjectsQuery): Promise<ProcessSubjectList>
  summary(
    actor: Actor,
    kind: ProcessSubjectKind,
    subjectId: string | null,
    query: ProcessSummaryQuery,
  ): Promise<ProcessSubjectSummary>
  units(
    actor: Actor,
    kind: ProcessSubjectKind,
    subjectId: string | null,
    query: ProcessUnitsQuery,
  ): Promise<ProcessUnitPage>
  unit(actor: Actor, kind: ProcessSubjectKind, unitId: string): Promise<ProcessUnitDetail | null>
}

export function viewerOf(actor: Actor): ProcessViewer {
  return { userId: actor.user.id, canReadAll: actor.permissions.has('tasks:read:all') }
}

export const canReadTasks = (actor: Actor): boolean =>
  actor.permissions.has('tasks:read:all') || actor.permissions.has('tasks:read:own')

const scopeOf = (viewer: ProcessViewer): 'all' | 'own' => (viewer.canReadAll ? 'all' : 'own')

/** Tasks read to find a workgroup's name when the range holds none: the newest may predate frozen names. */
const NAME_LOOKUP_UNITS = 20

/** Take at most `limit` rows from a read that asked for one more. */
function bounded<T>(rows: readonly T[], limit: number): { rows: T[]; partial: boolean } {
  return { rows: rows.slice(0, limit), partial: rows.length > limit }
}

function matchesFilter(status: ProcessUnitStatus, filter: ProcessUnitFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'succeeded') return status === 'succeeded'
  if (filter === 'active') return status === 'active'
  return status === 'failed' || status === 'canceled'
}

function encodeCursor(startedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([startedAt, id])).toString('base64url')
}

function decodeCursor(cursor: string | undefined): readonly [number, string] | null {
  if (cursor === undefined) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    )
      return [value[0] as number, value[1]]
  } catch {
    /* fall through */
  }
  throw new ValidationError('invalid-query', 'Invalid process metrics cursor')
}

/** Newest first; rows strictly after the cursor. */
function pageOf<T>(
  rows: readonly T[],
  key: (row: T) => readonly [number, string],
  cursor: string | undefined,
): { items: T[]; nextCursor: string | null } {
  const after = decodeCursor(cursor)
  const rest =
    after === null
      ? rows
      : rows.filter((row) => {
          const [startedAt, id] = key(row)
          return startedAt < after[0] || (startedAt === after[0] && id < after[1])
        })
  const items = rest.slice(0, PROCESS_UNIT_PAGE_SIZE)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rest.length > PROCESS_UNIT_PAGE_SIZE && last !== undefined
        ? encodeCursor(...key(last))
        : null,
  }
}

export function createProcessQueries(deps: {
  readonly sources: ProcessSources
  readonly clock?: () => number
}): ProcessQueries {
  const { sources } = deps
  const clock = deps.clock ?? Date.now

  const numbersOf = (facts: readonly ProcessUnitFacts[], now: number) =>
    facts.map((item) => unitNumbers(item, now))

  async function identitiesOf(userIds: Iterable<string | null>): Promise<ProcessIdentity[]> {
    const ids = [...new Set([...userIds].filter((id): id is string => id !== null))]
    return ids.length === 0 ? [] : [...(await sources.identities.identities(ids))]
  }

  const peopleIds = (
    summary: {
      readonly people: readonly { readonly userId: string }[] | null
    } | null,
  ) => summary?.people?.map((person) => person.userId) ?? []

  async function taskRows(
    viewer: ProcessViewer,
    kind: 'workflow' | 'workgroup',
    subjectId: string | null | undefined,
    window: { readonly from: number; readonly to: number },
    limit: number,
  ) {
    return bounded(
      await sources.tasks.units(viewer, {
        kind,
        ...(subjectId === undefined ? {} : { subjectId }),
        from: window.from,
        to: window.to,
        limit: limit + 1,
      }),
      limit,
    )
  }

  async function caseRows(
    viewer: ProcessViewer,
    subjectId: string | null | undefined,
    window: { readonly from: number; readonly to: number },
    limit: number,
  ) {
    // A case always belongs to an employee: "no subject" matches nothing.
    if (subjectId === null) return { rows: [] as ProcessEmployeeCaseRow[], partial: false }
    return bounded(
      await sources.employees.cases(viewer, {
        ...(subjectId === undefined ? {} : { employeeId: subjectId }),
        from: window.from,
        to: window.to,
        limit: limit + 1,
      }),
      limit,
    )
  }

  /** Newest non-null group name per workgroup among the rows. */
  function workgroupNames(rows: readonly ProcessTaskUnitRow[]): Map<string, string | null> {
    const names = new Map<string, string | null>()
    for (const row of rows) {
      const key = row.subjectId ?? ''
      if (!names.has(key) || (names.get(key) === null && row.subjectName !== null))
        names.set(key, row.subjectName)
    }
    return names
  }

  async function workflowName(subjectId: string | null): Promise<string | null> {
    if (subjectId === null) return null
    return (await sources.workflowNames.names([subjectId])).get(subjectId) ?? null
  }

  /**
   * A workgroup's name is frozen on its tasks. A range in which it ran nothing must not
   * rename it "deleted": the newest tasks the viewer can see, at any time, still know it.
   */
  async function workgroupName(
    viewer: ProcessViewer,
    subjectId: string | null,
    rows: readonly ProcessTaskUnitRow[],
  ): Promise<string | null> {
    const known = workgroupNames(rows).get(subjectId ?? '') ?? null
    if (known !== null || subjectId === null) return known
    const newest = await sources.tasks.units(viewer, {
      kind: 'workgroup',
      subjectId,
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      limit: NAME_LOOKUP_UNITS,
    })
    return workgroupNames(newest).get(subjectId) ?? null
  }

  /** The same for a digital employee, whose name travels with its cases. */
  async function employeeName(
    viewer: ProcessViewer,
    subjectId: string | null,
    names: ReadonlyMap<string, string | null>,
  ): Promise<string | null> {
    if (subjectId === null) return null
    const known = names.get(subjectId) ?? null
    if (known !== null) return known
    const newest = await sources.employees.cases(viewer, {
      employeeId: subjectId,
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      limit: 1,
    })
    return newest[0]?.employeeName ?? null
  }

  const byOrigin = <T extends { readonly origin: ProcessOrigin }>(
    rows: readonly T[],
    origin: ProcessOrigin | undefined,
  ) => (origin === undefined ? [...rows] : rows.filter((row) => row.origin === origin))

  /** Split loaded numbers at a revision: at or above is current, below (or unknown) the baseline. */
  function atRevision(numbers: readonly ProcessUnitNumbers[], split: number) {
    const current: ProcessUnitNumbers[] = []
    const baseline: ProcessUnitNumbers[] = []
    for (const item of numbers) {
      const revision = item.facts.unit.subjectRevision
      if (revision !== null && revision >= split) current.push(item)
      else baseline.push(item)
    }
    return { current, baseline }
  }

  return {
    async subjects(actor, query) {
      const asOf = clock()
      const viewer = viewerOf(actor)
      const base = {
        asOf,
        from: query.from,
        to: query.to,
        kind: query.kind,
        scope: scopeOf(viewer),
        unitLimit: PROCESS_LIST_UNIT_LIMIT,
      }
      if (!canReadTasks(actor)) return { ...base, partial: false, items: [] }
      if (query.kind === 'digital-employee') {
        const { rows, partial } = await caseRows(viewer, undefined, query, PROCESS_LIST_UNIT_LIMIT)
        const load = await loadEmployeeUnits(sources, rows, 'list')
        const items = employeeSubjectRows(numbersOf(load.facts, asOf), load)
        return { ...base, partial, items: items.sort((a, b) => b.units - a.units) }
      }
      const { rows, partial } = await taskRows(
        viewer,
        query.kind,
        undefined,
        query,
        PROCESS_LIST_UNIT_LIMIT,
      )
      if (query.kind === 'workflow') {
        const load = await loadWorkflowUnits(sources, rows, 'list')
        const names = await workflowNamesOf(
          sources,
          rows.map((row) => row.subjectId),
        )
        const items = workflowSubjectRows(numbersOf(load.facts, asOf), names)
        return { ...base, partial, items: items.sort((a, b) => b.units - a.units) }
      }
      const load = await loadWorkgroupUnits(sources, rows, 'list', { people: false })
      const items = workgroupSubjectRows(
        numbersOf(load.facts, asOf),
        load.extras,
        workgroupNames(rows),
      )
      return { ...base, partial, items: items.sort((a, b) => b.units - a.units) }
    },

    async summary(actor, kind, subjectId, query) {
      const asOf = clock()
      const viewer = viewerOf(actor)
      const people = viewer.canReadAll
      const readable = canReadTasks(actor)
      const limit = PROCESS_SUMMARY_UNIT_LIMIT
      const split = query.compare === 'version' ? (query.split ?? 0) : null
      if (query.compare === 'version' && kind === 'workgroup')
        throw new ValidationError(
          'invalid-query',
          'A workgroup task does not record the group revision; compare by period instead',
        )
      const before = query.compare === 'period' ? previousWindow(query.from, query.to) : null
      const frameOf = (
        subjectName: string | null,
        partial: boolean,
        identities: readonly ProcessIdentity[],
      ): SummaryFrame => ({
        asOf,
        from: query.from,
        to: query.to,
        tzOffset: query.tzOffset,
        subjectId,
        subjectName,
        scope: scopeOf(viewer),
        partial,
        unitLimit: limit,
        compare: { mode: query.compare, split },
        identities,
      })

      if (kind === 'workflow') {
        const window = readable
          ? await taskRows(viewer, 'workflow', subjectId, query, limit)
          : { rows: [], partial: false }
        const rows = byOrigin(window.rows, query.origin)
        const load = await loadWorkflowUnits(sources, rows, 'full')
        const all = numbersOf(load.facts, asOf)
        let current = all
        let baseline: ProcessUnitNumbers[] | null = null
        if (split !== null) ({ current, baseline } = atRevision(all, split))
        if (before !== null && readable) {
          const previous = await taskRows(viewer, 'workflow', subjectId, before, limit)
          const previousLoad = await loadWorkflowUnits(
            sources,
            byOrigin(previous.rows, query.origin),
            'full',
          )
          baseline = numbersOf(previousLoad.facts, asOf)
        }
        const summary = workflowSummary({
          frame: frameOf(await workflowName(subjectId), window.partial, []),
          load,
          current,
          baseline,
          originRows: window.rows,
          people,
          now: asOf,
        })
        return {
          ...summary,
          identities: await identitiesOf([
            ...peopleIds(summary.review),
            ...peopleIds(summary.clarify),
          ]),
        }
      }

      if (kind === 'workgroup') {
        const window = readable
          ? await taskRows(viewer, 'workgroup', subjectId, query, limit)
          : { rows: [], partial: false }
        const load = await loadWorkgroupUnits(sources, window.rows, 'full', { people })
        const current = numbersOf(load.facts, asOf)
        let baseline: ProcessUnitNumbers[] | null = null
        let baselineExtras = null
        if (before !== null && readable) {
          const previous = await taskRows(viewer, 'workgroup', subjectId, before, limit)
          const previousLoad = await loadWorkgroupUnits(sources, previous.rows, 'full', { people })
          baseline = numbersOf(previousLoad.facts, asOf)
          baselineExtras = previousLoad.extras
        }
        const summary = workgroupSummary({
          frame: frameOf(
            readable ? await workgroupName(viewer, subjectId, window.rows) : null,
            window.partial,
            [],
          ),
          load,
          current,
          baseline,
          baselineExtras,
          people,
          now: asOf,
        })
        return { ...summary, identities: await identitiesOf(peopleIds(summary.clarify)) }
      }

      const window = readable
        ? await caseRows(viewer, subjectId, query, limit)
        : { rows: [], partial: false }
      const load = await loadEmployeeUnits(sources, window.rows, 'full')
      const all = numbersOf(load.facts, asOf)
      let current = all
      let baseline: ProcessUnitNumbers[] | null = null
      let baselineExtras = null
      if (split !== null) ({ current, baseline } = atRevision(all, split))
      if (before !== null && readable) {
        const previous = await caseRows(viewer, subjectId, before, limit)
        const previousLoad = await loadEmployeeUnits(sources, previous.rows, 'full')
        baseline = numbersOf(previousLoad.facts, asOf)
        baselineExtras = previousLoad.extras
      }
      const summary = employeeSummary({
        frame: frameOf(
          readable ? await employeeName(viewer, subjectId, load.names) : null,
          window.partial,
          [],
        ),
        load,
        current,
        baseline,
        baselineExtras,
        people,
        now: asOf,
      })
      return { ...summary, identities: await identitiesOf(peopleIds(summary.review)) }
    },

    async units(actor, kind, subjectId, query) {
      const asOf = clock()
      const viewer = viewerOf(actor)
      const empty: ProcessUnitPage = {
        asOf,
        items: [],
        nextCursor: null,
        identities: [],
        stageLabels: {},
      }
      if (!canReadTasks(actor)) return empty
      const limit = PROCESS_SUMMARY_UNIT_LIMIT

      if (kind === 'digital-employee') {
        const { rows } = await caseRows(viewer, subjectId, query, limit)
        const page = pageOf(
          byOrigin(rows, query.origin).filter((row) =>
            matchesFilter(employeeUnitStatus(row), query.status),
          ),
          (row) => [row.createdAt, row.caseId],
          query.cursor,
        )
        const load = await loadEmployeeUnits(sources, page.items, 'list')
        const labels: Record<string, ProcessLabel> = {}
        for (const manifest of load.manifests.values())
          Object.assign(labels, stageLabels(employeeStagesOf(manifest)))
        const used = new Set(
          [...load.extras.values()].flatMap((extra) => extra.rework.map((item) => item.key)),
        )
        return {
          asOf,
          items: numbersOf(load.facts, asOf).map((item) =>
            unitRowOf(item, load.extras.get(item.facts.unit.id) ?? NO_ROW_EXTRAS),
          ),
          nextCursor: page.nextCursor,
          identities: await identitiesOf(page.items.map((row) => row.ownerUserId)),
          stageLabels: Object.fromEntries(Object.entries(labels).filter(([key]) => used.has(key))),
        }
      }

      const { rows } = await taskRows(viewer, kind, subjectId, query, limit)
      const page = pageOf(
        byOrigin(rows, query.origin).filter((row) =>
          matchesFilter(unitOfTask(row).status, query.status),
        ),
        (row) => [row.startedAt, row.taskId],
        query.cursor,
      )
      let facts: readonly ProcessUnitFacts[]
      let extras: ReadonlyMap<string, ProcessUnitRowExtras> = new Map()
      if (kind === 'workflow') {
        facts = (await loadWorkflowUnits(sources, page.items, 'list')).facts
      } else {
        const load = await loadWorkgroupUnits(sources, page.items, 'list', { people: false })
        facts = load.facts
        extras = load.extras
      }
      return {
        asOf,
        items: numbersOf(facts, asOf).map((item) =>
          unitRowOf(item, extras.get(item.facts.unit.id) ?? NO_ROW_EXTRAS),
        ),
        nextCursor: page.nextCursor,
        identities: await identitiesOf(page.items.map((row) => row.ownerUserId)),
        stageLabels: {},
      }
    },

    async unit(actor, kind, unitId) {
      const asOf = clock()
      const viewer = viewerOf(actor)
      if (!canReadTasks(actor)) return null
      let facts: ProcessUnitFacts
      let stages: readonly ProcessStage[]
      let extras: ProcessUnitRowExtras = NO_ROW_EXTRAS
      if (kind === 'digital-employee') {
        const row = await sources.employees.case(viewer, unitId)
        if (row === null) return null
        const load = await loadEmployeeUnits(sources, [row], 'full')
        facts = load.facts[0]!
        extras = load.extras.get(unitId) ?? NO_ROW_EXTRAS
        const manifest = [...load.manifests.values()][0] ?? null
        const known = employeeStagesOf(manifest)
        const keys = new Set(known.map((stage) => stage.key))
        stages = [
          ...known,
          ...[...new Set(facts.executions.map((item) => item.stageKey))]
            .filter((key) => !keys.has(key))
            .map(
              (key, index): ProcessStage => ({
                key,
                label: key,
                kind: 'work-item-system',
                parentKey: null,
                order: 1e9 + index,
                // Missing from a manifest that was read; with none, nothing says it was removed.
                removed: manifest !== null,
              }),
            ),
        ]
      } else {
        const row = await sources.tasks.unit(viewer, unitId)
        // The task must be of the kind the caller named: a workgroup task is not a workflow unit.
        if (row === null || (row.engineKind === 'dag') !== (kind === 'workflow')) return null
        if (kind === 'workflow') {
          const load = await loadWorkflowUnits(sources, [row], 'full')
          facts = load.facts[0]!
          stages = workflowStagesOf(load, load.facts)
        } else {
          const load = await loadWorkgroupUnits(sources, [row], 'full', {
            people: viewer.canReadAll,
          })
          facts = load.facts[0]!
          stages = load.stages
          extras = load.extras.get(unitId) ?? NO_ROW_EXTRAS
        }
      }
      return {
        asOf,
        unit: unitRowOf(unitNumbers(facts, asOf), extras),
        stages: unitStageRows(stages, facts, asOf),
        identities: await identitiesOf([facts.unit.ownerUserId]),
      }
    },
  }
}
