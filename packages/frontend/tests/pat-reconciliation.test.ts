// RFC-250 T8-T10 — a PAT create is a non-idempotent write.  If the response is
// lost, the browser must retain a non-secret receipt and reconcile inventory;
// it must never recover as an ordinary blank Create form that invites a retry.

import { beforeEach, describe, expect, test } from 'vitest'
import type { PatPublic } from '@agent-workflow/shared'
import {
  clearAllPatReconciliationMarkers,
  clearPatReconciliationMarker,
  createPatReconciliationMarker,
  findPatReconciliationCandidates,
  patReconciliationStorageKey,
  readPatReconciliationMarker,
  writePatReconciliationMarker,
} from '../src/lib/pat-reconciliation'

const ACTOR_ID = 'user-a'

const existing: PatPublic = {
  id: 'pat-existing',
  name: 'older',
  scopes: [],
  purpose: 'mcp_only',
  createdAt: 100,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('RFC-250 PAT reconciliation marker', () => {
  test('round-trips only the non-secret request summary and captured inventory ids', () => {
    const marker = createPatReconciliationMarker({
      actorId: ACTOR_ID,
      startedAt: 1_000,
      name: 'ci',
      purpose: 'general',
      scopes: ['tasks:execute', 'agents:update'],
      expiresAt: 9_000,
      visiblePats: [existing],
    })

    writePatReconciliationMarker(marker)

    expect(Object.keys(marker).sort()).toEqual([
      'actorId',
      'expiresAt',
      'name',
      'purpose',
      'schemaVersion',
      'scopes',
      'startedAt',
      'visiblePatIds',
    ])
    expect(sessionStorage.getItem(patReconciliationStorageKey(ACTOR_ID))).not.toContain('awpat_')
    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'valid', marker })
  })

  test('a corrupt/unknown marker fails closed instead of pretending there is no pending attempt', () => {
    const storageKey = patReconciliationStorageKey(ACTOR_ID)
    sessionStorage.setItem(storageKey, '{"schemaVersion":99}')

    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'invalid' })
    expect(sessionStorage.getItem(storageKey)).not.toBeNull()
  })

  test('candidate matching requires a new id and the exact non-sensitive request summary', () => {
    const marker = createPatReconciliationMarker({
      actorId: ACTOR_ID,
      startedAt: 1_000,
      name: 'ci',
      purpose: 'general',
      scopes: ['agents:update', 'tasks:execute'],
      expiresAt: 9_000,
      visiblePats: [existing],
    })
    const candidate: PatPublic = {
      ...existing,
      id: 'pat-new',
      name: 'ci',
      purpose: 'general',
      scopes: ['tasks:execute', 'agents:update'],
      createdAt: 1_001,
      expiresAt: 9_000,
    }

    expect(
      findPatReconciliationCandidates(marker, [
        existing,
        candidate,
        { ...candidate, id: 'created-before-attempt', createdAt: 999 },
        { ...candidate, id: 'wrong-name', name: 'other' },
        { ...candidate, id: 'wrong-scope', scopes: ['tasks:execute'] },
      ]),
    ).toEqual([candidate])
  })

  test('the marker is removed only through the explicit clear operation', () => {
    writePatReconciliationMarker(
      createPatReconciliationMarker({
        actorId: ACTOR_ID,
        startedAt: 1_000,
        name: 'ci',
        purpose: 'mcp_only',
        scopes: [],
        expiresAt: null,
        visiblePats: [],
      }),
    )

    expect(clearPatReconciliationMarker(ACTOR_ID)).toBe(true)
    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'none' })
  })

  test('isolates recovery receipts by actor and logout cleanup removes every actor namespace', () => {
    writePatReconciliationMarker(
      createPatReconciliationMarker({
        actorId: ACTOR_ID,
        startedAt: 1_000,
        name: 'alice-token',
        purpose: 'mcp_only',
        scopes: [],
        expiresAt: null,
        visiblePats: [],
      }),
    )

    expect(readPatReconciliationMarker('user-b')).toEqual({ kind: 'none' })
    expect(readPatReconciliationMarker(ACTOR_ID).kind).toBe('valid')
    expect(clearAllPatReconciliationMarkers()).toBe(true)
    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'none' })
  })
})
