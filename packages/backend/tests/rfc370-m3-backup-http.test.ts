// Hosted backup reads use the same authenticated operation boundary as backup
// creation, while verification never invokes the live database restore path.
// RFC-370 v3 V5: the hosted refusal of workspace capture (C10) surfaces with its
// own translated code through the operation boundary.
import { registerProviderHttpApplicationLifetime } from './helpers/providerHttpApplication'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeSystemOperationsWithRecoveryAdapter } from '@/modules/system-operations/composition'
import { createStandbyExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/standbyExecutionAuthority'
import { HostedBackupWorktreesUnsupportedError } from '@/modules/system-operations/infrastructure/crewstation/databaseBackups'
import { createUser } from '@/services/users'
import { createSession } from './helpers/auth/sessionStore'

const openTestApplication = registerProviderHttpApplicationLifetime()

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
async function setup(standby = false) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-backup-http-'))
  cleanup.push(() => rmSync(appHome, { recursive: true, force: true }))
  const db = createInMemoryDb(resolve(import.meta.dirname, '../db/migrations'))
  const backupId = crypto.randomUUID()
  const calls: unknown[] = []
  const unused = (): never => {
    throw new Error('live restore must not be invoked')
  }
  const systemOperations = composeSystemOperationsWithRecoveryAdapter({
    appHome,
    adapter: {
      backup: {
        async request(input) {
          calls.push(input)
          if (input.includeWorktrees) throw new HostedBackupWorktreesUnsupportedError()
          return {
            path: 'object-reference',
            sizeBytes: 1,
            contents: { db: true, config: true, workflows: 1, skills: 0 },
          }
        },
        catalog: {
          async list() {
            calls.push('list')
            return { backups: [], hasMore: false }
          },
          async verify(id) {
            calls.push(id)
            return {
              backupId: id,
              verifiedAt: 1,
              reference: 'object-reference',
              schemaDigest: `sha256:${'a'.repeat(64)}`,
              sourceGenerationId: 'dbg_hosted',
              sizeBytes: 1,
              workflows: 1,
              skills: 0,
            }
          },
        },
      },
      restore: {
        plan: unused,
        stage: unused,
        cancel: unused,
        status: unused,
        activateLocal: unused,
      },
    },
  })
  const app = (
    await openTestApplication(
      { provider: 'sqlite', db: db },
      {
        token: 'daemon-backup',
        configPath: join(appHome, 'config.json'),
        dbVersion: 1,
        opencodeVersion: '1.14.25',
        secretBox: createSecretBoxFromKey(Buffer.alloc(32, 7)),
        systemOperations,
        ...(standby
          ? {
              executionAuthority: createStandbyExecutionAuthority({
                reason: 'lease-held-elsewhere',
              }),
            }
          : {}),
      },
    )
  ).app
  const user = await createUser(db, {
    username: 'viewer',
    displayName: 'Viewer',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const session = await createSession({ db, userId: user.id })
  const request = (path: string, method = 'GET', body?: string, token = 'daemon-backup') =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
    )
  return { calls, backupId, request, userToken: session.token }
}

test('catalog and full verification require backup permission and a valid backup identity', async () => {
  const f = await setup()
  expect((await f.request('/api/backup', 'GET', undefined, f.userToken)).status).toBe(403)
  expect(
    (await f.request(`/api/backup/${f.backupId}/verify`, 'POST', '{}', f.userToken)).status,
  ).toBe(403)
  expect(f.calls).toEqual([])
  expect((await f.request('/api/backup')).status).toBe(200)
  const verified = await f.request(`/api/backup/${f.backupId}/verify`, 'POST', '{}')
  expect(verified.status).toBe(200)
  expect(await verified.json()).toMatchObject({
    backupId: f.backupId,
    reference: 'object-reference',
  })
  expect((await f.request('/api/backup/not-an-id/verify', 'POST', '{}')).status).toBe(422)
  expect(f.calls).toEqual(['list', f.backupId])
})

test('standby permits readonly backup inspection but cannot start a new backup', async () => {
  const f = await setup(true)
  expect((await f.request('/api/backup')).status).toBe(200)
  expect((await f.request(`/api/backup/${f.backupId}/verify`, 'POST', '{}')).status).toBe(200)
  expect((await f.request('/api/backup', 'POST', '{}')).status).toBe(503)
  expect(f.calls).toEqual(['list', f.backupId])
})

test('creation preserves the empty-body contract and refuses hosted workspace capture with its code', async () => {
  const f = await setup()
  expect((await f.request('/api/backup', 'POST')).status).toBe(200)
  const refused = await f.request('/api/backup', 'POST', '{"includeWorktrees":true}')
  expect(refused.status).toBe(422)
  expect(await refused.json()).toMatchObject({ code: 'hosted-backup-worktrees-unsupported' })
  expect((await f.request('/api/backup', 'POST', '{"includeWorktrees":"yes"}')).status).toBe(422)
  expect(f.calls).toEqual([{ includeWorktrees: false }, { includeWorktrees: true }])
})
