import type {
  HistoricalObservationExecution,
  ObservationDimensionSelection,
  ObservationModelIdentity,
} from '@agent-workflow/shared'
import { modelDimensionMatch } from './analysisDimensions'

export type HistoricalObservationMatch = 'matched' | 'excluded' | 'unresolved'
const nullable = (
  expected: string | number | null,
  actual: string | number | null,
): HistoricalObservationMatch =>
  expected === actual ? 'matched' : actual === null && expected !== null ? 'unresolved' : 'excluded'
export function historicalObservationDimensionMatch(
  selection: ObservationDimensionSelection | null,
  execution: HistoricalObservationExecution,
  model: { readonly provider: string; readonly id: string } | null,
): HistoricalObservationMatch {
  if (selection === null) return 'matched'
  const values: HistoricalObservationMatch[] = []
  if (selection.agent)
    values.push(
      nullable(selection.agent.id, execution.agentId),
      nullable(selection.agent.revision, execution.agentRevision),
    )
  if (selection.purpose)
    values.push(selection.purpose === execution.purpose ? 'matched' : 'excluded')
  if (selection.runtime) {
    const expected = selection.runtime,
      runtime = execution.runtime
    values.push(
      expected.authority === 'local' ? 'matched' : 'excluded',
      nullable(expected.sourceId, null),
      nullable(expected.registrationId, runtime?.registrationId ?? null),
      nullable(expected.configurationRevision, runtime?.configurationRevision ?? null),
      nullable(expected.protocol, runtime?.protocol ?? null),
    )
  }
  if (selection.source)
    values.push(
      selection.source.authority === 'local' ? 'matched' : 'excluded',
      nullable(selection.source.sourceId, null),
    )
  if (selection.model) {
    const actual: ObservationModelIdentity = {
      authority: 'local',
      sourceId: null,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
    }
    values.push(modelDimensionMatch(selection, actual))
  }
  return values.includes('excluded')
    ? 'excluded'
    : values.includes('unresolved')
      ? 'unresolved'
      : 'matched'
}
