// RFC-370 V9 / RFC-394: deployment provider requirements precede database opening and owner composition.
import { expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { composeStandaloneProfile } from '@/bootstrap/standalone'
import { composeDaemonSession } from '@/bootstrap/daemonSession'
import type { DaemonProviderSessionComposeInput } from '@/bootstrap/daemonSessionInput'
import { DAEMON_SESSION_ADAPTERS } from '@/bootstrap/daemonSessionAdapters'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'

for (const provider of ['sqlite', 'postgresql'] as const)
  for (const requiredProvider of [null, 'postgresql'] as const)
    test(`session admission: ${requiredProvider ?? 'standalone'} on ${provider}`, async () => {
      const reachedOpen = new Error('database-open-boundary')
      const open = spyOn(DAEMON_SESSION_ADAPTERS[provider], 'open').mockImplementation(() => {
        throw reachedOpen
      })
      const input = {
        provider: { provider },
        requiredProvider,
      } as DaemonProviderSessionComposeInput
      try {
        await expect(composeDaemonSession(input)).rejects.toThrow(
          requiredProvider !== null && requiredProvider !== provider
            ? 'hosted-deployment-requires-postgresql'
            : reachedOpen.message,
        )
        expect(open).toHaveBeenCalledTimes(
          requiredProvider !== null && requiredProvider !== provider ? 0 : 1,
        )
      } finally {
        open.mockRestore()
      }
    })

describeEachProvider('RFC-394 direct application admission', (harness) => {
  for (const requiredProvider of [
    composeStandaloneProfile().requiredProvider,
    'postgresql' as DatabaseProvider,
  ])
    test('required provider ' + requiredProvider, async () => {
      const create = () =>
        createProviderHttpApplication(harness, { token: 'rfc394', dbVersion: 1, requiredProvider })
      if (requiredProvider !== null && requiredProvider !== harness.applicationBinding.provider) {
        await expect(create()).rejects.toThrow('hosted-deployment-requires-postgresql')
      } else {
        const application = await create()
        try {
          expect(application.core.provider).toBe(harness.applicationBinding.provider)
        } finally {
          await application.dispose()
        }
      }
    })
  test('standalone permits a selected runtime inventory on either provider', async () => {
    const application = await createProviderHttpApplication(harness, {
      token: 'rfc394',
      dbVersion: 1,
      requiredProvider: null,
      runtimeInventoryContent: { readLive: async () => null },
    })
    await application.dispose()
  })
})
test('the direct graph checks its requirement before composing any owner', () => {
  const text = readFileSync(
    new URL('../src/bootstrap/daemonApplication.ts', import.meta.url),
    'utf8',
  )
  const admission = text.indexOf('input.requiredProvider !== null')
  expect(admission).toBeGreaterThan(0)
  expect(admission).toBeLessThan(text.indexOf('const developmentPurposeRoot ='))
})
