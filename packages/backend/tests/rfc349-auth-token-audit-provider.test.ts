// RFC-349 — token-call audit is a closed AUTH participant. Transports receive
// one Promise surface; the persistence is one provider-neutral implementation
// (RFC-359 W4-D9), exercised on both engines by rfc359-w4-d9-adapters.test.ts.

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
}

function patActor() {
  return buildActor({
    source: 'pat',
    patId: 'pat-rfc349-audit',
    patScopes: [],
    user: {
      id: 'audit-user',
      username: 'audit-user',
      displayName: 'Audit User',
      role: 'admin',
      status: 'active',
    },
  })
}

describeEachProviderHttpApplication(
  'RFC-349 token-call audit provider participant',
  {
    token: 'rfc349-audit-token',
    tempPrefix: 'rfc349-core-audit-',
    dbVersion: 1,
    opencodeVersion: null,
  },
  (scope) => {
    test('the legacy facade and its bridge are gone; application contract has no provider handle', () => {
      // RFC-440: every production caller already used the provider-assembled participant, so
      // the `services/tokenAudit` facade and the `legacyTokenCallAudit` bridge behind it were
      // deleted; the delete snapshot it also carried moved to platform/http/deleteSnapshot.ts.
      expect(existsSync(resolve(import.meta.dir, '..', 'src/services/tokenAudit.ts'))).toBe(false)
      expect(source('src/auth/composition.ts')).not.toContain('legacyTokenCallAudit')
      const application = source('src/auth/application/tokenCallAudit.ts')
      const server = source('src/bootstrap/daemonHttpComposition.ts')
      expect(server).toContain('core.tokenCallAudit.listForUser(userId)')
      expect(server).toContain('core.tokenCallAudit.list()')
      expect(application).not.toContain('DbClient')
      expect(application).not.toContain('PostgresqlDatabaseClient')
      expect(application).not.toContain("from '@/db/")
      expect(application).toContain('export interface TokenCallAuditParticipant')
    })

    test('the core participant preserves attribution, snapshot redaction and bounded retention', async () => {
      const audit = (await scope.open()).tokenCallAudit
      const id = await audit.record(
        {
          actor: patActor(),
          channel: 'mcp',
          toolName: 'resource_write',
          resourceKind: 'mcps',
          resourceId: 'mcp-1',
          statusCode: 204,
          deletedSnapshot: {
            id: 'mcp-1',
            config: { env: { API_KEY: 'must-not-survive' } },
          },
        },
        10,
      )

      expect(id).not.toBeNull()
      await expect(audit.listForUser('audit-user')).resolves.toMatchObject([
        {
          id,
          patId: 'pat-rfc349-audit',
          userId: 'audit-user',
          channel: 'mcp',
          toolName: 'resource_write',
        },
      ])
      await expect(
        audit.pruneSlice(1, { version: 1, phase: 'snapshots', cutoff: 11 }, 20, 10),
      ).resolves.toMatchObject({
        done: false,
        cursor: { phase: 'audits', cutoff: 11 },
        counters: { snapshots: 1 },
      })
      await expect(
        audit.pruneSlice(1, { version: 1, phase: 'audits', cutoff: 11 }, 20, 10),
      ).resolves.toMatchObject({ done: true, counters: { audits: 1 } })
    })

    // RFC-359 W4-D9：PostgreSQL 的真实执行由 rfc359-w4-d9-adapters.test.ts 的双引擎用例覆盖（两个 provider 同一份实现）。

    test('maintenance invokes the selected AUTH participant without a DB fallback', () => {
      const runner = source('src/auth/application/maintenanceJobs.ts')
      expect(source('src/bootstrap/maintenanceJobBindings.ts')).toContain(
        'createTokenAuditMaintenanceJobHandlers(commands.tokenAudit)',
      )
      expect(runner).toContain('tokenAudit.pruneSlice(payload.retentionDays, input.cursor)')
      expect(runner).not.toContain("from '@/services/tokenAudit'")
      expect(runner).not.toContain('pruneTokenAuditSlice(db')
    })
  },
)
