// RFC-616 §8.1 — the process metrics HTTP contract on the client side.
import {
  PROCESS_NO_SUBJECT,
  type ProcessCompareMode,
  type ProcessInsightAccepted,
  type ProcessInsightView,
  type ProcessOrigin,
  type ProcessSubjectKind,
  type ProcessSubjectList,
  type ProcessSubjectSummary,
  type ProcessUnitDetail,
  type ProcessUnitFilter,
  type ProcessUnitPage,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { ObservationWindow } from '@/components/observability/observationClient'

/** Every process metrics query lives under this key, so one invalidation refreshes the tab. */
export const PROCESS_QUERY = ['observability', 'process'] as const

const BASE = '/api/observability/process'

const subjectPath = (kind: ProcessSubjectKind, subjectId: string | null) =>
  `${BASE}/subjects/${kind}/${encodeURIComponent(subjectId ?? PROCESS_NO_SUBJECT)}`

export interface ProcessSummaryOptions {
  readonly compare: ProcessCompareMode
  readonly split?: number
  readonly origin?: ProcessOrigin
}

export const processApi = {
  subjects: (kind: ProcessSubjectKind, window: ObservationWindow, signal?: AbortSignal) =>
    api.get<ProcessSubjectList>(
      `${BASE}/subjects`,
      { kind, from: window.from, to: window.to },
      signal,
    ),
  summary: (
    kind: ProcessSubjectKind,
    subjectId: string | null,
    window: ObservationWindow,
    options: ProcessSummaryOptions,
    signal?: AbortSignal,
  ) =>
    api.get<ProcessSubjectSummary>(
      subjectPath(kind, subjectId),
      {
        from: window.from,
        to: window.to,
        tzOffset: window.tzOffset,
        compare: options.compare,
        split: options.split,
        origin: options.origin,
      },
      signal,
    ),
  units: (
    kind: ProcessSubjectKind,
    subjectId: string | null,
    window: ObservationWindow,
    filter: {
      readonly status: ProcessUnitFilter
      readonly origin?: ProcessOrigin
      readonly cursor?: string
    },
    signal?: AbortSignal,
  ) =>
    api.get<ProcessUnitPage>(
      `${subjectPath(kind, subjectId)}/units`,
      {
        from: window.from,
        to: window.to,
        status: filter.status,
        origin: filter.origin,
        cursor: filter.cursor,
      },
      signal,
    ),
  unit: (kind: ProcessSubjectKind, unitId: string, signal?: AbortSignal) =>
    api.get<ProcessUnitDetail>(
      `${BASE}/units/${kind}/${encodeURIComponent(unitId)}`,
      undefined,
      signal,
    ),
  insight: (
    kind: ProcessSubjectKind,
    subjectId: string | null,
    window: ObservationWindow,
    signal?: AbortSignal,
  ) =>
    api.get<ProcessInsightView>(
      `${subjectPath(kind, subjectId)}/insight`,
      { from: window.from, to: window.to },
      signal,
    ),
  requestInsight: (kind: ProcessSubjectKind, subjectId: string | null, window: ObservationWindow) =>
    api.post<ProcessInsightAccepted>(`${subjectPath(kind, subjectId)}/insight`, {
      from: window.from,
      to: window.to,
    }),
}
