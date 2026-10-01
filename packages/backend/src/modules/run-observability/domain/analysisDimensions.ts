import {
  ObservationDimensionSelectionSchema,
  type AcceptedObservationInvocation,
  type ObservationDimensionSelection,
  type ObservationModelIdentity,
  type ObservationRuntimeIdentity,
} from '@agent-workflow/shared'

type Match = 'matched' | 'unresolved' | 'excluded'
const nullable = (expected: string | number | null, actual: string | number | null): Match =>
  expected === actual ? 'matched' : actual === null && expected !== null ? 'unresolved' : 'excluded'
const combine = (values: readonly Match[]): Match =>
  values.includes('excluded')
    ? 'excluded'
    : values.includes('unresolved')
      ? 'unresolved'
      : 'matched'

export function parseObservationSelection(
  value: string | undefined,
): ObservationDimensionSelection | null {
  if (value === undefined) return null
  try {
    if (value.length > 2048) throw new Error('selection too long')
    return ObservationDimensionSelectionSchema.parse(JSON.parse(value))
  } catch {
    throw new RangeError('Invalid observation dimension selection')
  }
}

export function invocationRuntimeIdentity(
  invocation: AcceptedObservationInvocation,
): ObservationRuntimeIdentity {
  const authority = invocation.authority,
    runtime = authority.kind === 'local' ? authority.runtime : null
  return {
    authority: authority.kind,
    sourceId: authority.kind === 'crewstation' ? authority.sourceId : null,
    registrationId: runtime?.registrationId ?? null,
    configurationRevision: runtime?.configurationRevision ?? null,
    protocol: runtime?.protocol ?? null,
  }
}

/** Missing frozen identity cannot attribute known usage to a named range. */
export function invocationDimensionMatch(
  selection: ObservationDimensionSelection,
  invocation: AcceptedObservationInvocation,
): Match {
  const runtime = invocationRuntimeIdentity(invocation),
    values: Match[] = []
  if (selection.runtime) {
    const expected = selection.runtime
    values.push(
      expected.authority === runtime.authority ? 'matched' : 'excluded',
      ...(['sourceId', 'registrationId', 'configurationRevision', 'protocol'] as const).map((key) =>
        nullable(expected[key], runtime[key]),
      ),
    )
  }
  if (selection.source)
    values.push(
      selection.source.authority === runtime.authority ? 'matched' : 'excluded',
      nullable(selection.source.sourceId, runtime.sourceId),
    )
  // Actual model evidence is still bound to the accepted installation/authority.
  if (selection.model)
    values.push(
      selection.model.authority === runtime.authority ? 'matched' : 'excluded',
      nullable(selection.model.sourceId, runtime.sourceId),
    )
  if (selection.agent)
    values.push(
      nullable(selection.agent.id, invocation.agentId),
      nullable(selection.agent.revision, invocation.agentRevision),
    )
  if (selection.purpose)
    values.push(selection.purpose === invocation.purpose ? 'matched' : 'excluded')
  return combine(values)
}

export function modelDimensionMatch(
  selection: ObservationDimensionSelection,
  model: ObservationModelIdentity,
): Match {
  const expected = selection.model
  if (!expected) return 'matched'
  return combine([
    expected.authority === model.authority ? 'matched' : 'excluded',
    nullable(expected.sourceId, model.sourceId),
    nullable(expected.provider, model.provider),
    nullable(expected.model, model.model),
  ])
}
