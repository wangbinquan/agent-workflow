// RFC-321 — real-session account UX plus task-owned managed publication.
//
// The browser journey proves write-only masking, identity validation,
// Alice/Bob isolation, replace/delete/fallback, responsive layout, keyboard
// reachability and axe. The task journey starts the real commit stub against an
// SSH remote; a Git insteadOf rule is used only for the pre-publication clone.
// The platform-owned push itself resolves provider metadata and authenticates
// to the system mock's real smart-HTTP receive-pack with the task owner's token.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

import {
  SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
  SYSTEM_MOCK_GIT_PERSONAL_TOKEN,
  SystemMockClient,
  type MockCodeHostProject,
} from '@agent-workflow/system-mocks'

import { runGit } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

interface SeededUser {
  readonly userId: string
  readonly username: string
  readonly sessionToken: string
}

interface ConnectionBinding {
  readonly connectionGeneration: string
  readonly endpointBindingDigest: string
}

interface CredentialList {
  readonly items: Array<{
    readonly provider: 'gitlab' | 'github'
    readonly connectionGeneration: string
    readonly endpointBindingDigest: string
  }>
}

interface NodeRunLite {
  readonly nodeId: string
  readonly commitPush: {
    readonly pushOutcome: string
    readonly commitSha: string | null
    readonly repoBranch: string
  } | null
}

let daemon: DaemonHandle
let mocks: SystemMockClient
let project: MockCodeHostProject
let sshRemote = ''
let alice: SeededUser
let bob: SeededUser

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function requestAs(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
}

async function jsonAs<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await requestAs(token, path, init)
  const text = await response.text()
  expect(response.ok, `${init.method ?? 'GET'} ${path}: ${response.status} ${text}`).toBe(true)
  return JSON.parse(text) as T
}

async function createUserAndLogin(username: string): Promise<SeededUser> {
  const password = `${username}-Password#321`
  const created = await jsonAs<{ id: string }>(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      displayName: username,
      role: 'user',
      password,
    }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const text = await login.text()
  expect(login.ok, `login ${username}: ${login.status} ${text}`).toBe(true)
  return {
    userId: created.id,
    username,
    sessionToken: (JSON.parse(text) as { sessionToken: string }).sessionToken,
  }
}

async function primeContext(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    ({ baseUrl, sessionToken }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', sessionToken)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, sessionToken: token },
  )
}

async function expectAxeClean(page: Page, include: string, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(include)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${label} axe violations`,
  ).toEqual([])
}

async function putOwnCredential(token: string, plainToken: string): Promise<void> {
  const list = await jsonAs<CredentialList>(token, '/api/account/code-host-push-credentials')
  const gitlab = list.items.find((item) => item.provider === 'gitlab')
  if (gitlab === undefined) throw new Error('configured GitLab connection is absent')
  await jsonAs(token, '/api/account/code-host-push-credentials/gitlab', {
    method: 'PUT',
    body: JSON.stringify({
      token: plainToken,
      connectionGeneration: gitlab.connectionGeneration,
      endpointBindingDigest: gitlab.endpointBindingDigest,
    }),
  })
}

async function mintMaximalGeneralPat(): Promise<string> {
  const docs = await jsonAs<{
    grantablePermissions: Array<{ verbs: Array<{ permission: string }> }>
  }>(daemon.token, '/api/docs/api')
  const scopes = [
    ...new Set(
      docs.grantablePermissions.flatMap((group) => group.verbs.map((verb) => verb.permission)),
    ),
  ]
  const response = await requestAs(daemon.token, '/api/auth/pats', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc321-maximal-route-denial-${Date.now()}`,
      scopes,
      purpose: 'general',
    }),
  })
  const text = await response.text()
  expect(response.status, `mint maximal PAT: ${text}`).toBe(201)
  return (JSON.parse(text) as { token: string }).token
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  const unique = `${process.pid}-${Date.now()}`
  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: `rfc321/e2e-${unique}`,
    gitPushCredentialMode: 'personal-and-global',
    baseFiles: { 'README.md': '# RFC-321 E2E\n' },
    headFiles: { 'README.md': '# RFC-321 E2E\n\ncandidate\n' },
  })
  sshRemote = `git@ssh.system-mock.test:${project.projectPath}.git`
  daemon = await startDaemon({
    stubMode: 'commit',
    extraEnv: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${project.repoHttpUrl}.insteadOf`,
      GIT_CONFIG_VALUE_0: sshRemote,
    },
  })
  await jsonAs<ConnectionBinding>(daemon.token, '/api/code-hosts/gitlab', {
    method: 'PUT',
    body: JSON.stringify({
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
      transportMappings: [
        {
          sshHost: 'ssh.system-mock.test',
          httpBaseUrl: requiredEnv('AW_SYSTEM_MOCK_BASE_URL'),
        },
      ],
    }),
  })
  alice = await createUserAndLogin(`rfc321-alice-${unique}`)
  bob = await createUserAndLogin(`rfc321-bob-${unique}`)
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('account UI validates, masks, replaces and deletes while Alice/Bob stay isolated at 390px', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await primeContext(aliceContext, alice.sessionToken)
  const alicePage = await aliceContext.newPage()
  await alicePage.goto(`${daemon.baseUrl}/account?section=codePush`)

  const section = alicePage.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-code-push"]',
  )
  await expect(section).toBeVisible()
  const identityCard = section.getByTestId('account-git-identity-card')
  await expect(identityCard).toBeVisible()
  await identityCard.getByRole('textbox', { name: /Display name/ }).fill(`${alice.username} Git`)
  await identityCard
    .getByRole('textbox', { name: /Email/ })
    .fill(`${alice.username}.git@example.test`)
  await identityCard.getByRole('button', { name: 'Save profile' }).click()
  await expect(identityCard.getByText('Profile and Git commit identity saved.')).toBeVisible()
  const card = section.getByTestId('account-code-push-card-gitlab')
  const input = card.getByTestId('account-code-push-token-gitlab')
  await expect(card.getByTestId('account-code-push-status-gitlab')).toContainText(
    'Platform fallback',
  )

  await input.fill(SYSTEM_MOCK_GIT_PERSONAL_TOKEN)
  await card.getByTestId('account-code-push-test-gitlab').click()
  await expect(card.getByTestId('account-code-push-test-result-gitlab')).toContainText(
    'system-mock-personal-user',
  )
  await card.getByTestId('account-code-push-save-gitlab').click()
  await expect(card.getByText('Personal Git push credential saved.')).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(card.getByTestId('account-code-push-status-gitlab')).toContainText(
    'Personal credential',
  )
  await expect(card).toContainText('p321')
  expect(await alicePage.content()).not.toContain(SYSTEM_MOCK_GIT_PERSONAL_TOKEN)

  await alicePage.reload()
  const reloadedCard = alicePage.getByTestId('account-code-push-card-gitlab')
  await expect(reloadedCard).toContainText('p321')
  await expect(reloadedCard.getByTestId('account-code-push-token-gitlab')).toHaveValue('')
  expect(await alicePage.content()).not.toContain(SYSTEM_MOCK_GIT_PERSONAL_TOKEN)

  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await primeContext(bobContext, bob.sessionToken)
  const bobPage = await bobContext.newPage()
  await bobPage.goto(`${daemon.baseUrl}/account?section=codePush`)
  const bobCard = bobPage.getByTestId('account-code-push-card-gitlab')
  await expect(bobCard.getByTestId('account-code-push-status-gitlab')).toContainText(
    'Platform fallback',
  )
  await expect(bobCard.getByTestId('account-code-push-remove-gitlab')).toHaveCount(0)
  await expect(bobCard).not.toContainText('p321')
  await bobContext.close()

  const replacementInput = reloadedCard.getByTestId('account-code-push-token-gitlab')
  await replacementInput.fill(SYSTEM_MOCK_GIT_GLOBAL_TOKEN)
  await reloadedCard.getByTestId('account-code-push-test-gitlab').click()
  await expect(reloadedCard.getByTestId('account-code-push-test-result-gitlab')).toContainText(
    'system-mock-global-user',
  )
  await reloadedCard.getByTestId('account-code-push-save-gitlab').click()
  await expect(reloadedCard).toContainText('g321')
  await reloadedCard.getByTestId('account-code-push-test-gitlab').click()
  await expect(reloadedCard.getByTestId('account-code-push-test-result-gitlab')).toContainText(
    'system-mock-global-user',
  )

  await alicePage.setViewportSize({ width: 390, height: 844 })
  await expectAxeClean(
    alicePage,
    'section.account-section-panel[aria-labelledby="account-section-title-code-push"]',
    'RFC-321 account panel',
  )
  const metrics = await section.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  await replacementInput.focus()
  await expect(replacementInput).toBeFocused()

  await reloadedCard.getByTestId('account-code-push-remove-gitlab').click()
  const dialog = alicePage.getByRole('dialog', {
    name: 'Remove this personal push credential?',
  })
  await expect(dialog).toBeVisible()
  await expectAxeClean(alicePage, '.dialog__panel', 'RFC-321 remove confirmation')
  await dialog.getByRole('button', { name: 'Remove credential' }).click()
  await expect(reloadedCard.getByTestId('account-code-push-status-gitlab')).toContainText(
    'Platform fallback',
  )
  await aliceContext.close()
})

test('even a maximal general PAT cannot read, write, probe, or delete personal push credentials', async () => {
  const pat = await mintMaximalGeneralPat()
  const draftCanary = 'rfc321-pat-route-draft-must-never-be-parsed' // gitleaks:allow
  const attempts: Array<{ path: string; init?: RequestInit }> = [
    { path: '/api/account/code-host-push-credentials' },
    {
      path: '/api/account/code-host-push-credentials/gitlab',
      init: {
        method: 'PUT',
        body: JSON.stringify({
          token: draftCanary,
          connectionGeneration: 'pat-must-not-reach-handler',
          endpointBindingDigest: 'f'.repeat(64),
        }),
      },
    },
    {
      path: '/api/account/code-host-push-credentials/gitlab/test',
      init: { method: 'POST', body: JSON.stringify({ token: draftCanary }) },
    },
    {
      path: '/api/account/code-host-push-credentials/gitlab',
      init: { method: 'DELETE' },
    },
  ]

  for (const attempt of attempts) {
    const response = await requestAs(pat, attempt.path, attempt.init)
    const text = await response.text()
    expect(response.status, `${attempt.init?.method ?? 'GET'} ${attempt.path}: ${text}`).toBe(403)
    expect(text).not.toContain(draftCanary)
  }
})

test('task owner personal token drives the real SSH-to-smart-HTTP auto-push', async () => {
  await putOwnCredential(daemon.token, SYSTEM_MOCK_GIT_PERSONAL_TOKEN)
  const before = (await mocks.requests()).length

  const agent = await jsonAs<{ id: string }>(daemon.token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc321-push-writer-${Date.now()}`,
      description: 'RFC-321 managed publication writer',
      outputs: ['answer'],
      readonly: false,
      bodyMd: '',
    }),
  })
  const workflow = await jsonAs<{ id: string }>(daemon.token, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc321-push-workflow-${Date.now()}`,
      description: 'RFC-321 managed SSH publication',
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'writer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'RFC-321 writer',
            promptTemplate: '{{topic}}',
            position: { x: 300, y: 0 },
          },
          {
            id: 'output',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'writer', portName: 'answer' } }],
            position: { x: 600, y: 0 },
          },
        ],
        edges: [
          {
            id: 'input-writer',
            source: { nodeId: 'input', portName: 'topic' },
            target: { nodeId: 'writer', portName: 'topic' },
          },
          {
            id: 'writer-output',
            source: { nodeId: 'writer', portName: 'answer' },
            target: { nodeId: 'output', portName: 'answer' },
          },
        ],
      },
    }),
  })
  const task = await jsonAs<{ id: string }>(daemon.token, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'RFC-321 managed SSH publication',
      workflowId: workflow.id,
      repoUrl: sshRemote,
      ref: 'main',
      autoCommitPush: true,
      inputs: { topic: 'write the deterministic RFC-321 result' },
    }),
  })

  const deadline = Date.now() + 90_000
  let status = 'pending'
  while (Date.now() < deadline) {
    const current = await jsonAs<{ status: string }>(daemon.token, `/api/tasks/${task.id}`)
    status = current.status
    if (['done', 'failed', 'canceled'].includes(status)) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  expect(status).toBe('done')
  const { runs } = await jsonAs<{ runs: NodeRunLite[] }>(
    daemon.token,
    `/api/tasks/${task.id}/node-runs`,
  )
  const publication = runs.find(
    (run) => run.nodeId.startsWith('__commit_push__') && run.commitPush !== null,
  )
  expect(publication?.commitPush).toMatchObject({ pushOutcome: 'pushed' })
  expect(publication?.commitPush?.commitSha).toMatch(/^[0-9a-f]{40}$/)

  const requests = (await mocks.requests()).slice(before)
  const projectGitRequests = requests.filter(
    (request) => request.service === 'git' && request.path.includes(`/${project.projectPath}.git`),
  )
  expect(projectGitRequests.map((request) => request.credentialIdentity)).toContain('personal')
  expect(projectGitRequests.map((request) => request.credentialIdentity)).not.toContain('global')
  const serialized = JSON.stringify(requests)
  expect(serialized).not.toContain(SYSTEM_MOCK_GIT_PERSONAL_TOKEN)
  expect(serialized).not.toContain(SYSTEM_MOCK_GIT_GLOBAL_TOKEN)

  const branch = publication!.commitPush!.repoBranch
  const remoteRef = runGit(
    ['ls-remote', project.repoHttpUrl, `refs/heads/${branch}`],
    process.cwd(),
  )
  expect(remoteRef).toContain(publication!.commitPush!.commitSha!)
})
