// RFC-370: webhook presentation and admission consume current asynchronous
// configuration. Keep writes before response enrichment and retain read-failure
// fallbacks while using real endpoint persistence on both database providers.
import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeWebhookEndpointServiceDependencies } from '@/modules/integration/composition/webhookEndpoints'
import { composeWebhookTriggerValidation } from '@/modules/integration/composition/webhookAdmission'
import {
  createWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookEndpointSecret,
  rotateWebhookEndpointUrlToken,
  updateWebhookEndpoint,
} from '@/services/webhookEndpoints'
import { createUser } from '@/services/users'
import { describeEachProvider } from './helpers/eachProvider'
import {
  integrationTriggerResourceAuthority,
  scheduledTaskRuntime,
} from './helpers/integrationTriggerResourceBinding'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

describeEachProvider('RFC-370 webhook configuration query', (harness) => {
  const admin = buildActor({
    user: {
      id: 'endpoint-admin',
      username: 'endpoint-admin',
      displayName: 'Endpoint admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })

  test('awaits URL configuration after persistence and reads new values on each response', async () => {
    const entered = barrier()
    const ready = barrier()
    let base = 'https://initial.example/aw/'
    let failed = false
    const deps = composeWebhookEndpointServiceDependencies({
      db: harness.db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
      configuration: {
        async read() {
          entered.release()
          await ready.pending
          if (failed) throw new Error('fixture-config-read-failed')
          return { publicBaseUrl: base }
        },
      },
    })
    const pending = createWebhookEndpoint(deps, admin, { name: 'gitlab', provider: 'gitlab' })
    try {
      await Promise.race([
        entered.pending,
        pending.then(() => {
          throw new Error('response completed before configuration read')
        }),
      ])
      expect(await deps.administration.list()).toHaveLength(1)
    } finally {
      ready.release()
    }
    const created = await pending
    expect(created.ingressUrl).toBe(
      `https://initial.example/aw/webhooks/gitlab/${created.urlToken}`,
    )
    expect(created.secret).toBeString()
    base = 'https://updated.example'
    const expected = `${base}/webhooks/gitlab/${created.urlToken}`
    expect((await getWebhookEndpoint(deps, admin, created.id)).ingressUrl).toBe(expected)
    expect((await listWebhookEndpoints(deps, admin))[0]?.ingressUrl).toBe(expected)
    expect(
      (await updateWebhookEndpoint(deps, admin, created.id, { name: 'renamed' })).ingressUrl,
    ).toBe(expected)
    expect((await rotateWebhookEndpointSecret(deps, admin, created.id)).ingressUrl).toBe(expected)
    const rotated = await rotateWebhookEndpointUrlToken(deps, admin, created.id)
    expect(rotated.urlToken).not.toBe(created.urlToken)
    expect(rotated.ingressUrl).toBe(`${base}/webhooks/gitlab/${rotated.urlToken}`)
    failed = true
    expect((await getWebhookEndpoint(deps, admin, created.id)).ingressUrl).toBeNull()
    const updated = await updateWebhookEndpoint(deps, admin, created.id, { name: 'read-fallback' })
    expect(updated.ingressUrl).toBeNull()
    expect((await deps.administration.get(created.id))?.name).toBe('read-fallback')
  })

  test('trigger validation waits for configuration and keeps the original read-failure fallback', async () => {
    const user = await createUser(harness.db, {
      username: 'webhook-config-owner',
      displayName: 'Webhook configuration owner',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const actor = buildActor({ user, source: 'session' })
    const authority = integrationTriggerResourceAuthority(harness.db, actor)
    const entered = barrier()
    const ready = barrier()
    let failed = false
    let reads = 0
    const validate = composeWebhookTriggerValidation(scheduledTaskRuntime(harness.db).operations, {
      async read() {
        reads += 1
        entered.release()
        await ready.pending
        if (failed) throw new Error('fixture-config-read-failed')
        return { defaultRuntime: 'fixture-runtime' }
      },
    })
    const candidate = {
      launchKind: 'workflow' as const,
      launchRefId: 'unused-invalid-payload',
      launchPayload: null,
      eventTypes: ['push'] as const,
      autoRegisterRepos: false,
    }
    let settled = false
    const pending = validate(actor, authority, candidate).then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    try {
      await entered.pending
      // Let a mistakenly unawaited admission settle its rejection before checking.
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ code: 'webhook-trigger-invalid' })
    failed = true
    await expect(validate(actor, authority, candidate)).rejects.toMatchObject({
      code: 'webhook-trigger-invalid',
    })
    expect(reads).toBe(2)
  })
})
