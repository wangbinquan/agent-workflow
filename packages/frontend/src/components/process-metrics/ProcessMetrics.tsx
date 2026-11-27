// RFC-616 §11 — the process metrics tab of run observation: a listing of the
// workflows, workgroups or digital employees that ran in the window, and one
// subject's metrics. Everything it shows is in the URL, so a view can be shared.
import { PROCESS_NO_SUBJECT, type ProcessSubjectKind } from '@agent-workflow/shared'
import type { ObservationSearch } from '@/components/observability/RunObservability'
import type { ObservationWindow } from '@/components/observability/observationClient'
import { ProcessSubject } from './ProcessSubject'
import { ProcessSubjectList } from './ProcessSubjectList'
import { processSubjectKind } from './processSearch'

/** The search without anything that belongs to one opened subject. */
function withoutSubject(search: ObservationSearch): ObservationSearch {
  const {
    subject: _subject,
    view: _view,
    compare: _compare,
    split: _split,
    origin: _origin,
    unit: _unit,
    ...rest
  } = search
  return rest
}

export function ProcessMetrics(props: {
  search: ObservationSearch
  window: ObservationWindow
  onChange: (next: ObservationSearch) => void
}) {
  const { search, window, onChange } = props
  const kind = processSubjectKind(search.kind)
  if (search.subject === undefined) {
    return (
      <ProcessSubjectList
        kind={kind}
        window={window}
        onKind={(next: ProcessSubjectKind) => onChange({ ...withoutSubject(search), kind: next })}
        onOpen={(subjectId) =>
          onChange({ ...withoutSubject(search), kind, subject: subjectId ?? PROCESS_NO_SUBJECT })
        }
      />
    )
  }
  return (
    <ProcessSubject
      kind={kind}
      subjectId={search.subject === PROCESS_NO_SUBJECT ? null : search.subject}
      search={search}
      window={window}
      onChange={onChange}
      onBack={() => onChange({ ...withoutSubject(search), kind })}
    />
  )
}
