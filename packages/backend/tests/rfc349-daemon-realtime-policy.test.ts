// RFC-349 -- the selected provider core is composed before cross-owner
// realtime visibility/redaction policy. The bootstrap binding must remain
// request-local, fail closed before admission, and accept exactly one policy.

import { describe, expect, test } from 'bun:test'

import { buildActor } from '../src/auth/actor'
import { createDaemonRealtimePolicyBinding } from '../src/cli/daemonRealtimePolicy'
import type { DirectRequestAuthority } from '../src/modules/identity-access/public/participants'
import type { RealtimeCompositionPolicy } from '../src/modules/runtime-management/public/participants'

const actor = buildActor({
  user: {
    id: 'realtime-user',
    username: 'realtime-user',
    displayName: 'Realtime User',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

const authority = Object.freeze({}) as DirectRequestAuthority

function policy(label: string, calls: string[]): RealtimeCompositionPolicy {
  return {
    resourceVisibility: {
      async canViewResource(receivedActor, type, row) {
        calls.push(`resource:${receivedActor.user.id}:${type}:${row.id}`)
        return label === 'primary'
      },
    },
    memoryVisibility: {
      async canViewMemory(receivedAuthority, receivedActor, scope) {
        expect(receivedAuthority).toBe(authority)
        calls.push(
          `memory:${receivedActor.user.id}:${scope.scopeType}:${scope.scopeId ?? 'global'}`,
        )
        return label === 'primary'
      },
    },
    repoImportOwnerUserId(batchId) {
      calls.push(`repo:${batchId}`)
      return `${label}:${batchId}`
    },
    redactTaskEventPayload(payload, actorSource) {
      calls.push(`redact:${actorSource}`)
      return { label, payload }
    },
  }
}

describe('RFC-349 daemon realtime policy binding', () => {
  test('exposes one frozen closed policy reference before provider composition', () => {
    const binding = createDaemonRealtimePolicyBinding()

    expect(Object.keys(binding).sort()).toEqual(['bind', 'policy'])
    expect(Object.keys(binding.policy).sort()).toEqual([
      'memoryVisibility',
      'redactTaskEventPayload',
      'repoImportOwnerUserId',
      'resourceVisibility',
    ])
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.policy)).toBe(true)
    expect(Object.isFrozen(binding.policy.resourceVisibility)).toBe(true)
    expect(Object.isFrozen(binding.policy.memoryVisibility)).toBe(true)
  })

  test('fails every policy capability closed until the complete policy is bound', async () => {
    const { policy: deferredPolicy } = createDaemonRealtimePolicyBinding()

    await expect(
      deferredPolicy.resourceVisibility.canViewResource(actor, 'workflow', {
        id: 'workflow-1',
        ownerUserId: actor.user.id,
        visibility: 'private',
      }),
    ).rejects.toThrow('daemon-realtime-policy-not-bound')
    await expect(
      deferredPolicy.memoryVisibility.canViewMemory(authority, actor, {
        scopeType: 'global',
        scopeId: null,
      }),
    ).rejects.toThrow('daemon-realtime-policy-not-bound')
    expect(() => deferredPolicy.repoImportOwnerUserId('batch-1')).toThrow(
      'daemon-realtime-policy-not-bound',
    )
    expect(() => deferredPolicy.redactTaskEventPayload({ token: 'secret' }, 'session')).toThrow(
      'daemon-realtime-policy-not-bound',
    )
  })

  test('activates the retained reference once and rejects replacement', async () => {
    const binding = createDaemonRealtimePolicyBinding()
    const retainedPolicy = binding.policy
    const calls: string[] = []

    binding.bind(policy('primary', calls))

    expect(binding.policy).toBe(retainedPolicy)
    await expect(
      retainedPolicy.resourceVisibility.canViewResource(actor, 'workgroup', {
        id: 'workgroup-1',
        ownerUserId: actor.user.id,
        visibility: 'private',
      }),
    ).resolves.toBe(true)
    await expect(
      retainedPolicy.memoryVisibility.canViewMemory(authority, actor, {
        scopeType: 'repo',
        scopeId: 'repo-1',
      }),
    ).resolves.toBe(true)
    expect(retainedPolicy.repoImportOwnerUserId('batch-1')).toBe('primary:batch-1')
    expect(retainedPolicy.redactTaskEventPayload({ token: 'secret' }, 'pat')).toEqual({
      label: 'primary',
      payload: { token: 'secret' },
    })
    expect(calls).toEqual([
      'resource:realtime-user:workgroup:workgroup-1',
      'memory:realtime-user:repo:repo-1',
      'repo:batch-1',
      'redact:pat',
    ])

    expect(() => binding.bind(policy('replacement', []))).toThrow(
      'daemon-realtime-policy-already-bound',
    )
    expect(retainedPolicy.repoImportOwnerUserId('batch-2')).toBe('primary:batch-2')
  })

  test('keeps bindings isolated per daemon session without ambient state', () => {
    const first = createDaemonRealtimePolicyBinding()
    const second = createDaemonRealtimePolicyBinding()

    first.bind(policy('first', []))

    expect(first.policy.repoImportOwnerUserId('batch')).toBe('first:batch')
    expect(() => second.policy.repoImportOwnerUserId('batch')).toThrow(
      'daemon-realtime-policy-not-bound',
    )

    second.bind(policy('second', []))
    expect(second.policy.repoImportOwnerUserId('batch')).toBe('second:batch')
    expect(first.policy.repoImportOwnerUserId('batch')).toBe('first:batch')
  })
})
