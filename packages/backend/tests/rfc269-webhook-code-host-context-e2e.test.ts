// RFC-269 regression — exact production chain for the reported race:
// webhook dispatcher -> startExecution -> initial task INSERT -> scheduler ->
// code-host-call. The HTTP peer is local, but no launch/scheduler seam is
// mocked. If trigger context ever returns to a post-launch UPDATE, the node's
// one-time task snapshot sees NULL and this test fails before sending a request.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  WORKFLOW_SCHEMA_VERSION,
  canonicalIntentJson,
  parseIntentChangeset,
  type CodeHostEvent,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createSecretBox } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  intentDrafts,
  intentSessions,
  nodeRuns,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggers,
  workflows,
} from '../src/db/schema'
import { createCodeHostConnectionsService } from '../src/services/codeHost/connections'
import { watchExecutionTerminal } from '../src/services/execution/executor'
import { applyIntentChangeset } from '../src/services/intent/applyChangeset'
import { validateDraftChangeset } from '../src/services/intent/resolveChangeset'
import { createIntentSession } from '../src/services/intent/session'
import { createRuntime } from '../src/services/runtimeRegistry'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { createWorkflow } from '../src/services/workflow'
import { Paths } from '../src/util/paths'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'aw-rfc269-local-fixture-token' // gitleaks:allow
const INTENT_RUNTIME = 'rfc292-intent-opencode'

setDefaultTimeout(20_000)

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.18.3'; exit 0; fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s' "$*" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OPEN='<workflow-output>'; if [[ -n "$NONCE" ]]; then OPEN='<workflow-output nonce="'"$NONCE"'">'; fi
  printf '{"type":"text","timestamp":0,"part":{"type":"text","text":"%s<port name=\\"result\\">done</port></workflow-output>"}}\\n' "$OPEN"
  exit 0
fi
exit 1
`,
  )
  chmodSync(path, 0o755)
  return path
}

function installIntentDraft(
  db: DbClient,
  sessionId: string,
  changeset: unknown,
): { draftRevision: number; draftHash: string } {
  const parsed = parseIntentChangeset(JSON.stringify(changeset))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const report = validateDraftChangeset([], parsed.changeset)
  if (report.errors.length > 0) throw new Error(report.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const draftId = ulid()
  db.insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: draftId, contextManifestJson: '[]' })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftRevision: 1, draftHash }
}

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
          $schema_version: 5,
          inputs: [],
          nodes: [
            {
              id: 'call',
              kind: 'code-host-call',
              provider: 'gitlab',
              action: 'comment.create',
              params: {
                project: '{{trigger.webhook.project_id}}',
                mr: '{{trigger.webhook.mr_iid}}',
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

test('RFC-292 Intent-generated workflow reaches webhook agent prompt without root-input flattening', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc292-intent-webhook-agent-'))
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome

  try {
    const configPath = join(appHome, 'config.json')
    writeFileSync(configPath, JSON.stringify({ $schema_version: 1 }))
    const db = createInMemoryDb(MIGRATIONS)
    await createRuntime(db, {
      name: INTENT_RUNTIME,
      protocol: 'opencode',
      binaryPath: makeStubOpencode(appHome),
      model: 'openai/gpt-5.6',
    })
    const owner = await createUser(db, {
      username: 'rfc292-intent-owner',
      displayName: 'RFC 292 Intent Owner',
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
    const { session } = await createIntentSession(db, actor, {
      message: 'Create a webhook-driven agent workflow.',
    })
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:webhook-worker',
          payload: {
            name: 'rfc292-webhook-worker',
            description: 'Handles webhook comments.',
            outputs: ['result'],
            bodyMd: 'Handle the event.',
            runtime: INTENT_RUNTIME,
          },
        },
        {
          opId: 'op-2',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:webhook-flow',
          payload: {
            name: 'rfc292-intent-webhook-flow',
            description: 'Intent-generated webhook workflow.',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [
                {
                  id: 'worker',
                  kind: 'agent-single',
                  agentRef: '$new:webhook-worker',
                  promptTemplate: 'Webhook comment: {{trigger.webhook.comment_text}}',
                },
              ],
              edges: [],
            },
          },
        },
      ],
    }
    const draft = installIntentDraft(db, session.id, changeset)
    const receipt = await applyIntentChangeset(
      { db, appHome, actor },
      {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      },
    )
    const workflowId = receipt.applied.find((entry) => entry.opId === 'op-2')?.resourceId
    expect(workflowId).toBeString()
    const workflow = (
      await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId ?? ''))
        .limit(1)
    )[0]!
    const definition = JSON.parse(workflow.definition) as {
      inputs: unknown[]
      nodes: Array<{ promptTemplate?: string }>
    }
    expect(definition.inputs).toEqual([])
    expect(definition.nodes[0]?.promptTemplate).toBe(
      'Webhook comment: {{trigger.webhook.comment_text}}',
    )

    const box = createSecretBox(Paths.secretKeyFile)
    await db.insert(webhookEndpoints).values({
      id: 'ep-rfc292-intent-agent',
      name: 'RFC 292 Intent agent endpoint',
      provider: 'gitlab',
      urlToken: 'aw_whk_rfc292_intent_agent',
      secretEnc: box.seal('webhook-secret'),
      enabled: true,
    })
    const endpoint = (
      await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, 'ep-rfc292-intent-agent'))
        .limit(1)
    )[0]!
    await db.insert(webhookTriggers).values({
      id: 'tr-rfc292-intent-agent',
      name: 'Intent agent context',
      endpointId: endpoint.id,
      ownerUserId: owner.id,
      repoScope: JSON.stringify({ kind: 'all' }),
      eventTypes: JSON.stringify(['note']),
      ignoreUsernames: JSON.stringify([]),
      launchKind: 'workflow',
      launchRefId: workflowId!,
      launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
      templateSyntaxVersion: 2,
      autoRegisterRepos: false,
    })

    const event: CodeHostEvent = {
      provider: 'gitlab',
      eventUuid: ulid(),
      eventType: 'note',
      repoPath: 'platform/intent',
      repoHttpUrl: 'https://gitlab.invalid/platform/intent.git',
      repoSshUrl: 'git@gitlab.invalid:platform/intent.git',
      commentText: 'fix-the-trigger-regression',
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
      getDefaultRuntime: async () => INTENT_RUNTIME,
    })
    await dispatcher.dispatch({ deliveryId, endpoint, event })

    const task = (
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.webhookTriggerId, 'tr-rfc292-intent-agent'))
        .limit(1)
    )[0]!
    const terminal = await watchExecutionTerminal(db, task.id, { pollMs: 10 })
    expect(terminal).toMatchObject({ kind: 'outcome', outcome: { status: 'done' } })
    expect(JSON.parse(task.inputs)).toEqual({})
    expect(JSON.parse(task.triggerContextJson!)).toMatchObject({
      trigger: {
        webhook: {
          event_type: 'note',
          comment_text: 'fix-the-trigger-regression',
        },
      },
    })
    expect(JSON.parse(task.triggerContextJson!)).not.toHaveProperty('comment_text')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id)).limit(1))[0]!
    expect(run.promptText).toContain('fix-the-trigger-regression')
    expect(run.promptText).not.toContain('{{trigger.webhook.comment_text}}')
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(appHome, { recursive: true, force: true })
  }
})
