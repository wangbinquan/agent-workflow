// RFC-371: exact committed revisions are notification identities, never floats.
import { expect, test } from 'bun:test'
import { ObservationProjectionWsMessageSchema, WS_PATHS } from '../src'

test('arbitrary-precision projection revisions and the dedicated path are retained exactly', () => {
  const revision = '9007199254740997000000000001'
  expect(
    ObservationProjectionWsMessageSchema.parse({
      type: 'observability.projection.changed',
      revision,
      asOf: 1791763200000,
    }).revision,
  ).toBe(revision)
  expect(WS_PATHS.observability).toBe('/ws/observability')
})
test('malformed clocks/revisions and extra numerical payloads are rejected', () => {
  const base = { type: 'observability.projection.changed', revision: '1', asOf: 1791763200000 }
  for (const value of [
    { ...base, revision: '01' },
    { ...base, revision: '-1' },
    { ...base, revision: Number('9007199254740997') },
    { ...base, asOf: -1 },
    { ...base, asOf: Number.NaN },
    { ...base, tokens: '999' },
  ])
    expect(ObservationProjectionWsMessageSchema.safeParse(value).success).toBe(false)
})
