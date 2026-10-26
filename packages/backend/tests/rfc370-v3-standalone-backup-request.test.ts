// RFC-370 v3 review finding: the hosted backup work made the shared
// `POST /api/backup` parse its body strictly and honour `includeWorktrees` for
// every deployment. Standalone never read that body (an HTTP-requested backup
// never captures worktrees — only the scheduled one does), so API clients that
// send any body, or none, would have started failing or capturing worktrees.
// This locks the standalone contract exactly as before; the hosted decode (with
// its C10 refusal) is covered by `rfc370-m3-backup-http.test.ts`.
import { registerProviderHttpApplicationLifetime } from './helpers/providerHttpApplication'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createInMemoryDb } from '@/db/client'
import { composeSystemOperationsWithRecoveryAdapter } from '@/modules/system-operations/composition'

const openTestApplication = registerProviderHttpApplicationLifetime()

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

test('a standalone HTTP backup never reads its body and never captures worktrees', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-standalone-backup-'))
  cleanup.push(() => rmSync(appHome, { recursive: true, force: true }))
  const calls: unknown[] = []
  const unused = (): never => {
    throw new Error('restore must not be invoked')
  }
  const app = (
    await openTestApplication(
      {
        provider: 'sqlite',
        db: createInMemoryDb(),
      },
      {
        token: 'daemon-backup',
        configPath: join(appHome, 'config.json'),
        dbVersion: 1,
        opencodeVersion: '1.14.25',
        secretBox: createSecretBoxFromKey(Buffer.alloc(32, 9)),
        systemOperations: composeSystemOperationsWithRecoveryAdapter({
          appHome,
          adapter: {
            backup: {
              async request(input) {
                calls.push(input)
                return {
                  path: join(appHome, 'backup.tar.gz'),
                  sizeBytes: 1,
                  contents: { db: true, config: true, workflows: 0, skills: 0 },
                }
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
        }),
      },
    )
  ).app
  const post = (body?: string) =>
    app.fetch(
      new Request('http://localhost/api/backup', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer daemon-backup',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      }),
    )
  const bodies = [
    undefined,
    '{}',
    '{"includeWorktrees":true}',
    '{"includeWorktrees":"yes"}',
    '{"unexpected":1}',
    'not json',
  ]
  for (const body of bodies) expect((await post(body)).status).toBe(200)
  expect(calls).toEqual(bodies.map(() => ({ includeWorktrees: false })))
  // Standalone has no hosted backup catalog.
  const catalog = await app.fetch(
    new Request('http://localhost/api/backup', {
      headers: { Authorization: 'Bearer daemon-backup' },
    }),
  )
  expect(catalog.status).not.toBe(200)
})
