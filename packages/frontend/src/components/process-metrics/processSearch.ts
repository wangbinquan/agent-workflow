// RFC-616 §11.1 — the part of the run observation URL that belongs to the
// process metrics tab, and the one definition of a link into it. The three
// entry points (workflow editor, workgroup detail, digital employee card) and
// the tab itself all build their search through here.
import {
  PROCESS_NO_SUBJECT,
  PROCESS_ORIGINS,
  PROCESS_SUBJECT_KINDS,
  type ProcessOrigin,
  type ProcessSubjectKind,
} from '@agent-workflow/shared'

/** Sub-tabs of a subject page; which ones exist depends on the subject kind. */
export const PROCESS_VIEWS = [
  'overview',
  'stages',
  'rounds',
  'members',
  'duties',
  'gates',
  'units',
  'insights',
] as const
export type ProcessView = (typeof PROCESS_VIEWS)[number]

export const PROCESS_VIEWS_OF: Readonly<Record<ProcessSubjectKind, readonly ProcessView[]>> = {
  workflow: ['overview', 'stages', 'gates', 'units', 'insights'],
  workgroup: ['overview', 'rounds', 'members', 'gates', 'units', 'insights'],
  'digital-employee': ['overview', 'duties', 'gates', 'units', 'insights'],
}

/** The view a hint points at, for this subject kind. */
export function viewOfHintTarget(kind: ProcessSubjectKind, target: string): ProcessView {
  if (target === 'stages') return kind === 'digital-employee' ? 'duties' : 'stages'
  const views = PROCESS_VIEWS_OF[kind]
  return views.includes(target as ProcessView) ? (target as ProcessView) : 'overview'
}

export const PROCESS_COMPARE_PARAMS = ['period', 'version'] as const
export type ProcessCompareParam = (typeof PROCESS_COMPARE_PARAMS)[number]

/** What the process tab keeps in the URL; every field is optional and shareable. */
export interface ProcessSearchFields {
  /** Subject id; `-` is the group of units without a source id. Absent: the listing. */
  readonly subject?: string
  readonly view?: ProcessView
  readonly compare?: ProcessCompareParam
  /** With `compare=version`: the revision that starts the current group. */
  readonly split?: number
  readonly origin?: ProcessOrigin
  /** The unit whose stages are expanded in the units view. */
  readonly unit?: string
}

export function processSubjectKind(value: unknown): ProcessSubjectKind {
  return PROCESS_SUBJECT_KINDS.includes(value as ProcessSubjectKind)
    ? (value as ProcessSubjectKind)
    : 'workflow'
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined

/** Decode the process fields of a raw URL search; anything invalid is dropped. */
export function validateProcessSearch(raw: Record<string, unknown>): ProcessSearchFields {
  const subject = text(raw.subject, 200)
  const unit = text(raw.unit, 200)
  const view = PROCESS_VIEWS.includes(raw.view as ProcessView)
    ? (raw.view as ProcessView)
    : undefined
  const compare = PROCESS_COMPARE_PARAMS.includes(raw.compare as ProcessCompareParam)
    ? (raw.compare as ProcessCompareParam)
    : undefined
  // Only a number or a string of digits is a revision: `Number()` alone would read '', null or [] as 0.
  const split =
    typeof raw.split === 'number'
      ? raw.split
      : typeof raw.split === 'string' && /^\d{1,9}$/.test(raw.split)
        ? Number(raw.split)
        : Number.NaN
  const validSplit = Number.isSafeInteger(split) && split >= 0
  const origin = PROCESS_ORIGINS.includes(raw.origin as ProcessOrigin)
    ? (raw.origin as ProcessOrigin)
    : undefined
  return {
    ...(subject === undefined ? {} : { subject }),
    ...(view === undefined ? {} : { view }),
    // A revision split without its revision compares nothing.
    ...(compare === undefined || (compare === 'version' && !validSplit) ? {} : { compare }),
    ...(compare === 'version' && validSplit ? { split } : {}),
    ...(origin === undefined ? {} : { origin }),
    ...(unit === undefined ? {} : { unit }),
  }
}

/**
 * The link to one subject's process metrics, for `<Link {...processMetricsLink(…)}>`.
 * Opens on the last 30 days: a week rarely holds enough runs of one workflow to compare.
 */
export function processMetricsLink(kind: ProcessSubjectKind, subjectId: string | null) {
  return {
    to: '/observability' as const,
    search: {
      tab: 'process' as const,
      range: '30d' as const,
      kind,
      subject: subjectId ?? PROCESS_NO_SUBJECT,
    },
  }
}
