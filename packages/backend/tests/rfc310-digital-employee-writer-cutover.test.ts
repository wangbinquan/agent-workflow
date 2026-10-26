import { assertFixedWriterInstallation } from './helpers/model/writerInstallation'
// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
import { expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { composeDigitalEmployeeWriterCutoverFor } from '@/modules/digital-employee/composition'

// RFC-395: the installation supplies a fixed writer view; no database drain scan remains.
// Both provider compositions must require the binding and expose the same installed contract.

describeEachProvider('RFC-310 Digital Employee OS single-writer cutover', (harness) => {
  test('writer installation must be bound explicitly and is stable across reads', async () => {
    await expect(composeDigitalEmployeeWriterCutoverFor(harness.db).read()).rejects.toThrow(
      'digital-employee-writer-installation-unbound',
    )
    await assertFixedWriterInstallation(harness.db, 10_000)
  })
})

// The HTTP composition consumes the installed writer binding before mounting routes.
describeEachProviderHttpApplication(
  'RFC-310 Digital Employee OS single-writer cutover',
  {
    token: 'a'.repeat(64),
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'rfc310-writer-route-',
  },
  (scope) => {
    test('HTTP refuses new legacy Missions after cutover while exposing the drain report', async () => {
      const [{ createSession }, { createUser }] = await Promise.all([
        import('./helpers/auth/sessionStore'),
        import('./helpers/userFixture'),
      ])
      const db = scope.harness.db
      const app = (await scope.open()).app
      const admin = await createUser(db, {
        username: 'writer-admin',
        displayName: 'Writer Admin',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const session = await createSession({ db, userId: admin.id })
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      }

      const launch = await app.request('/api/code/missions', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
      expect(launch.status).toBe(409)
      expect(await launch.json()).toMatchObject({ code: 'legacy-mission-admission-retired' })

      const status = await app.request('/api/digital-employees/migration-status', { headers })
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        writer: { mode: 'os-active', legacyAdmissionsEnabled: false },
        draining: [],
      })
    })
  },
)
