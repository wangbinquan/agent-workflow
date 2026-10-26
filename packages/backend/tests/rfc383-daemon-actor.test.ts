// RFC-383: preserve caller-specific admission errors while replacing PG's boot-time actor holder.
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as session from '@/auth/session'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { bootDeclaration } from './helpers/daemonProgramSource'
describeEachProvider('RFC-383 per-call daemon admission', (harness) => {
  test('former PG holder survives a failed later admission; daemonActor admits on every call', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc383-actor-'))
    try {
      const f = employeeAutomationFixture(harness, appHome)
      const formerHolder = await f.core.daemonActor('daemon-system-identity-unavailable')
      const admission = spyOn(session, 'admitDaemonIdentity').mockResolvedValue(null)
      try {
        expect(formerHolder.user.id).toBe('__system__')
        await expect(
          f.core.daemonActor('digital-employee-host-identity-not-admitted'),
        ).rejects.toThrow('digital-employee-host-identity-not-admitted')
        await expect(
          f.core.daemonActor('digital-employee-catalog-authority-not-admitted'),
        ).rejects.toThrow('digital-employee-catalog-authority-not-admitted')
        expect(admission).toHaveBeenCalledTimes(2)
      } finally {
        admission.mockRestore()
      }
      expect((await f.core.daemonActor()).user.id).toBe('__system__')
      expect(bootDeclaration('daemon-identity')).toMatchObject({
        providers: ['postgresql'],
        phase: 'prepare',
      })
      expect(bootDeclaration('skill-operation-recovery')).not.toHaveProperty('providers')
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
