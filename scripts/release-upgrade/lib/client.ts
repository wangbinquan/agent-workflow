import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parse as parseYaml } from 'yaml'
import { canonical, normalizeHome, REPO_ROOT, sha256, writeJson } from './io'
import type { Json, ReleaseEntry, Row } from './model'
import type { OldDaemon } from './daemon'
import type { GitFixtureServer } from './git-server'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly response: string,
  ) {
    super(`${method} ${path}: HTTP ${status}: ${response.slice(0, 8000)}`)
  }
}
export function rows(value: Json): Row[] {
  if (Array.isArray(value)) return value as Row[]
  if (value && typeof value === 'object') {
    for (const key of ['items', 'rows', 'tasks', 'memories', 'runs'])
      if (Array.isArray(value[key])) return value[key] as Row[]
  }
  throw new Error(`Expected an API collection, received ${JSON.stringify(value).slice(0, 500)}`)
}
export function id(row: Row): string {
  if (typeof row.id !== 'string')
    throw new Error(`API resource has no id: ${JSON.stringify(row).slice(0, 500)}`)
  return row.id
}
const USER = 'release_upgrade'
const INITIAL_PASSWORD = 'Fixture-only-initial-398!'
const PASSWORD = 'Fixture-only-current-398!'

export class ReleaseClient {
  token: string
  readonly release: ReleaseEntry
  constructor(readonly daemon: OldDaemon) {
    this.token = daemon.token
    this.release = daemon.release
  }
  async request(path: string, method = 'GET', body?: Json): Promise<Json> {
    const response = await fetch(`${this.daemon.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    if (!response.ok) throw new ApiError(response.status, method, path, text)
    if (!text) return null
    try {
      return JSON.parse(text) as Json
    } catch {
      throw new Error(`${method} ${path}: response was not JSON`)
    }
  }
  async create(path: string, body: Row): Promise<Row> {
    return (await this.request(path, 'POST', body)) as Row
  }
  async list(path: string): Promise<Row[]> {
    return rows(await this.request(path))
  }
  async login(password = PASSWORD): Promise<Row> {
    const result = await this.create('/api/auth/login', { username: USER, password })
    if (typeof result.sessionToken !== 'string')
      throw new Error('Old login response lacks sessionToken')
    this.token = result.sessionToken
    return result
  }
  async bootstrap(options: { updateProfile?: boolean } = {}): Promise<void> {
    const capabilities = this.release.runtime.capabilities
    if (capabilities.auth === 'token') return
    const marker = join(this.daemon.home, 'release-upgrade-auth.json')
    if (existsSync(marker)) await this.login()
    else {
      this.token = this.daemon.token
      const body = {
        username: USER,
        displayName: 'Release Upgrade Fixture',
        email: 'release-upgrade@example.invalid',
        password: INITIAL_PASSWORD,
      }
      if (capabilities.auth === 'bootstrap') {
        const status = (await this.request('/api/auth/bootstrap/status')) as Row
        if (status.required === true) await this.create('/api/auth/bootstrap/admin', body)
      } else {
        const users = await this.list('/api/users')
        if (!users.some((user) => user.username === USER))
          await this.create('/api/users', { ...body, role: 'admin' })
      }
      await this.login(INITIAL_PASSWORD)
      await this.request('/api/auth/change-password', 'POST', {
        oldPassword: INITIAL_PASSWORD,
        newPassword: PASSWORD,
      })
      // Some releases revoke all sessions when the password changes.
      await this.login()
      writeJson(marker, { username: USER, fixtureCredentials: true })
    }
    if (capabilities.profile && options.updateProfile !== false)
      await this.request('/api/auth/me/profile', 'PATCH', {
        displayName: 'Release Upgrade Fixture',
        gitName: 'Release Upgrade Fixture',
        email: 'release-upgrade@example.invalid',
      })
  }
  taskBody(workflow: Row, repository: GitFixtureServer, name: string, inputs: Row = {}): Row {
    const caps = this.release.runtime.capabilities
    return {
      workflowId: id(workflow),
      ...(typeof workflow.version === 'number'
        ? { expectedWorkflowVersion: workflow.version }
        : {}),
      name,
      inputs,
      ...(caps.repoUrl
        ? { repoUrl: repository.remoteUrl, ref: 'main' }
        : { repoPath: repository.repository, baseBranch: 'main' }),
    }
  }
  async waitForTask(taskId: string, expected: string, timeoutMs = 180_000): Promise<Row> {
    const deadline = Date.now() + timeoutMs
    let last: Row = {}
    while (Date.now() < deadline) {
      last = (await this.request(`/api/tasks/${taskId}`)) as Row
      if (last.status === expected) return last
      if (['done', 'failed', 'canceled'].includes(String(last.status)))
        throw new Error(`${taskId}: expected ${expected}, got ${canonical(last)}`)
      await Promise.race([
        delay(500),
        this.daemon.exited.then(() => {
          throw new Error(`Old daemon exited waiting for ${taskId}; see ${this.daemon.logPath}`)
        }),
      ])
    }
    const runs = await this.request(`/api/tasks/${taskId}/node-runs`)
    throw new Error(
      `Task ${taskId} timed out waiting for ${expected}: ${canonical({ last, runs })}`,
    )
  }
}

export interface SeedRound {
  round: string
  resources: Record<string, string[]>
  tasks: Record<string, string>
  unavailable: { feature: string; reason: string }[]
}
const BUSINESS_AGENTS: {
  name: string
  outputs: Record<string, string>
  role?: string
  outputWrapperPortNames?: Row
}[] = [
  { name: 'business-fix-engineer', outputs: { fix_summary: 'markdown' } },
  { name: 'business-code-auditor', outputs: { audit_status: 'string', audit_report: 'markdown' } },
  { name: 'business-test-runner', outputs: { test_status: 'string', test_report: 'markdown' } },
  {
    name: 'business-quality-gate',
    outputs: { quality_status: 'string', release_brief: 'markdown' },
  },
  { name: 'business-release-preparer', outputs: { release_brief: 'markdown' } },
  { name: 'business-document-reviewer', outputs: { finding: 'markdown' } },
  {
    name: 'business-compliance-aggregator',
    outputs: { report: 'markdown' },
    role: 'aggregator',
    outputWrapperPortNames: { report: 'compliance_report' },
  },
  { name: 'business-document-publisher', outputs: { documents: 'list<markdown>' } },
  { name: 'business-document-releaser', outputs: { published_paths: 'list<path<md>>' } },
]
const BUSINESS_DIR = join(REPO_ROOT, 'examples/workflows/business')
const FIX_PROMPT =
  'BUSINESS_FIX_IMPLEMENT\nround cents correctly and reject invalid subtotals\nNO_PUSH'

function agentRef(client: ReleaseClient, agent: Row): Row {
  return client.release.runtime.capabilities.agentId
    ? { agentId: id(agent) }
    : { agentName: agent.name! }
}
function smallDefinition(client: ReleaseClient, agent: Row, mode: string): Row {
  const human = mode === 'awaiting_human'
  const review = mode === 'awaiting_review'
  const output = human ? 'design' : 'fix_summary'
  const prompt = human
    ? 'RFC398_AWAIT_HUMAN Design a release upgrade.'
    : mode === 'failed'
      ? 'BUSINESS_FIX_IMPLEMENT RFC398_EXPECTED_FAILURE'
      : `${mode === 'canceled' ? 'RFC398_HOLD_UNTIL_CANCEL\n' : ''}${FIX_PROMPT}`
  const nodes: Row[] = [
    {
      id: 'worker',
      kind: 'agent-single',
      ...agentRef(client, agent),
      promptTemplate: prompt,
      position: { x: 20, y: 20 },
    },
  ]
  const edges: Row[] = []
  let outputNode = 'worker'
  let outputPort = output
  if (review) {
    nodes.push({
      id: 'review',
      kind: 'review',
      title: 'Upgrade pending review',
      inputSource: { nodeId: 'worker', portName: output },
      rerunnableOnReject: [],
      rerunnableOnIterate: [],
      rollbackFilesOnReject: false,
      rollbackFilesOnIterate: false,
      position: { x: 320, y: 20 },
    })
    edges.push({
      id: 'worker-review',
      source: { nodeId: 'worker', portName: output },
      target: { nodeId: 'review', portName: '__review_input__' },
    })
    outputNode = 'review'
    outputPort = 'approved_doc'
  }
  if (human) {
    nodes.push({
      id: 'clarify',
      kind: 'clarify',
      title: 'Upgrade pending questions',
      position: { x: 320, y: 180 },
    })
    edges.push(
      {
        id: 'ask',
        source: { nodeId: 'worker', portName: '__clarify__' },
        target: { nodeId: 'clarify', portName: 'questions' },
      },
      {
        id: 'answer',
        source: { nodeId: 'clarify', portName: 'answers' },
        target: { nodeId: 'worker', portName: '__clarify_response__' },
      },
    )
  }
  nodes.push({
    id: 'output',
    kind: 'output',
    ports: [{ name: 'document', bind: { nodeId: outputNode, portName: outputPort } }],
    position: { x: 640, y: 20 },
  })
  edges.push({
    id: 'result',
    source: { nodeId: outputNode, portName: outputPort },
    target: { nodeId: 'output', portName: 'document' },
  })
  return {
    $schema_version: client.release.runtime.capabilities.workflowSchema,
    inputs: [],
    nodes,
    edges,
  }
}

/** All business rows are created by the old binary's HTTP API. */
export async function seedRound(
  client: ReleaseClient,
  repository: GitFixtureServer,
  round = 'sqlite',
  /** Old-binary defects that make a resource impossible in this round; each is recorded. */
  limits: {
    deferUsers?: string
    /**
     * A declared old-binary task defect: a task state whose creation or settlement fails with
     * exactly this signature is recorded as unavailable with the actual error; any other error
     * still fails seeding.
     */
    knownTaskDefect?: { signature: string; reason: string }
  } = {},
): Promise<SeedRound> {
  await client.bootstrap()
  const caps = client.release.runtime.capabilities
  const seed: SeedRound = { round, resources: {}, tasks: {}, unavailable: [] }
  const remember = (kind: string, row: Row) => {
    ;(seed.resources[kind] ??= []).push(id(row))
    return row
  }
  const unavailable = (feature: string) =>
    seed.unavailable.push({
      feature,
      reason: `${client.release.tag} predates this public API; no row is fabricated`,
    })
  if (caps.auth !== 'token' && limits.deferUsers)
    seed.unavailable.push({ feature: 'users', reason: limits.deferUsers })
  else if (caps.auth !== 'token')
    remember(
      'users',
      await client.create('/api/users', {
        username: `fixture_${round.replaceAll('-', '_')}`,
        displayName: `Fixture ${round}`,
        email: `${round}@example.invalid`,
        role: 'user',
        password: 'Fixture-peer-password-398!',
      }),
    )
  else unavailable('users')
  remember(
    'skills',
    await client.create('/api/skills', {
      name: `release-upgrade-${round}`,
      description: 'Recorded upgrade skill',
      bodyMd: '# Upgrade skill\nPreserve this text and its content digest.\n',
    }),
  )
  if (caps.mcps)
    remember(
      'mcps',
      await client.create('/api/mcps', {
        name: `release-upgrade-${round}`,
        description: 'Disabled fixture endpoint',
        type: 'remote',
        config: { url: `${client.daemon.baseUrl}/fixture-mcp` },
        enabled: false,
      }),
    )
  else unavailable('mcps')
  const existing = await client.list('/api/agents')
  const agents = new Map<string, Row>()
  for (const fixture of BUSINESS_AGENTS) {
    let agent = existing.find((row) => row.name === fixture.name)
    if (!agent)
      agent = await client.create('/api/agents', {
        name: fixture.name,
        description: 'RFC-398 business workflow recording agent',
        bodyMd: 'Use the deterministic business workflow fixture.',
        outputs: Object.keys(fixture.outputs),
        outputKinds: Object.fromEntries(
          Object.entries(fixture.outputs).map(([port, kind]) => [
            port,
            caps.businessWorkflow || !kind.startsWith('list<')
              ? kind
              : kind === 'list<markdown>'
                ? 'markdown'
                : 'string',
          ]),
        ),
        ...(caps.permission ? { permission: {} } : {}),
        ...(caps.readonly ? { readonly: false } : {}),
        ...(fixture.role && caps.businessWorkflow
          ? { role: fixture.role, outputWrapperPortNames: fixture.outputWrapperPortNames! }
          : {}),
      })
    agents.set(fixture.name, remember('agents', agent))
  }
  if (caps.businessWorkflow) {
    for (const file of [
      'defect-fix-controlled-release.yaml',
      'document-batch-compliance-publishing.yaml',
    ]) {
      const sample = parseYaml(readFileSync(join(BUSINESS_DIR, file), 'utf8')) as {
        name: string
        description: string
        definition: Row
      }
      const nodes = (sample.definition.nodes as Row[]).map((node) => {
        if (typeof node.agentName !== 'string') return node
        const agent = agents.get(node.agentName)
        if (!agent) throw new Error(`Missing sample agent: ${node.agentName}`)
        const { agentName: _agentName, ...rest } = node
        return { ...rest, ...agentRef(client, agent) }
      })
      remember(
        'workflows',
        await client.create('/api/workflows', {
          name: `${sample.name}-${round}`,
          description: sample.description,
          definition: { ...sample.definition, nodes },
        }),
      )
    }
  } else
    seed.unavailable.push({
      feature: 'full-business-sample',
      reason:
        'Use the publisher-independent repair node from the business sample; this release predates its fanout/output-kind/nonce contracts.',
    })
  const fix = agents.get('business-fix-engineer')!
  let doneWorkflow: Row | undefined
  for (const state of ['done', 'failed', 'canceled', 'awaiting_review', 'awaiting_human']) {
    if (!caps.nonce && (state === 'awaiting_review' || state === 'awaiting_human')) {
      // RFC-395 conversion refuses to resume a pre-RFC-200 executable run (no envelope nonce,
      // block v2-run-null-nonce) and tells the operator to finish or cancel it first. A pending
      // gate from such a release is therefore never carried across the switch.
      seed.unavailable.push({
        feature: state,
        reason: `${client.release.tag} runs have no envelope nonce; the upgrade refuses pending gates (v2-run-null-nonce) until they are finished or canceled`,
      })
      continue
    }
    if (state === 'awaiting_human' && !caps.clarify) {
      unavailable('awaiting_human')
      continue
    }
    if (state === 'awaiting_human' && !caps.agentId) {
      // RFC-223 quarantines pre-v0.17.0 snapshot agent references (no frozen launch-time id):
      // answering the question re-runs the agent node, which is refused until the task is
      // rebuilt. A pending review (no agent re-run) is still carried and resumed.
      seed.unavailable.push({
        feature: state,
        reason: `${client.release.tag} task snapshots name agents without ids; RFC-223 quarantines them, so a clarify answer cannot re-run the agent after upgrade`,
      })
      continue
    }
    const agent =
      state === 'awaiting_human'
        ? remember(
            'agents',
            await client.create('/api/agents', {
              name: `release-upgrade-designer-${round}`,
              description: 'Pending clarification',
              bodyMd: 'Ask before designing.',
              outputs: ['design'],
              outputKinds: { design: 'markdown' },
              ...(caps.permission ? { permission: {} } : {}),
              ...(caps.readonly ? { readonly: false } : {}),
            }),
          )
        : fix
    const workflow = remember(
      'workflows',
      await client.create('/api/workflows', {
        name: `release-upgrade-${round}-${state}`,
        description: `Old binary task in ${state}`,
        definition: smallDefinition(client, agent, state),
      }),
    )
    const logOffset = existsSync(client.daemon.logPath)
      ? readFileSync(client.daemon.logPath).length
      : 0
    try {
      const task = await client.create(
        '/api/tasks',
        client.taskBody(workflow, repository, `release-upgrade-${round}-${state}`),
      )
      if (state === 'canceled') {
        await client.waitForTask(id(task), 'running')
        await client.request(`/api/tasks/${id(task)}/cancel`, 'POST', {})
      }
      await client.waitForTask(id(task), state)
      seed.tasks[state] = id(task)
      if (state === 'done') doneWorkflow = workflow
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The defect may surface as a task error (message) or as an opaque HTTP 500 whose cause
      // only the old daemon logs; both must carry the declared signature.
      const logged = existsSync(client.daemon.logPath)
        ? readFileSync(client.daemon.logPath).subarray(logOffset).toString('utf8')
        : ''
      if (
        !limits.knownTaskDefect ||
        !(
          message.includes(limits.knownTaskDefect.signature) ||
          (/HTTP 500/.test(message) && logged.includes(limits.knownTaskDefect.signature))
        )
      )
        throw error
      seed.unavailable.push({
        feature: state,
        reason: `${limits.knownTaskDefect.reason}; observed: ${message.slice(0, 600)}`,
      })
    }
  }
  if (caps.schedules && doneWorkflow) {
    const body = client.taskBody(doneWorkflow, repository, `scheduled-${round}`)
    delete body.expectedWorkflowVersion
    remember(
      'schedules',
      await client.create('/api/scheduled-tasks', {
        name: `release-upgrade-${round}`,
        scheduleSpec: { kind: 'interval', every: 30, unit: 'days' },
        enabled: false,
        ...(caps.scheduleEnvelope
          ? { launchKind: 'workflow', launchPayload: body }
          : { workflowId: id(doneWorkflow), launchPayload: body }),
      }),
    )
  } else unavailable('schedules')
  if (caps.workgroups)
    remember(
      'workgroups',
      await client.create('/api/workgroups', {
        name: `release-upgrade-${round}`,
        description: 'Recorded workgroup',
        instructions: 'Preserve release-upgrade evidence.',
        mode: 'leader_worker',
        leaderDisplayName: 'Engineer',
        members: [{ memberType: 'agent', displayName: 'Engineer', ...agentRef(client, fix) }],
        maxRounds: 3,
      }),
    )
  else unavailable('workgroups')
  if (caps.memories) {
    // Every release with memories answers POST /api/memories with `{ memory }` (201).
    const created = await client.create('/api/memories', {
      scopeType: 'global',
      scopeId: null,
      title: `Upgrade memory ${round}`,
      bodyMd: 'The old daemon authored this memory through its API.',
      tags: ['release-upgrade'],
    })
    remember('memories', (created.memory ?? created) as Row)
  } else unavailable('memories')
  return seed
}

export interface ApiProjection {
  formatVersion: 1
  tag: string
  collections: Record<string, Json>
  unavailable: SeedRound['unavailable']
}
const FIELDS: Record<string, string[]> = {
  users: ['id', 'username', 'displayName', 'email', 'role', 'status', 'additionalPermissions'],
  agents: [
    'id',
    'name',
    'description',
    'bodyMd',
    'outputs',
    'outputKinds',
    'permission',
    'ownerUserId',
    'visibility',
  ],
  workflows: ['id', 'name', 'version', 'definition', 'ownerUserId', 'visibility'],
  skills: ['id', 'name', 'description', 'contentVersion', 'ownerUserId', 'visibility'],
  mcps: ['id', 'name', 'type', 'config', 'enabled', 'ownerUserId', 'visibility'],
  schedules: [
    'id',
    'name',
    'enabled',
    'scheduleSpec',
    'launchKind',
    'launchPayload',
    'ownerUserId',
  ],
  workgroups: ['id', 'name', 'mode', 'instructions', 'members', 'leaderMemberId', 'completionGate'],
  memories: ['id', 'scopeType', 'scopeId', 'title', 'bodyMd', 'tags', 'status', 'version'],
  tasks: [
    'id',
    'name',
    'status',
    'ownerUserId',
    'workflowId',
    'workflowVersion',
    'workflowSnapshot',
    'inputs',
    'repoUrl',
    'repoPath',
    'repos',
    'baseBranch',
    'launchKind',
    'subject',
  ],
  runs: [
    'id',
    'taskId',
    'nodeId',
    'status',
    'iteration',
    'retryIndex',
    'shardKey',
    'parentNodeRunId',
    'containerRunId',
  ],
  reviews: ['nodeRunId', 'taskId', 'reviewIteration', 'awaitingReview', 'documents', 'decision'],
  clarify: [
    'id',
    'nodeRunId',
    'askingNodeRunId',
    'intermediaryNodeRunId',
    'taskId',
    'questions',
    'answers',
    'draft',
    'status',
  ],
}
export function projectRows(kind: string, values: Row[], home: string): Json {
  return values
    .map(
      (row) =>
        normalizeHome(
          Object.fromEntries(
            (FIELDS[kind] ?? Object.keys(row))
              .filter((key) => row[key] !== undefined)
              .map((key) => [key, row[key]!]),
          ),
          home,
        ) as Row,
    )
    .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'))
}

/** Stable identity + business fields; timestamps and process observations are excluded. */
export async function captureProjections(
  client: ReleaseClient,
  seeds: SeedRound[],
  sourceRelease: ReleaseEntry = client.release,
): Promise<ApiProjection> {
  const collections: Record<string, Json> = {}
  const caps = sourceRelease.runtime.capabilities
  const api = client.release.runtime.capabilities
  if (caps.auth !== 'token') {
    const account = (await client.request('/api/auth/me')) as Row
    if (account.profile)
      collections.accountProfile = normalizeHome(account.profile, client.daemon.home)
  }
  const paths: [string, string, boolean][] = [
    ['users', '/api/users', caps.auth !== 'token'],
    ['agents', '/api/agents', true],
    ['workflows', '/api/workflows', true],
    ['skills', '/api/skills', true],
    ['mcps', '/api/mcps', caps.mcps],
    ['schedules', '/api/scheduled-tasks', caps.schedules],
    ['workgroups', '/api/workgroups', caps.workgroups],
    ['memories', '/api/memories?include=body', caps.memories],
  ]
  for (const [kind, path, supported] of paths) {
    if (!supported) continue
    const wanted = new Set(seeds.flatMap((seed) => seed.resources[kind] ?? []))
    const listed = (await client.list(path)).filter((row) => wanted.has(id(row)))
    if (listed.length !== wanted.size)
      throw new Error(`Missing seeded ${kind}: expected ${wanted.size}, received ${listed.length}`)
    const values: Row[] = []
    for (const row of listed) {
      if (kind === 'workflows' || kind === 'workgroups') {
        const selector = kind === 'workgroups' && !api.workgroupId ? String(row.name) : id(row)
        values.push((await client.request(`${path}/${encodeURIComponent(selector)}`)) as Row)
      } else values.push(row)
    }
    collections[kind] = projectRows(kind, values, client.daemon.home)
    if (kind === 'skills') {
      const digests: Row[] = []
      for (const row of values) {
        const selector = api.skillId ? id(row) : String(row.name)
        const content = (await client.request(
          `/api/skills/${encodeURIComponent(selector)}/file?path=SKILL.md`,
        )) as Row
        if (typeof content.content !== 'string')
          throw new Error('Skill file response lacks UTF-8 content')
        digests.push({ id: id(row), contentSha256: sha256(content.content) })
      }
      collections.skillContents = digests
    }
  }
  const tasks: Row[] = []
  const nodeRuns: Row[] = []
  const outputs: Json[] = []
  for (const taskId of seeds.flatMap((seed) => Object.values(seed.tasks))) {
    tasks.push((await client.request(`/api/tasks/${taskId}`)) as Row)
    const detail = await client.request(`/api/tasks/${taskId}/node-runs`)
    nodeRuns.push(...rows(detail))
    if (detail && !Array.isArray(detail) && typeof detail === 'object' && detail.outputs)
      outputs.push(...(detail.outputs as Json[]))
  }
  collections.tasks = projectRows('tasks', tasks, client.daemon.home)
  collections.nodeRuns = projectRows('runs', nodeRuns, client.daemon.home)
  collections.nodeOutputs = normalizeHome(
    outputs.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')),
    client.daemon.home,
  )
  const taskIds = new Set(seeds.flatMap((seed) => Object.values(seed.tasks)))
  const reviews = (await client.list('/api/reviews')).filter((row) =>
    taskIds.has(String(row.taskId)),
  )
  collections.reviews = projectRows('reviews', reviews, client.daemon.home)
  const reviewDetails: Json[] = []
  for (const review of reviews)
    if (review.awaitingReview && typeof review.nodeRunId === 'string') {
      const detail = (await client.request(`/api/reviews/${review.nodeRunId}`)) as Row
      // Capabilities are process/user observations, not stored review content.
      const { capabilities: _capabilities, ...stored } = detail
      reviewDetails.push(stored)
    }
  collections.pendingReviews = normalizeHome(reviewDetails, client.daemon.home)
  const requiredReviews = seeds.filter((seed) => seed.tasks.awaiting_review).length
  if (reviewDetails.length < requiredReviews)
    throw new Error(
      `Missing pending review projections: expected at least ${requiredReviews}, found ${reviewDetails.length}`,
    )
  if (caps.clarify) {
    const clarifications = (await client.list('/api/clarify')).filter((row) =>
      taskIds.has(String(row.taskId)),
    )
    collections.clarify = projectRows('clarify', clarifications, client.daemon.home)
    const details: Json[] = []
    for (const question of clarifications) {
      const nodeRunId = question.intermediaryNodeRunId ?? question.nodeRunId
      if (typeof nodeRunId !== 'string')
        throw new Error('Clarification summary lacks its gate node-run identity')
      const detail = (await client.request(`/api/clarify/${nodeRunId}`)) as Row
      const round = (detail.round ?? detail.session ?? detail) as Row
      details.push(projectRows('clarify', [round], client.daemon.home))
    }
    collections.pendingQuestions = normalizeHome(details, client.daemon.home)
    const requiredQuestions = seeds.filter((seed) => seed.tasks.awaiting_human).length
    if (details.length < requiredQuestions)
      throw new Error(
        `Missing pending question projections: expected at least ${requiredQuestions}, found ${details.length}`,
      )
  }
  return {
    formatVersion: 1,
    tag: sourceRelease.tag,
    collections,
    unavailable: seeds.flatMap((seed) => seed.unavailable),
  }
}

/** Candidate uses its own HTTP protocol while inspecting only the source's population. */
export async function continueMigratedTasks(
  client: ReleaseClient,
  seeds: SeedRound[],
): Promise<{ reviews: string[]; questions: string[] }> {
  const result = { reviews: [] as string[], questions: [] as string[] }
  for (const seed of seeds) {
    const reviewTask = seed.tasks.awaiting_review
    if (reviewTask) {
      const review = (await client.list('/api/reviews')).find(
        (row) => row.taskId === reviewTask && row.awaitingReview === true,
      )
      if (
        !review ||
        typeof review.nodeRunId !== 'string' ||
        typeof review.reviewIteration !== 'number'
      )
        throw new Error(`Migrated pending review is missing: ${reviewTask}`)
      await client.request(`/api/reviews/${review.nodeRunId}/decision`, 'POST', {
        decision: 'approved',
        reviewIteration: review.reviewIteration,
      })
      await client.waitForTask(reviewTask, 'done')
      result.reviews.push(reviewTask)
    }
    const questionTask = seed.tasks.awaiting_human
    if (questionTask) {
      const question = (await client.list('/api/clarify')).find(
        (row) => row.taskId === questionTask,
      )
      const gate = question?.intermediaryNodeRunId ?? question?.nodeRunId
      if (typeof gate !== 'string')
        throw new Error(`Migrated pending question is missing: ${questionTask}`)
      const detail = (await client.request(`/api/clarify/${gate}`)) as Row
      const round = (detail.round ?? detail.session ?? detail) as Row
      if (!Array.isArray(round.questions) || !round.questions.length)
        throw new Error(`Migrated questions have no content: ${questionTask}`)
      await client.request(`/api/clarify/${gate}/answers`, 'POST', {
        answers: (round.questions as Row[]).map((item) => ({
          questionId: id(item),
          selectedOptionIndices: Array.isArray(item.options) && item.options.length ? [0] : [],
          customText:
            Array.isArray(item.options) && item.options.length
              ? ''
              : 'Preserve the recorded upgrade data.',
        })),
        ...(typeof round.iteration === 'number' ? { ifMatchIteration: round.iteration } : {}),
        directive: 'stop',
      })
      // Stronger than observing a transient running state: the resumed stub must finish.
      await client.waitForTask(questionTask, 'done')
      result.questions.push(questionTask)
    }
  }
  // Every round must carry a pending review unless the seed recorded why that release cannot
  // (e.g. pre-RFC-200 runs, which RFC-395 refuses to resume by design).
  const explained = seeds.every(
    (seed) =>
      seed.tasks.awaiting_review !== undefined ||
      seed.unavailable.some((item) => item.feature === 'awaiting_review'),
  )
  if (!result.reviews.length && !explained)
    throw new Error('Scenario did not seed any pending reviews')
  return result
}

export async function runNewTask(
  client: ReleaseClient,
  seeds: SeedRound[],
  git: GitFixtureServer,
): Promise<string> {
  const oldTaskId = seeds[0]?.tasks.done
  if (!oldTaskId) throw new Error('Scenario has no completed workflow task')
  const oldTask = (await client.request(`/api/tasks/${oldTaskId}`)) as Row
  if (typeof oldTask.workflowId !== 'string')
    throw new Error('Migrated task lost its workflow identity')
  const workflow = (await client.request(`/api/workflows/${oldTask.workflowId}`)) as Row
  const task = await client.create(
    '/api/tasks',
    client.taskBody(workflow, git, 'candidate-new-task'),
  )
  await client.waitForTask(id(task), 'done')
  return id(task)
}
