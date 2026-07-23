// LOCKS: RFC-218 — port-driven single-agent launch (design §9-5..11, 18-20, 24).
//
//   B1  ported snapshot golden: one input node per declared port
//       (`__agent_input_{i}__`, declaration order), one edge per port, the
//       uniform XML port-envelope promptTemplate; parses + validates with the
//       full production context.
//   B2  zero-port byte-compat: buildAgentHostSnapshot deep-equals the RFC-165
//       legacy literal (AC-2 — the structural guarantee behind rfc165 A1).
//   B3  validateAgentLaunchShape matrix: description XOR inputs per agent
//       shape; unknown keys; missing required; blocker agents; upload ports
//       are multipart-only (design §5.1 + P1-3).
//   B4  startAgentTask ported happy path: task.inputs = port values verbatim
//       (incl. literal `{{...}}` — injected via ports, never re-expanded);
//       frozen snapshot is the ported shape.
//   B5  multipart route (/api/agents/:id/tasks): files land in
//       `.agent-inputs/{port}` and the port value packs newline-joined
//       relative paths — same machinery as POST /api/tasks (shared
//       launchMultipart skeleton). Client-sent text for the upload key is
//       overwritten by the server-written paths (D14).
//   B6  preflight before side effects (design P1-2): a multipart launch that
//       fails the expectedAgentId OCC writes NOTHING under app home.
//   B7  scheduled save gate (design P2-2): ported agent + description payload
//       / upload-port agent → 422 at save; text-port payload saves.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Hono } from 'hono'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StartAgentTaskSchema, WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import {
  AGENT_HOST_AGENT_NODE_ID,
  AGENT_HOST_WORKFLOW_ID,
  buildAgentHostSnapshot,
  startAgentTask,
  validateAgentLaunchShape,
} from '../src/services/agentLaunch'
import { createRuntime } from '../src/services/runtimeRegistry'
import { createScheduledTask } from '../src/services/scheduledTasks'
import { abortAllActiveTasks, isTaskActive } from '../src/services/task'
import { createUser } from '../src/services/users'
import {
  buildWorkflowValidationContext,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const
const VALID_OPENCODE_RUNTIME = 'rfc224-test-opencode'

setDefaultTimeout(30_000)

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: 'do the thing',
  runtime: VALID_OPENCODE_RUNTIME,
}

const PORTS = [
  { name: 'report', kind: 'markdown' },
  { name: 'style_guide', kind: 'string', required: false },
] as const

function daemonActor(): Actor {
  return buildActor({
    user: { id: 'u-admin', username: 'admin', displayName: 'A', role: 'admin', status: 'active' },
    source: 'daemon',
  })
}

let cleanupDirs: string[] = []
let previousAppHome: string | undefined

beforeEach(() => {
  cleanupDirs = []
  previousAppHome = process.env.AGENT_WORKFLOW_HOME
})

afterEach(async () => {
  const taskIds = abortAllActiveTasks('rfc218-cleanup')
  const deadline = Date.now() + 5_000
  while (taskIds.some((id) => isTaskActive(id)) && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  for (const dir of cleanupDirs.reverse()) rmSync(dir, { recursive: true, force: true })
  if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousAppHome
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

async function seedValidOpencodeRuntime(db: DbClient): Promise<void> {
  await createRuntime(db, {
    name: VALID_OPENCODE_RUNTIME,
    protocol: 'opencode',
    model: 'openai/gpt-5.6',
  })
}

describe('B1/B2 — host snapshot shapes', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
  })

  test('B1 ported snapshot: per-port input nodes/edges + envelope template; validates', async () => {
    const ported = await createAgent(db, { ...AGENT_FIELDS, name: 'ported', inputs: [...PORTS] })

    const snap = buildAgentHostSnapshot({ id: ported.id, name: 'ported', inputs: [...PORTS] }, true)
    const def = WorkflowDefinitionSchema.parse(snap)
    expect(def.nodes.map((n) => n.id).sort()).toEqual(
      ['__agent_clarify__', '__agent_input_0__', '__agent_input_1__', '__agent_main__'].sort(),
    )
    const agentNode = def.nodes.find((n) => n.id === AGENT_HOST_AGENT_NODE_ID) as Record<
      string,
      unknown
    >
    expect(agentNode.promptTemplate).toBe(
      [
        'Your task inputs are provided in the XML port blocks below.',
        '',
        '<workflow-input>',
        '<port name="report">',
        '{{report}}',
        '</port>',
        '<port name="style_guide">',
        '{{style_guide}}',
        '</port>',
        '</workflow-input>',
      ].join('\n'),
    )
    // Declared inputs ride the snapshot (wizard + engine share these defs).
    expect(def.inputs.map((i) => i.key)).toEqual(['report', 'style_guide'])
    // Port edges by declaration order + 2 clarify edges.
    const portEdges = def.edges.filter((e) => e.id.startsWith('e_input_'))
    expect(portEdges).toEqual([
      {
        id: 'e_input_0',
        source: { nodeId: '__agent_input_0__', portName: 'report' },
        target: { nodeId: AGENT_HOST_AGENT_NODE_ID, portName: 'report' },
      },
      {
        id: 'e_input_1',
        source: { nodeId: '__agent_input_1__', portName: 'style_guide' },
        target: { nodeId: AGENT_HOST_AGENT_NODE_ID, portName: 'style_guide' },
      },
    ])
    const ctx = await buildWorkflowValidationContext(db)
    expect(validateWorkflowDef(def, ctx).ok).toBe(true)
  })

  test('B2 zero-port agents keep the RFC-165 legacy literal (plus RFC-223 agentId)', () => {
    expect(buildAgentHostSnapshot({ id: 'solo-id', name: 'solo' }, true)).toEqual({
      $schema_version: 4,
      inputs: [
        {
          kind: 'text',
          key: 'description',
          label: 'Task description',
          required: true,
          multiline: true,
        },
      ],
      nodes: [
        { id: '__agent_input__', kind: 'input', inputKey: 'description' },
        {
          id: '__agent_main__',
          kind: 'agent-single',
          agentName: 'solo',
          // RFC-223 (PR-3a): the canonical id is frozen beside the display name.
          agentId: 'solo-id',
          promptTemplate: '{{description}}',
        },
        {
          id: '__agent_clarify__',
          kind: 'clarify',
          sessionMode: 'isolated',
          clarifyMode: 'optional',
        },
      ],
      edges: [
        {
          id: 'e_input_agent',
          source: { nodeId: '__agent_input__', portName: 'description' },
          target: { nodeId: '__agent_main__', portName: 'description' },
        },
        {
          id: 'e___agent_main_____agent_clarify___clarify',
          source: { nodeId: '__agent_main__', portName: '__clarify__' },
          target: { nodeId: '__agent_clarify__', portName: 'questions' },
        },
        {
          id: 'e___agent_main_____agent_clarify___answers',
          source: { nodeId: '__agent_clarify__', portName: 'answers' },
          target: { nodeId: '__agent_main__', portName: '__clarify_response__' },
        },
      ],
    })
  })
})

describe('B3 — validateAgentLaunchShape matrix', () => {
  const TEXT_PORTS = [{ name: 'goal', kind: 'string' }]
  const UPLOAD_PORTS = [{ name: 'doc', kind: 'path<md>' }]

  test('zero-port: inputs rejected, description required', () => {
    expect(() =>
      validateAgentLaunchShape(undefined, { inputs: { a: 'x' } }, { multipart: false }),
    ).toThrow(/declares no input ports/)
    expect(() => validateAgentLaunchShape([], {}, { multipart: false })).toThrow(
      /'description' is required/,
    )
    expect(validateAgentLaunchShape(undefined, { description: 'd' }, { multipart: false })).toBe(
      null,
    )
  })

  test('ported: description rejected, inputs required, unknown keys rejected', () => {
    expect(() =>
      validateAgentLaunchShape(TEXT_PORTS, { description: 'd' }, { multipart: false }),
    ).toThrow(/launch with 'inputs'/)
    expect(() => validateAgentLaunchShape(TEXT_PORTS, {}, { multipart: false })).toThrow(
      /'inputs' is required/,
    )
    expect(() =>
      validateAgentLaunchShape(
        TEXT_PORTS,
        { inputs: { goal: 'x', ghost: 'y' } },
        { multipart: false },
      ),
    ).toThrow(/undeclared port keys/)
  })

  test('ported: required text port must be non-blank; optional may be absent', () => {
    expect(() =>
      validateAgentLaunchShape(TEXT_PORTS, { inputs: { goal: '   ' } }, { multipart: false }),
    ).toThrow(/required input ports are missing/)
    const form = validateAgentLaunchShape(
      [
        { name: 'goal', kind: 'string' },
        { name: 'notes', kind: 'string', required: false },
      ],
      { inputs: { goal: 'ship it' } },
      { multipart: false },
    )
    expect(form?.inputs.map((d) => d.key)).toEqual(['goal', 'notes'])
  })

  test('blockers: signal port / reserved name refuse the launch', () => {
    expect(() =>
      validateAgentLaunchShape(
        [{ name: 'go', kind: 'signal' }],
        { inputs: { go: 'x' } },
        { multipart: false },
      ),
    ).toThrow(/blocked input ports/)
    expect(() =>
      validateAgentLaunchShape(
        [{ name: '__repo_path__', kind: 'string' }],
        { inputs: { __repo_path__: 'x' } },
        { multipart: false },
      ),
    ).toThrow(/blocked input ports/)
  })

  test('upload ports are multipart-only (JSON path forgery closed)', () => {
    expect(() =>
      validateAgentLaunchShape(
        UPLOAD_PORTS,
        { inputs: { doc: '../../etc/passwd' } },
        { multipart: false },
      ),
    ).toThrow(/multipart/)
    // Same payload under multipart passes shape (files themselves are
    // validated by the upload plan; the client string is later overwritten).
    const form = validateAgentLaunchShape(
      UPLOAD_PORTS,
      { inputs: { doc: 'ignored' } },
      { multipart: true },
    )
    expect(form?.inputs[0]?.kind).toBe('upload')
  })
})

describe('B4 — startAgentTask ported happy path (scratch)', () => {
  test('port values land verbatim in task.inputs; snapshot frozen ported', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
    const appHome = makeTempDir('aw-rfc218-b4-')
    const ported = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'ported',
      inputs: [...PORTS],
    })

    const body = StartAgentTaskSchema.parse({
      name: 'port run',
      inputs: { report: 'weekly {{report}} literal', style_guide: 'terse' },
      scratch: true,
    })
    const task = await startAgentTask(db, daemonActor(), ported.id, body, { db, appHome })
    expect(task.workflowId).toBe(AGENT_HOST_WORKFLOW_ID)
    expect(task.sourceAgentName).toBe('ported')
    // Values ride ports verbatim — a literal {{...}} is data, not a template.
    expect(task.inputs.report).toBe('weekly {{report}} literal')
    expect(task.inputs.style_guide).toBe('terse')
    expect(task.inputs.description).toBeUndefined()
    const snapshot = task.workflowSnapshot as { nodes: Array<{ id: string }> }
    expect(snapshot.nodes.some((n) => n.id === '__agent_input_0__')).toBe(true)
  })

  test('zero-port agents still launch exactly as RFC-165 (description port)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
    const appHome = makeTempDir('aw-rfc218-b4z-')
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const task = await startAgentTask(
      db,
      daemonActor(),
      solo.id,
      StartAgentTaskSchema.parse({ name: 't', description: 'fix it', scratch: true }),
      { db, appHome },
    )
    expect(task.inputs.description).toBe('fix it')
  })
})

// --- route-level multipart harness -----------------------------------------

interface Harness {
  db: DbClient
  app: Hono
  home: string
  agentId: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = makeTempDir('aw-rfc218-http-')
  const home = join(tmp, 'home')
  process.env.AGENT_WORKFLOW_HOME = home
  const db = createInMemoryDb(MIGRATIONS)
  await seedValidOpencodeRuntime(db)
  const agent = await createAgent(db, {
    ...AGENT_FIELDS,
    name: 'uploader',
    inputs: [
      { name: 'brief', kind: 'string' },
      { name: 'docs', kind: 'list<path<md>>' },
    ],
  })
  const configPath = join(tmp, 'config.json')
  writeFileSync(configPath, JSON.stringify({ $schema_version: 1 }))
  const app = createApp({
    token: TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app, home, agentId: agent.id }
}

function agentFormData(payload: object, files: Array<[string, string, string]>): FormData {
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const [inputKey, filename, body] of files) {
    fd.append(`files[${inputKey}][]`, new Blob([body]), filename)
  }
  return fd
}

describe('B5/B6 — multipart agent launch route', () => {
  test('B5 files land in .agent-inputs/{port}; port packs newline paths; client text overwritten', async () => {
    const h = await buildHarness()
    const fd = agentFormData(
      {
        name: 'upload run',
        scratch: true,
        inputs: { brief: 'summarize', docs: 'client-forged-path.md' },
      },
      [
        ['docs', 'a.md', '# alpha'],
        ['docs', 'b.md', '# beta'],
      ],
    )
    const res = await h.app.request(`/api/agents/${h.agentId}/tasks`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { worktreePath: string; inputs: Record<string, string> }
    expect(body.inputs.brief).toBe('summarize')
    expect(body.inputs.docs).toBe('.agent-inputs/docs/a.md\n.agent-inputs/docs/b.md')
    expect(readFileSync(join(body.worktreePath, '.agent-inputs/docs/a.md'), 'utf8')).toBe('# alpha')
    expect(existsSync(join(body.worktreePath, '.agent-inputs/docs/b.md'))).toBe(true)
  })

  test('JSON launch for an upload-port agent → 422 (multipart-only)', async () => {
    const h = await buildHarness()
    const res = await h.app.request(`/api/agents/${h.agentId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'forge',
        scratch: true,
        inputs: { brief: 'x', docs: '/etc/passwd' },
      }),
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('agent-launch-invalid')
  })

  test('multipart file bound to an undeclared port → 422 unknown input', async () => {
    const h = await buildHarness()
    const fd = agentFormData({ name: 't', scratch: true, inputs: { brief: 'x' } }, [
      ['ghost', 'a.md', 'x'],
    ])
    const res = await h.app.request(`/api/agents/${h.agentId}/tasks`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-multipart-unknown-input')
  })

  test('B6 preflight OCC failure writes nothing under app home', async () => {
    const h = await buildHarness()
    const before = existsSync(h.home) ? readdirSync(h.home).sort() : null
    const fd = agentFormData(
      {
        name: 'stale',
        scratch: true,
        inputs: { brief: 'x' },
        expectedAgentId: 'not-the-real-id',
      },
      [['docs', 'a.md', '# alpha']],
    )
    const res = await h.app.request(`/api/agents/${h.agentId}/tasks`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(409)
    const after = existsSync(h.home) ? readdirSync(h.home).sort() : null
    expect(after).toEqual(before)
  })
})

describe('B7 — scheduled save gate (design P2-2)', () => {
  let db: DbClient
  let ownerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
    const owner = await createUser(db, {
      username: 'owner',
      displayName: 'O',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    ownerId = owner.id
  })

  function actor(): Actor {
    return buildActor({
      user: { id: ownerId, username: 'owner', displayName: 'O', role: 'admin', status: 'active' },
      source: 'session',
    })
  }

  test('ported agent + description payload → 422 at save', async () => {
    const ported = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'ported',
      inputs: [...PORTS],
    })
    await expect(
      createScheduledTask(
        db,
        {
          name: 's',
          launchKind: 'agent',
          launchPayload: { agentId: ported.id, name: 't', description: 'd', scratch: true },
          scheduleSpec: SPEC,
          enabled: false,
        },
        { actor: actor() },
      ),
    ).rejects.toMatchObject({ code: 'agent-launch-invalid' })
  })

  test('upload-port agent cannot be scheduled (fires are JSON-only)', async () => {
    const pathy = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'pathy',
      inputs: [{ name: 'doc', kind: 'path<md>' }],
    })
    await expect(
      createScheduledTask(
        db,
        {
          name: 's',
          launchKind: 'agent',
          launchPayload: { agentId: pathy.id, name: 't', inputs: { doc: 'x' }, scratch: true },
          scheduleSpec: SPEC,
          enabled: false,
        },
        { actor: actor() },
      ),
    ).rejects.toMatchObject({ code: 'agent-launch-invalid' })
  })

  test('disabled PUT that replaces the payload still validates (impl-gate P2-5)', async () => {
    const ported = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'ported',
      inputs: [...PORTS],
    })
    const created = await createScheduledTask(
      db,
      {
        name: 's',
        launchKind: 'agent',
        launchPayload: {
          agentId: ported.id,
          name: 't',
          inputs: { report: 'weekly' },
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actor() },
    )
    const { updateScheduledTask } = await import('../src/services/scheduledTasks')
    // Result stays disabled — the payload replacement must STILL be shape-
    // checked (description on a ported agent can never fire successfully).
    await expect(
      updateScheduledTask(
        db,
        created.id,
        {
          launchPayload: { agentId: ported.id, name: 't', description: 'd', scratch: true },
        },
        { actor: actor() },
      ),
    ).rejects.toMatchObject({ code: 'agent-launch-invalid' })
  })

  test('text-port payload saves and stamps inputs into the envelope', async () => {
    const ported = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'ported',
      inputs: [...PORTS],
    })
    const created = await createScheduledTask(
      db,
      {
        name: 's',
        launchKind: 'agent',
        launchPayload: {
          agentId: ported.id,
          name: 't',
          inputs: { report: 'weekly' },
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actor() },
    )
    expect((created.launchPayload as { inputs?: Record<string, string> }).inputs).toEqual({
      report: 'weekly',
    })
  })
})
