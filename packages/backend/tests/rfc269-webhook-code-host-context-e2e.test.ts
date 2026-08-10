// RFC-269 regression — exact production chain for the reported race:
// webhook dispatcher -> startExecution -> initial task INSERT -> scheduler ->
// code-host-call. The HTTP peer is local, but no launch/scheduler seam is
// mocked. If trigger context ever returns to a post-launch UPDATE, the node's
// one-time task snapshot sees NULL and this test fails before sending a request.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { CodeHostEvent } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createSecretBox } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { tasks, webhookDeliveries, webhookEndpoints, webhookTriggers } from '../src/db/schema'
import { createCodeHostConnectionsService } from '../src/services/codeHost/connections'
import { watchExecutionTerminal } from '../src/services/execution/executor'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { createWorkflow } from '../src/services/workflow'
import { Paths } from '../src/util/paths'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'aw-rfc269-local-fixture-token' // gitleaks:allow

// Bun 1.3.13 on macOS rejects Bun.serve({port: 0}); use the repository's
// established Node probe pattern to ask the OS for an ephemeral loopback port.
async function allocateLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  })
  if (port === null) throw new Error('failed to allocate loopback port')
  return port
}

test('webhook trigger vars are visible to the first code-host scheduler read', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc269-webhook-code-host-'))
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  const seen: Array<{ path: string; token: string | null }> = []
  const port = await allocateLoopbackPort()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, token: request.headers.get('private-token') })
      return Response.json({ id: 1 }, { status: 201 })
    },
  })

  try {
    const configPath = join(appHome, 'config.json')
    writeFileSync(configPath, JSON.stringify({ $schema_version: 1 }))
    const db = createInMemoryDb(MIGRATIONS)
    const box = createSecretBox(Paths.secretKeyFile)
    createCodeHostConnectionsService({ db, secretBox: box }).upsert('gitlab', {
      baseUrl: `http://127.0.0.1:${server.port}/api/v4`,
      token: TOKEN,
    })

    const owner = await createUser(db, {
      username: 'rfc269-context-owner',
      displayName: 'RFC 269 Context Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const actor = buildActor({
      user: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: owner.role,
        status: owner.status,
      },
      source: 'session',
    })
    const workflow = await createWorkflow(
      db,
      {
        name: 'rfc269-context-call',
        description: '',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [
            {
              id: 'call',
              kind: 'code-host-call',
              provider: 'gitlab',
              action: 'comment.create',
              params: {
                project: '{{trigger.project_id}}',
                mr: '{{trigger.mr_iid}}',
                body: 'context arrived',
              },
            },
          ],
          edges: [],
        } as never,
      },
      { ownerUserId: owner.id, actor },
    )

    await db.insert(webhookEndpoints).values({
      id: 'ep-rfc269-context',
      name: 'RFC 269 context endpoint',
      provider: 'gitlab',
      urlToken: 'aw_whk_rfc269_context',
      secretEnc: box.seal('webhook-secret'),
      enabled: true,
    })
    const endpoint = (
      await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, 'ep-rfc269-context'))
        .limit(1)
    )[0]!
    await db.insert(webhookTriggers).values({
      id: 'tr-rfc269-context',
      name: 'context call',
      endpointId: endpoint.id,
      ownerUserId: owner.id,
      repoScope: JSON.stringify({ kind: 'all' }),
      eventTypes: JSON.stringify(['mr_opened']),
      ignoreUsernames: JSON.stringify([]),
      launchKind: 'workflow',
      launchRefId: workflow.id,
      launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
      autoRegisterRepos: false,
    })

    const event: CodeHostEvent = {
      provider: 'gitlab',
      eventUuid: ulid(),
      eventType: 'mr_opened',
      repoPath: 'platform/api',
      repoHttpUrl: 'https://gitlab.invalid/platform/api.git',
      repoSshUrl: 'git@gitlab.invalid:platform/api.git',
      mrIid: '42',
      projectId: '77',
      author: { username: 'developer' },
      raw: {},
    }
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: endpoint.id,
      eventUuid: event.eventUuid,
      status: 'received',
      eventType: event.eventType,
      repoPath: event.repoPath,
    })

    const dispatcher = createWebhookDispatcher({
      db,
      configPath,
      secretBox: box,
      getDefaultRuntime: async () => null,
    })
    await dispatcher.dispatch({ deliveryId, endpoint, event })

    const task = (
      await db.select().from(tasks).where(eq(tasks.webhookTriggerId, 'tr-rfc269-context')).limit(1)
    )[0]!
    const terminal = await watchExecutionTerminal(db, task.id, { pollMs: 10 })
    expect(terminal).toMatchObject({ kind: 'outcome', outcome: { status: 'done' } })
    expect(seen).toEqual([
      {
        path: '/api/v4/projects/77/merge_requests/42/notes',
        token: TOKEN,
      },
    ])
  } finally {
    server.stop(true)
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(appHome, { recursive: true, force: true })
  }
})
