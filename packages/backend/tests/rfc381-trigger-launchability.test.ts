// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-381: both provider roots reject invalid saved triggers with the full 422 contract; dispatch classifies the same failure as launch-failed.
import { expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { CodeHostEvent } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  workflows,
  webhookEndpoints,
  webhookTriggers,
  webhookDeliveries,
  webhookTriggerFires,
} from '@/db/schema'
import { createUser } from './helpers/userFixture'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { integrationBundleFixture } from './helpers/daemonIntegrationBundles'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' }
const emptyDefinition = { $schema_version: 5, inputs: [], nodes: [], edges: [] }
async function workflow(
  db: ProviderNeutralDatabase,
  ownerUserId: string,
  definition: object,
  name = `wf-${ulid()}`,
) {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name,
    definition: JSON.stringify(definition),
    ownerUserId,
    visibility: 'private',
    version: 1,
  })
  return id
}
async function request(app: Hono, token: string, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function schedule(workflowId: string) {
  return {
    name: 'daily',
    launchKind: 'workflow',
    launchPayload: { workflowId, name: 'scheduled run', scratch: true, inputs: {} },
    scheduleSpec: SPEC,
    enabled: true,
  }
}
function trigger(endpointId: string, workflowId: string) {
  return {
    name: 'response',
    endpointId,
    repoScope: { kind: 'prefix', prefix: 'group/' },
    eventTypes: ['pipeline_failed'],
    launchKind: 'workflow',
    launchRefId: workflowId,
    launchPayload: { scratch: true, inputs: {} },
    autoRegisterRepos: false,
  }
}
type ErrorBody = {
  code: string
  message: string
  details: { issues: { code: string; severity?: string }[] }
}

describeEachProviderHttpApplication(
  'RFC-381 shared trigger launchability',
  {
    token: 'v'.repeat(64),
    tempPrefix: 'rfc381-triggers-',
    opencodeVersion: null,
    dbVersion: 1,
  },
  (scope) => {
    async function setup() {
      const db = scope.harness.db
      const user = await createUser(db, {
        username: 'rfc381-user',
        displayName: 'Trigger owner',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const { token } = await createSession({ db, userId: user.id })
      await seedTestDefaultOpencodeRuntime(db)
      const opened = await scope.open()
      const endpointResponse = await request(opened.app, token, '/api/webhook-endpoints', {
        name: 'rfc381 endpoint',
      })
      expect(endpointResponse.status, await endpointResponse.clone().text()).toBe(201)
      const endpointId = ((await endpointResponse.json()) as { id: string }).id
      return { ...opened, db, user, token, endpointId }
    }
    test('schedule and webhook save return 422 workflow-invalid, all errors and warnings', async () => {
      const h = await setup()
      const id = await workflow(h.db, h.user.id, {
        ...emptyDefinition,
        inputs: [{ key: 'unused', kind: 'text', label: 'Unused', required: false }],
        nodes: ['one', 'two'].map((id) => ({
          id,
          kind: 'agent-single',
          agentId: `missing-${id}`,
          agentName: `missing-${id}`,
          promptTemplate: 'work',
        })),
      })
      for (const [path, body] of [
        ['/api/scheduled-tasks', schedule(id)],
        ['/api/webhook-triggers', trigger(h.endpointId, id)],
      ] as const) {
        const response = await request(h.app, h.token, path, body)
        expect(response.status, await response.clone().text()).toBe(422)
        const error = (await response.json()) as ErrorBody
        expect(error.code).toBe('workflow-invalid')
        const errors = error.details.issues.filter(
          (issue) => (issue.severity ?? 'error') === 'error',
        )
        expect(errors.length).toBeGreaterThanOrEqual(2)
        expect(error.message).toContain(`failed static validation (${errors.length} errors)`)
        expect(
          error.details.issues.some(
            (issue) => issue.severity === 'warning' && issue.code === 'input-orphan-declared',
          ),
        ).toBe(true)
      }
    })
    test('schedule and webhook save reject a child workflow with an unwired required input', async () => {
      const h = await setup()
      await workflow(
        h.db,
        h.user.id,
        {
          ...emptyDefinition,
          inputs: [{ key: 'required', kind: 'text', label: 'Required', required: true }],
        },
        'rfc381-child',
      )
      const id = await workflow(h.db, h.user.id, {
        ...emptyDefinition,
        nodes: [{ id: 'child', kind: 'call-workflow', workflowName: 'rfc381-child' }],
      })
      for (const [path, body] of [
        ['/api/scheduled-tasks', schedule(id)],
        ['/api/webhook-triggers', trigger(h.endpointId, id)],
      ] as const) {
        const response = await request(h.app, h.token, path, body)
        expect(response.status, await response.clone().text()).toBe(422)
        const error = (await response.json()) as ErrorBody
        expect(error.code).toBe('workflow-invalid')
        expect(
          error.details.issues.some((issue) => issue.code === 'call-workflow-input-unwired'),
        ).toBe(true)
      }
    })
    test('references to built-in agents remain launchable when saving either trigger kind', async () => {
      const h = await setup()
      const agentId = ulid()
      await h.db.insert(agents).values({
        id: agentId,
        name: 'rfc381-builtin-agent',
        builtin: true,
        visibility: 'public',
        bodyMd: 'test agent',
      })
      const id = await workflow(h.db, h.user.id, {
        ...emptyDefinition,
        nodes: [
          {
            id: 'builtin',
            kind: 'agent-single',
            agentId,
            agentName: 'rfc381-builtin-agent',
            promptTemplate: 'work',
          },
        ],
      })
      for (const [path, body] of [
        ['/api/scheduled-tasks', schedule(id)],
        ['/api/webhook-triggers', trigger(h.endpointId, id)],
      ] as const) {
        const response = await request(h.app, h.token, path, body)
        expect(response.status, await response.clone().text()).toBe(201)
      }
    })
    test('an invalid workflow at delivery is launch-failed and updates the trigger card', async () => {
      const h = await setup()
      const workflowId = await workflow(h.db, h.user.id, {
        ...emptyDefinition,
        nodes: [
          {
            id: 'broken',
            kind: 'agent-single',
            agentId: 'missing',
            agentName: 'missing',
            promptTemplate: 'work',
          },
        ],
      })
      const triggerId = ulid(),
        deliveryId = ulid()
      await h.db.insert(webhookTriggers).values({
        id: triggerId,
        name: 'broken response',
        endpointId: h.endpointId,
        ownerUserId: h.user.id,
        repoScope: JSON.stringify({ kind: 'prefix', prefix: 'group/' }),
        eventTypes: JSON.stringify(['pipeline_failed']),
        ignoreUsernames: '[]',
        launchKind: 'workflow',
        launchRefId: workflowId,
        launchPayload: JSON.stringify({ scratch: true, inputs: {} }),
      })
      const event: CodeHostEvent = {
        provider: 'gitlab',
        eventUuid: ulid(),
        eventType: 'pipeline_failed',
        repoPath: 'group/repo',
        branch: 'main',
        repoHttpUrl: 'https://example.invalid/group/repo.git',
        repoSshUrl: 'git@example.invalid:group/repo.git',
        pipelineStatus: 'failed',
        author: { username: h.user.username },
        raw: {},
      }
      await h.db.insert(webhookDeliveries).values({
        id: deliveryId,
        endpointId: h.endpointId,
        eventUuid: event.eventUuid,
        status: 'received',
        eventType: event.eventType,
        repoPath: event.repoPath,
      })
      const endpoint = (
        await h.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, h.endpointId))
      )[0]!
      const graph = integrationBundleFixture(h.db, h.appHome)
      try {
        await graph.integrationModules.webhookDispatcher.dispatch({ deliveryId, endpoint, event })
        const fires = await h.db
          .select()
          .from(webhookTriggerFires)
          .where(eq(webhookTriggerFires.triggerId, triggerId))
        expect(fires.map((f) => f.outcome)).toEqual(['launch-failed'])
        expect(fires[0]?.error).toContain('failed static validation')
        const card = (
          await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, triggerId))
        )[0]!
        expect(card).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 1 })
        expect(card.lastError).toContain('failed static validation')
      } finally {
        await graph.integrationModules.webhookTerminalControl.stop()
      }
    })
  },
)
