// RFC-371: empty native proof is only zero after every turn and sync boundary is proven.
import { expect, test } from 'bun:test'
import fixture from '../../shared/tests/fixtures/crewstation-native-capture-v2.json'
import { platformCaptureEvidence } from '../src/modules/run-observability/domain/platformCapture'
import {
  PlatformObservationPageSchema,
  type PlatformObservation,
} from '../src/modules/run-observability/domain/platformObservation'
import { initialPlatformSyncState } from '../src/modules/run-observability/domain/platformSync'

const state = {
  ...initialPlatformSyncState({
    sourceId: 'cs',
    projectId: fixture.identity.projectId,
    taskId: fixture.identity.taskId,
  }),
  schemaVersion: 2 as const,
  status: 'ready' as const,
  costVisibility: 'project-members-and-services' as const,
  costsReady: true,
}
function turn(index = 0, patch: Record<string, unknown> = {}): PlatformObservation {
  const id = 'capture-' + index
  return PlatformObservationPageSchema.parse({
    schemaVersion: 2,
    capability: 'executionObservationsV2',
    mode: 'incremental',
    projectId: fixture.identity.projectId,
    taskId: fixture.identity.taskId,
    items: [
      {
        ...fixture,
        recordId: id,
        capture: {
          ...fixture.capture,
          id,
          proof: { ...fixture.capture.proof, turn: 'turn-' + index, turnIndex: index },
          ...patch,
        },
      },
    ],
    nextCursor: null,
    persistedThrough: 'through',
    firstAvailableCursor: 'first',
    asOf: fixture.observedAt,
    visibilityRevision: 0,
    costVisibility: 'project-members-and-services',
    gaps: [],
  }).items[0]!
}
test('missing initial, middle or duplicate turns cannot establish a complete empty invocation', () => {
  for (const rows of [[turn(1)], [turn(0), turn(2)], [turn(0), turn(0)]]) {
    const result = platformCaptureEvidence(rows, state)
    expect(result.knownZero).toBe(false)
    expect(result.reasons).toContain('native-turn-gap')
  }
  expect(platformCaptureEvidence([turn(1), turn(0)], state)).toMatchObject({
    knownZero: true,
    emptyCostVisible: true,
    reasons: [],
  })
})
test('pending, unsupported, missing, old-version and unsynchronized proof keep zero unknown', () => {
  for (const rows of [
    [],
    [turn(0, { state: 'pending' })],
    [turn(0, { state: 'unsupported' })],
    [turn(0, { unresolvedBaselineSteps: 1 })],
  ])
    expect(platformCaptureEvidence(rows, state).knownZero).toBe(false)
  for (const next of [
    { ...state, schemaVersion: 1 as const },
    { ...state, status: 'syncing' as const },
    { ...state, status: 'failed' as const },
    {
      ...state,
      gaps: [{ after: null, through: 'through', reason: 'capture-incomplete' as const }],
    },
  ])
    expect(platformCaptureEvidence([turn()], next).knownZero).toBe(false)
  expect(platformCaptureEvidence([turn()], { ...state, costVisibility: 'hidden' })).toMatchObject({
    knownZero: true,
    emptyCostVisible: false,
  })
})
