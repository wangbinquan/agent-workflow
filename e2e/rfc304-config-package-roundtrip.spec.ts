// RFC-304 T17a / §两层配置 — a department's template travels to another
// instance and RUNS there.
//
// The promise is that the department's script framework and the group's binding
// move between instances as an RFC-271 config package. Proving the rows arrived
// is not proving the promise: what a receiving team needs is that the imported
// template WORKS, and the way it silently does not is that the scripts arrive
// empty — a framework whose `scripts` came through as `{}` looks perfectly fine
// in a list, and fails at round time with "the framework's scripts could not be
// resolved". (That exact bug existed in the serializer's first draft, from
// reading `row.scripts` when the column is `scripts_json`.)
//
// So this drives the whole trip: export from daemon A, import into daemon B,
// point a repository at the IMPORTED binding, and make a red pipeline go green
// using scripts that arrived in a zip.

import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

const PROJECT_PATH = 'system-e2e/rfc304-pkg'
const FIXER_AGENT = 'e2e-pkg-fixer'
const REVIEWER_AGENT = 'e2e-pkg-reviewer'

/** The repository's gate: green only once `src/broken.txt` says `fixed`. */
const GATE_SCRIPT = [
  "const fs = require('node:fs')",
  "const state = fs.readFileSync('src/broken.txt', 'utf8').trim()",
  "if (state !== 'fixed') { console.error('gate: red because ' + state); process.exit(1) }",
  "console.log('gate: all checks passed')",
].join('\n')
const GATE_DOC = ['# Contributing', '', 'Run `node gate.js` before you push.', ''].join('\n')

/** A node script emitting one envelope port, the way a framework author writes it. */
function emitPort(port: string, value: unknown): string {
  return [
    'const nonce = process.env.AW_ENVELOPE_NONCE',
    `const body = ${JSON.stringify(JSON.stringify(value))}`,
    'console.log(`<workflow-output nonce="${nonce}">`)',
    `console.log('<port name="${port}">' + body + '</port>')`,
    "console.log('</workflow-output>')",
  ].join('\n')
}

let source: DaemonHandle
let dest: DaemonHandle
let mocks: SystemMockClient
let endpoint: { urlToken: string; secret: string }
let project: { projectId: string; repoHttpUrl: string; number: number; headSha: string }
let packageZip: Buffer = Buffer.alloc(0)
let importedBindingId = ''
/** The commit must present the token its own preview issued — see test 2. */
let previewToken = ''
let previewEntries: Array<{
  localSlug: string
  suggestedName: string
  defaultAction: string | null
  candidates: Array<{ id: string }>
}> = []

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // NOT `mocks.reset()` — one mock suite serves every worker; isolation is the
  // unique project path.

  const stateDir = mkdtempSync(join(tmpdir(), 'rfc304-pkg-'))
  const planFile = join(stateDir, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      agents: {
        [REVIEWER_AGENT]: [{ output: { findings: JSON.stringify({ findings: [] }) } }],
        [FIXER_AGENT]: [
          {
            writeFiles: { 'src/broken.txt': 'fixed\n' },
            output: {
              fix: JSON.stringify({
                summary: 'Marked the build fixed.',
                touched: ['src/broken.txt'],
              }),
            },
          },
        ],
      },
    }),
  )

  source = await startDaemon({ stubMode: 'runtime-scenario' })
  dest = await startDaemon({
    stubMode: 'runtime-scenario',
    extraEnv: { SCENARIO_PLAN_FILE: planFile, SCENARIO_STATE_DIR: stateDir },
  })

  // The receiving team's own agents, created BEFORE the package is previewed:
  // the preview computes each entry's default action against what this instance
  // already has, so an instance that acquires them afterwards would be answered
  // with a stale plan (and a name collision).
  for (const [name, outputs, readonly] of [
    [FIXER_AGENT, ['fix'], false],
    [REVIEWER_AGENT, ['findings'], true],
  ] as const) {
    await api(dest, '/api/agents', {
      method: 'POST',
      body: {
        name,
        description: 'destination-side agent',
        outputs: [...outputs],
        readonly,
        bodyMd: 'Do the work.',
      },
    })
  }

  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    baseFiles: { 'gate.js': GATE_SCRIPT, 'CLAUDE.md': GATE_DOC, 'src/broken.txt': 'red\n' },
    headFiles: {
      'gate.js': GATE_SCRIPT,
      'CLAUDE.md': GATE_DOC,
      'src/broken.txt': 'red\n',
      'src/change.ts': 'export const changed = true\n',
    },
  })
})

test.afterAll(async () => {
  if (source !== undefined) await source.stop()
  if (dest !== undefined) await dest.stop()
})

test('a department exports its framework and binding as one package', async () => {
  // The producer that did not exist: the bundle has carried these two types
  // since T17a and there was no route to make one.
  const agent = await api(source, '/api/agents', {
    method: 'POST',
    body: {
      name: FIXER_AGENT,
      description: 'source-side fixer',
      outputs: ['fix'],
      readonly: false,
      bodyMd: 'Fix it.',
    },
  })

  const framework = await api<{ id: string }>(source, '/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'department ci-fix template',
      capability: 'ci-fix',
      scripts: {
        collect: {
          language: 'node',
          script: emitPort('collect', {
            conflict: false,
            unresolvedComments: [],
            gate: { status: 'fail' },
            headSha: project.headSha,
          }),
        },
        classify: {
          language: 'node',
          script: emitPort('classify', [
            { type: 'test-failure', file: 'src/broken.txt', message: 'the build check is red' },
          ]),
        },
        arbitrate: {
          language: 'node',
          script: emitPort('arbitrate', [
            { capability: 'ci-fix', items: [{ issueRef: 'test-failure:src/broken.txt' }] },
          ]),
        },
        select: {
          language: 'node',
          script: emitPort('select', { bySlot: { 'ci-fixer': { agent: FIXER_AGENT } } }),
        },
      },
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
    },
  })

  const binding = await api<{ id: string }>(source, '/api/capability-templates', {
    method: 'POST',
    body: {
      name: 'department binding',
      frameworkId: framework.id,
      agentBySlot: { 'ci-fixer': (agent as { id: string }).id },
      promptBySlot: {},
      params: {},
    },
  })

  const res = await fetch(
    `${source.baseUrl}/api/capability-templates/${binding.id}/export-package`,
    {
      headers: { authorization: `Bearer ${source.token}` },
    },
  )
  expect(res.status, await res.clone().text()).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/zip')
  packageZip = Buffer.from(await res.arrayBuffer())
  expect(packageZip.byteLength).toBeGreaterThan(0)
})

test('the receiving instance previews BOTH layers before writing anything', async () => {
  // The operator sees what is about to be written. A binding arriving without
  // its framework would import a template the destination does not have — the
  // closure is what prevents that, and the preview is where it becomes visible.
  const form = new FormData()
  form.append('file', new Blob([packageZip]), 'template.awpkg.zip')
  const res = await fetch(`${dest.baseUrl}/api/resource-packages/preview`, {
    method: 'POST',
    headers: { authorization: `Bearer ${dest.token}` },
    body: form,
  })
  const text = await res.text()
  expect(res.status, text).toBe(200)
  expect(text).toContain('capability_template')
  expect(text).toContain('capability_template')
  const preview = JSON.parse(text) as {
    previewToken: string
    entries: typeof previewEntries
  }
  previewToken = preview.previewToken
  previewEntries = preview.entries
  expect(previewToken).toBeTruthy()
  // Both layers are listed for the operator BEFORE anything is written — that
  // listing is also what the commit answers entry by entry.
  expect(previewEntries.length).toBeGreaterThanOrEqual(2)
})

test('importing it writes both rows, and the agent slot binds to THIS instance', async () => {
  // The destination already had its own agents before the package arrived (set
  // up in `beforeAll`) — that is the situation the two-layer design is for, and
  // it is why the preview's default for those entries is `reuse` rather than a
  // name collision.
  const form = new FormData()
  form.append('file', new Blob([packageZip]), 'template.awpkg.zip')
  // The commit presents the token its own preview issued: the operator commits
  // exactly what they were shown, not whatever the file happens to contain now.
  form.set('previewToken', previewToken)
  // One decision per entry: nothing is written that the operator did not answer
  // for. Taking everything as `new` here is the ordinary "this instance has
  // never seen this template" case.
  // One decision per entry, taking the server's own safe default. That is the
  // operator's path and it is what makes the agent slot land on the LOCAL
  // agent: the closure carried the source's agent too, the destination already
  // has one by that name, and the preview's default for it is `reuse`. Forcing
  // `new` everywhere collides on the name — which is the honest refusal, not a
  // bug.
  form.set(
    'decisions',
    JSON.stringify(
      previewEntries.map((entry) => {
        const action = entry.defaultAction ?? 'new'
        return {
          localSlug: entry.localSlug,
          action,
          ...(action === 'new' ? { finalName: entry.suggestedName } : {}),
          ...(action !== 'new' && entry.candidates[0] !== undefined
            ? { targetId: entry.candidates[0].id }
            : {}),
        }
      }),
    ),
  )
  const res = await fetch(`${dest.baseUrl}/api/resource-packages/commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${dest.token}` },
    body: form,
  })
  const text = await res.text()
  expect(res.status, text).toBe(200)

  const bindings = await api<
    { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>
  >(dest, '/api/capability-templates')
  const rows = Array.isArray(bindings) ? bindings : (bindings.items ?? [])
  const imported = rows.find((b) => b.name === 'department binding')
  expect(imported, `binding did not arrive: ${JSON.stringify(rows).slice(0, 300)}`).toBeDefined()
  importedBindingId = imported?.id ?? ''
})

test('the IMPORTED template drives a real round — scripts and all', async () => {
  // The promise, end to end. The failure this rules out is the quiet one: a
  // framework whose scripts arrived as `{}` looks fine in a list and dies at
  // round time. Here the four script stages must run, and the gate they lead to
  // must go from red to green.
  endpoint = await api(dest, '/api/webhook-endpoints', {
    method: 'POST',
    body: { name: 'RFC-304 package', provider: 'gitlab' },
  })
  await api(dest, '/api/code-hosts/gitlab', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })
  const repoId = await importRepo(dest, project.repoHttpUrl)
  await api(dest, `/api/code/matrix/${repoId}`, {
    method: 'PUT',
    body: { capability: 'ci-fix', enabled: true, templateId: importedBindingId },
  })

  await mocks.deliverWebhook({
    provider: 'gitlab',
    callbackUrl: `${dest.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`,
    secret: endpoint.secret,
    projectPath: PROJECT_PATH,
    number: project.number,
    event: 'pipeline_failed',
  })

  const stages = await waitFor(async () => {
    const page = await api<{
      items: Array<{ rounds: Array<{ endedAt: number | null; stages: StageView[] }> }>
    }>(dest, '/api/code/work-items?capability=ci-fix')
    const round = page.items[0]?.rounds[0]
    return round !== undefined && round.endedAt !== null ? round.stages : null
  }, 'a finished ci-fix round on the destination')
  const digest = stages
    .map((s) => `${s.stageName}:${s.status}${s.error === null ? '' : `(${s.error})`}`)
    .join(', ')

  // The four scripts that arrived in the zip really ran …
  for (const name of ['collect', 'classify', 'arbitrate', 'select']) {
    expect(stages.find((s) => s.stageName === name)?.status, `${name}; ${digest}`).toBe('done')
  }
  // … and the round got past the gate rather than settling on a red one.
  const after = stages.slice(stages.findIndex((s) => s.stageName === 'validate-fix') + 1)
  expect(
    after.some((s) => !(s.error ?? '').includes('left the gate red')),
    `the imported template did not produce a green gate; ${digest}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------

interface StageView {
  stageName: string
  status: string
  error: string | null
}

async function importRepo(daemon: DaemonHandle, url: string): Promise<string> {
  const batch = await api<{ batchId: string }>(daemon, '/api/cached-repos/batch-import', {
    method: 'POST',
    body: { urls: [url] },
  })
  return await waitFor(async () => {
    const snapshot = await api<{ rows: Array<{ cachedRepoId: string | null }> }>(
      daemon,
      `/api/cached-repos/imports/${batch.batchId}`,
    )
    return snapshot.rows[0]?.cachedRepoId ?? null
  }, `the mirror of ${url}`)
}

async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const seen = await probe()
    if (seen !== null) return seen
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function api<T = unknown>(
  daemon: DaemonHandle,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${String(response.status)}: ${text}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}
