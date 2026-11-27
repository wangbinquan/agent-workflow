// RFC-616 §9.2 — the text people wrote around a subject, for theme analysis.
// Text is only ever read here, for the units the given viewer may see; the
// metric queries never load it.

import {
  PROCESS_SUMMARY_UNIT_LIMIT,
  WORKGROUP_TURN_LEADER_NODE_ID,
  type ProcessSubjectKind,
} from '@agent-workflow/shared'
import type { ProcessTextItem, ProcessViewer } from '@/platform/contracts/processFacts'
import type { ProcessLabel } from '../../domain/process/model'
import { stageLabels, workflowStageCatalog } from '../../domain/process/stages'
import { employeeStagesOf } from './kinds/employee'
import { LEADER_STAGE } from './kinds/workgroup'
import { chunked, type ProcessSources, type ResolvedText } from './sources'

export interface ProcessTextCollection {
  readonly subjectName: string | null
  readonly items: readonly ResolvedText[]
  readonly stageLabels: Readonly<Record<string, ProcessLabel>>
  /** Units the text was collected from. */
  readonly units: number
}

export interface ProcessTexts {
  collect(
    viewer: ProcessViewer,
    kind: ProcessSubjectKind,
    subjectId: string | null,
    window: { readonly from: number; readonly to: number },
  ): Promise<ProcessTextCollection>
}

export function createProcessTexts(sources: ProcessSources): ProcessTexts {
  const limit = PROCESS_SUMMARY_UNIT_LIMIT

  return {
    async collect(viewer, kind, subjectId, window) {
      if (kind === 'digital-employee') {
        if (subjectId === null) return { subjectName: null, items: [], stageLabels: {}, units: 0 }
        const cases = await sources.employees.cases(viewer, {
          employeeId: subjectId,
          from: window.from,
          to: window.to,
          limit,
        })
        const caseIds = cases.map((row) => row.caseId)
        const [feedback, rounds] = await Promise.all([
          chunked(caseIds, (chunk) => sources.employees.texts(chunk)),
          chunked(caseIds, (chunk) => sources.employees.rounds(chunk)),
        ])
        // Plan reviews happen in the host tasks of the rounds.
        const hosts = await chunked(
          rounds.map((round) => round.roundId),
          (chunk) => sources.tasks.reactionHostTasks(chunk),
        )
        const roundById = new Map(rounds.map((round) => [round.roundId, round]))
        const roundOfTask = new Map(hosts.map((host) => [host.taskId, roundById.get(host.roundId)]))
        const reviews = await chunked(
          hosts.map((host) => host.taskId),
          (chunk) => sources.gates.texts(chunk, ['review']),
        )
        const items: ResolvedText[] = [
          ...feedback.flatMap((item): ResolvedText[] =>
            item.caseId === null
              ? []
              : [
                  {
                    source: item.source,
                    unitId: item.caseId,
                    stageKey: item.stageRef,
                    at: item.at,
                    text: item.text,
                  },
                ],
          ),
          ...reviews.flatMap((item): ResolvedText[] => {
            const round = item.taskId === null ? undefined : roundOfTask.get(item.taskId)
            return round === undefined
              ? []
              : [
                  {
                    source: item.source,
                    unitId: round.caseId,
                    stageKey: round.workItemRef,
                    at: item.at,
                    text: item.text,
                  },
                ]
          }),
        ]
        const newest = cases[0]
        const manifest = newest
          ? await sources.employees.manifest(newest.typeId, newest.typeRevision)
          : null
        return {
          subjectName: newest?.employeeName ?? null,
          items,
          stageLabels: stageLabels(employeeStagesOf(manifest)),
          units: cases.length,
        }
      }

      const rows = await sources.tasks.units(viewer, {
        kind,
        subjectId,
        from: window.from,
        to: window.to,
        limit,
      })
      const taskIds = rows.map((row) => row.taskId)
      const ofTask = (
        item: ProcessTextItem,
        stageKey: (stageRef: string | null) => string | null,
      ): ResolvedText[] =>
        item.taskId === null
          ? []
          : [
              {
                source: item.source,
                unitId: item.taskId,
                stageKey: stageKey(item.stageRef),
                at: item.at,
                text: item.text,
              },
            ]

      if (kind === 'workgroup') {
        const [room, clarify] = await Promise.all([
          chunked(taskIds, (chunk) => sources.workgroups.texts(chunk)),
          chunked(taskIds, (chunk) => sources.gates.texts(chunk, ['clarify'])),
        ])
        // A workgroup's asker is its leader or "a member"; only the leader is a nameable stage here.
        const stageKey = (stageRef: string | null) =>
          stageRef === WORKGROUP_TURN_LEADER_NODE_ID ? LEADER_STAGE : null
        return {
          subjectName: rows.find((row) => row.subjectName !== null)?.subjectName ?? null,
          items: [...room, ...clarify].flatMap((item) => ofTask(item, stageKey)),
          stageLabels: {},
          units: rows.length,
        }
      }

      const texts = await chunked(taskIds, (chunk) =>
        sources.gates.texts(chunk, ['review', 'clarify']),
      )
      const definition = rows[0] ? await sources.tasks.definition(rows[0].taskId) : null
      const catalog = workflowStageCatalog(
        definition,
        texts.flatMap((item) => (item.stageRef === null ? [] : [item.stageRef])),
      )
      const names =
        subjectId === null
          ? new Map<string, string>()
          : await sources.workflowNames.names([subjectId])
      return {
        subjectName: subjectId === null ? null : (names.get(subjectId) ?? null),
        items: texts.flatMap((item) =>
          ofTask(item, (stageRef) => (stageRef === null ? null : catalog.stageOf(stageRef))),
        ),
        stageLabels: stageLabels(catalog.stages),
        units: rows.length,
      }
    },
  }
}
