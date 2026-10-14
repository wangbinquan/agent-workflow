// RFC-371 / CI 38506044476: resumed maintenance must restore its exact saved
// context through the original Actor module, keeping optional fields and grants.
import { expect, test } from 'bun:test'
import { buildActor, restoreActorSnapshot } from '@/auth/actor'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'

for (const source of ['session', 'pat', 'daemon'] as const)
  test(`durable ${source} maintenance restores the original fields and exact permission set`, () => {
    const original = buildActor({
        user: {
          id: 'original-maintenance-owner',
          username: 'Original user',
          displayName: 'Original display name',
          role: 'admin',
          status: 'active',
        },
        source,
        authorityRevision: 7,
        patScopes: ['tasks:read:all'],
        patPurpose: 'mcp_only',
        patId: 'original-pat',
      }),
      retained = JSON.stringify({ ...original, permissions: [...original.permissions] }),
      restored = restoreActorSnapshot(JSON.parse(retained))
    expect(restored).toEqual(original)
    expect(restored.permissions).toEqual(original.permissions)
    expect(completeObservationActorScope(restored)).toBe(completeObservationActorScope(original))
    expect(JSON.stringify({ ...restored, permissions: [...restored.permissions] })).toBe(retained)
    expect(restored).not.toBe(original)
    expect(restored.user).not.toBe(original.user)
    expect(restored.permissions).not.toBe(original.permissions)
    expect(Object.isFrozen(restored)).toBe(true)
    expect(Object.isFrozen(restored.user)).toBe(true)
  })

test('restoration keeps absent optional fields absent and does not expand the saved permissions', () => {
  const retained = {
      user: {
        id: 'original-maintenance-owner',
        username: 'Original user',
        displayName: 'Original display name',
        role: 'admin' as const,
        status: 'active' as const,
      },
      source: 'session' as const,
      permissions: ['tasks:read:all'] as const,
    },
    restored = restoreActorSnapshot(retained)
  expect([...restored.permissions]).toEqual([...retained.permissions])
  expect(restored).not.toHaveProperty('authorityRevision')
  expect(restored).not.toHaveProperty('purpose')
  expect(restored).not.toHaveProperty('patId')
  expect(retained.permissions).toEqual(['tasks:read:all'])
})
