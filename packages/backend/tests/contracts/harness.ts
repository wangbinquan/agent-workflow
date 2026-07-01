// RFC-054 W1-2 — shared harness for the API contract suite.
//
// Builds a fully-seeded in-memory app with the daemon token already mapped
// to a `__system__` admin actor (via multiAuth's daemonBuf path), plus a
// minimum set of fixture rows (agent / workflow / task / nodeRun / skill /
// memory / mcp / plugin / user) so happy-path specs in the registry can
// target real ids without each re-seeding.
//
// Shared by:
//   - packages/backend/tests/api-contract.test.ts          (drives the registry)
//   - packages/backend/tests/api-contract-coverage.test.ts (scans + matches)

import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../../src/db/client'
import { createApp } from '../../src/server'
import { createUser } from '../../src/services/users'
import {
  agents,
  mcps,
  memories,
  nodeRuns,
  plugins,
  skills,
  tasks,
  users,
  workflows,
} from '../../src/db/schema'

export const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', '..', 'db', 'migrations')

export interface ContractHarness {
  app: Hono
  db: DbClient
  /** Path-param substitution map for the canonical seeded fixture. */
  fixtures: SeededFixtures
  /** Temp dir set as AGENT_WORKFLOW_HOME-like path. */
  homePath: string
}

export interface SeededFixtures {
  testUsername: string
  testUserId: string
  agentName: string
  skillName: string
  mcpName: string
  pluginName: string
  pluginId: string
  workflowId: string
  taskId: string
  nodeRunId: string
  memoryId: string
}

/** Build a harness with all baseline seeds in place. */
export async function buildContractHarness(): Promise<ContractHarness> {
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const homePath = mkdtempSync(join(tmpdir(), 'aw-contract-'))
  // Pre-seed a minimal config.json so /api/config has something to GET. The
  // path lives under our temp home so PUT /api/config does not splatter the
  // developer's real home.
  writeFileSync(join(homePath, 'config.json'), JSON.stringify({ $schema_version: 1 }), 'utf-8')

  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: join(homePath, 'config.json'),
    opencodeVersion: '1.15.5',
    dbVersion: 28,
    db,
    secretBox,
  })

  // RFC-036 — one real user (id stable for `/api/users/:id` & PAT/identity
  // endpoints). Password matches the auth-routes.test.ts convention.
  await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'correctPassword123',
  })
  const aliceRows = await db.select().from(users)
  const alice = aliceRows.find((u) => u.username === 'alice')
  if (!alice) throw new Error('contract harness: failed to seed alice')

  const agentName = 'contract-agent'
  const skillName = 'contract-skill'
  const mcpName = 'contract-mcp'
  const pluginName = 'contract-plugin'
  const pluginId = ulid()
  const workflowId = ulid()
  const taskId = ulid()
  const nodeRunId = ulid()
  const memoryId = ulid()

  const now = Date.now()
  await db.insert(agents).values({
    id: ulid(),
    name: agentName,
    description: 'contract-suite seed',
    outputs: JSON.stringify(['answer']),
  })
  await db.insert(skills).values({
    id: ulid(),
    name: skillName,
    description: 'contract-suite seed',
    sourceKind: 'managed',
    managedPath: 'skills/contract-skill/files/',
    externalPath: null,
  })
  await db.insert(mcps).values({
    id: ulid(),
    name: mcpName,
    description: 'contract-suite seed',
    type: 'local',
    config: JSON.stringify({ command: ['echo'] }),
    enabled: true,
  })
  await db.insert(plugins).values({
    id: pluginId,
    name: pluginName,
    description: 'contract-suite seed',
    spec: 'fake-plugin@0.0.1',
    optionsJson: '{}',
    sourceKind: 'npm',
    cachedPath: join(homePath, 'plugins', pluginId),
    resolvedVersion: '0.0.1',
    installedAt: now,
    enabled: true,
  })
  await db.insert(workflows).values({
    id: workflowId,
    name: 'contract-workflow',
    description: 'contract-suite seed',
    definition: JSON.stringify({
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentName,
          promptTemplate: '{{topic}}',
          position: { x: 320, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
          position: { x: 640, y: 0 },
        },
      ],
      edges: [],
    }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'contract-task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: homePath,
    worktreePath: join(homePath, 'worktree'),
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: JSON.stringify({ topic: 'hello' }),
    startedAt: now,
    finishedAt: now,
    ownerUserId: alice.id,
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'agent_1',
    status: 'done',
    promptText: 'hello',
  })
  await db.insert(memories).values({
    id: memoryId,
    scopeType: 'global',
    scopeId: null,
    title: 'contract-memory',
    bodyMd: 'a memory for the contract suite',
    status: 'approved',
    sourceKind: 'manual',
    createdAt: now,
  })

  return {
    app,
    db,
    homePath,
    fixtures: {
      testUsername: 'alice',
      testUserId: alice.id,
      agentName,
      skillName,
      mcpName,
      pluginName,
      pluginId,
      workflowId,
      taskId,
      nodeRunId,
      memoryId,
    },
  }
}

/** Substitute `:name` placeholders in a path template against params.
 *
 *  Examples:
 *    fillPath('/api/agents/:name', { name: 'foo' })
 *      → '/api/agents/foo'
 *    fillPath('/api/tasks/:id/node-runs/:nodeRunId', { id: 't', nodeRunId: 'n' })
 *      → '/api/tasks/t/node-runs/n'
 */
export function fillPath(template: string, params: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(params)) {
    out = out.replace(`:${k}`, encodeURIComponent(v))
  }
  return out
}

/** Send a request without auth header. Used for the 401 baseline test. */
export async function reqUnauthorized(app: Hono, method: string, path: string): Promise<Response> {
  return app.request(path, { method })
}

/** Send a request with the daemon token (maps to system admin actor). */
export async function reqAsAdmin(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${DAEMON_TOKEN}`,
    ...(extraHeaders ?? {}),
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json'
    }
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return app.request(path, init)
}
