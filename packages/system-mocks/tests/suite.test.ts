import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  MOCK_OIDC_CLIENT_ID,
  MOCK_OIDC_CLIENT_SECRET,
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '../src'
import { runChecked } from '../src/core/process'

let suite: StartedSystemMockSuite
const temporaryPaths: string[] = []

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterAll(async () => {
  await suite.close()
  await Promise.all(
    temporaryPaths.map(async (path) => await rm(path, { recursive: true, force: true })),
  )
})

describe('unified system mock gateway', () => {
  test('exposes one lifecycle, endpoint inventory, snapshot, request journal and fault plane', async () => {
    expect((await suite.client.health()).ok).toBe(true)
    expect(suite.endpoints.gitBaseUrl).toStartWith(suite.endpoints.baseUrl)
    const initial = await suite.client.snapshot()
    expect(initial.oidc.users.map((user) => user.sub)).toContain('mock-alice')
    expect(initial.oidc.tokenMode).toBe('id-token')
    expect(initial.oauth.tokenMode).toBe('access-token-only')
    expect(initial.packages.npm).toContainEqual({ name: 'system-mock-package', version: '1.0.0' })

    await suite.client.addFault({
      service: 'plantuml',
      pathPrefix: '/renderer',
      status: 429,
      times: 1,
    })
    expect(
      (
        await fetch(`${suite.endpoints.plantumlEndpoint}/plantuml/svg`, {
          method: 'POST',
          body: '@startuml\nA -> B\n@enduml',
        })
      ).status,
    ).toBe(429)
    expect(
      (
        await fetch(`${suite.endpoints.plantumlEndpoint}/plantuml/svg`, {
          method: 'POST',
          body: '@startuml\nA -> B\n@enduml',
        })
      ).status,
    ).toBe(200)
    const requests = await suite.client.requests('plantuml')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.bodyText).toContain('A -> B')
  })

  test('serves real smart HTTP repositories and GitLab/GitHub REST identities', async () => {
    for (const provider of ['gitlab', 'github'] as const) {
      const project = await suite.client.seedCodeHost({
        provider,
        projectPath: `team/${provider}-fixture`,
        baseFiles: { 'README.md': 'base\n' },
        headFiles: { 'README.md': 'head\n' },
      })
      expect(project.projectId).toBe(provider === 'gitlab' ? '1000' : '1001')
      const clone = await temporaryDirectory(`system-mock-${provider}-clone-`)
      await runChecked('git', ['clone', '-q', project.repoHttpUrl, clone])
      expect(
        await runChecked('git', ['ls-remote', '--symref', project.repoHttpUrl, 'HEAD']),
      ).toContain('ref: refs/heads/main\tHEAD')
      expect(await readFile(join(clone, 'README.md'), 'utf8')).toBe('base\n')

      const apiBase =
        provider === 'gitlab' ? suite.endpoints.gitlabApiBaseUrl : suite.endpoints.githubApiBaseUrl
      const headers: Record<string, string> =
        provider === 'gitlab'
          ? { 'private-token': SYSTEM_MOCK_CODE_HOST_TOKEN }
          : { authorization: `Bearer ${SYSTEM_MOCK_CODE_HOST_TOKEN}` }
      const response = await fetch(`${apiBase}/user`, {
        headers,
      })
      expect(response.status).toBe(200)
      const identity = (await response.json()) as Record<string, unknown>
      expect(identity[provider === 'gitlab' ? 'username' : 'login']).toBe('system-mock-user')

      const mrPath =
        provider === 'gitlab'
          ? `/projects/${encodeURIComponent(project.projectPath)}/merge_requests/${String(project.number)}`
          : `/repos/${project.projectPath}/pulls/${String(project.number)}`
      const mr = (await (await fetch(`${apiBase}${mrPath}`, { headers })).json()) as Record<
        string,
        unknown
      >
      expect(provider === 'gitlab' ? mr.detailed_merge_status : mr.mergeable_state).toBe(
        provider === 'gitlab' ? 'mergeable' : 'clean',
      )
    }
  })

  test('completes OIDC authorization-code + PKCE + ID-token and userinfo identity', async () => {
    const verifier = 'system-mock-verifier-that-is-long-enough'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = new URL(`${suite.endpoints.oidcIssuerUrl}/authorize`)
    authorize.search = new URLSearchParams({
      client_id: MOCK_OIDC_CLIENT_ID,
      redirect_uri: 'http://127.0.0.1/callback',
      response_type: 'code',
      scope: 'openid profile email',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    const page = await fetch(authorize)
    expect(await page.text()).toContain('data-testid="oidc-user-mock-alice"')

    const submitBody = new URLSearchParams(authorize.searchParams)
    submitBody.set('mock_sub', 'mock-alice')
    const submitted = await fetch(`${suite.endpoints.oidcIssuerUrl}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: submitBody,
    })
    const callback = new URL(submitted.headers.get('location')!)
    const token = await fetch(`${suite.endpoints.oidcIssuerUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: MOCK_OIDC_CLIENT_ID,
        client_secret: MOCK_OIDC_CLIENT_SECRET,
        redirect_uri: 'http://127.0.0.1/callback',
        code: callback.searchParams.get('code')!,
        code_verifier: verifier,
      }),
    })
    const tokenBody = (await token.json()) as { access_token: string; id_token?: string }
    expect(tokenBody.id_token).toBeString()
    const userinfo = await fetch(`${suite.endpoints.oidcIssuerUrl}/userinfo`, {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    })
    expect(await userinfo.json()).toMatchObject({ sub: 'mock-alice', email: 'alice@mock.test' })
  })

  test('serves an independent OAuth issuer and access-token-only client credentials', async () => {
    const discovery = await fetch(
      `${suite.endpoints.oauthIssuerUrl}/.well-known/oauth-authorization-server`,
    )
    expect(await discovery.json()).toMatchObject({
      issuer: suite.endpoints.oauthIssuerUrl,
      token_endpoint: `${suite.endpoints.oauthIssuerUrl}/token`,
    })
    const clientCredentials = await fetch(`${suite.endpoints.oauthIssuerUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: MOCK_OIDC_CLIENT_ID,
        client_secret: MOCK_OIDC_CLIENT_SECRET,
      }),
    })
    const token = (await clientCredentials.json()) as {
      access_token?: string
      id_token?: string
    }
    expect(token.access_token).toBeString()
    expect(token).not.toHaveProperty('id_token')
    const userinfo = await fetch(`${suite.endpoints.oauthIssuerUrl}/userinfo`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    expect(await userinfo.json()).toMatchObject({ sub: 'mock-alice' })
    expect(await suite.client.requests('oauth')).toHaveLength(3)

    await suite.client.configureOauth({
      users: [{ sub: 'oauth-only', email: 'oauth@mock.test', name: 'OAuth Only' }],
    })
    expect((await suite.client.snapshot()).oidc.tokenMode).toBe('id-token')
    expect((await suite.client.snapshot()).oidc.users[0]?.sub).toBe('mock-alice')
    expect((await suite.client.snapshot()).oauth.users[0]?.sub).toBe('oauth-only')
    await suite.client.reset()
    const reset = await suite.client.snapshot()
    expect(reset.oidc.tokenMode).toBe('id-token')
    expect(reset.oauth.tokenMode).toBe('access-token-only')
  })

  test('is consumable by the real MCP Streamable HTTP client', async () => {
    const client = new Client({ name: 'system-mock-test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(suite.endpoints.mcpStreamableUrl))
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'fail', 'ping', 'query'])
      const resources = await client.listResources()
      expect(resources.resources[0]?.uri).toBe('file:///system-mock/README.md')
    } finally {
      await client.close()
    }
  })

  // 60s：真 npm/pip 子进程安装在 CI 共享 runner 上冷启动可超默认 5s
  // （2026-08-18 PR-4 CI 实红：pip 5001ms 被 bun 默认超时杀掉，本地恒绿）。
  test('serves installable npm and PyPI artifacts plus the PlantUML renderer contract', async () => {
    await suite.client.seedNpm({
      name: '@mock/hello',
      version: '2.3.4',
      files: [{ path: 'index.js', content: "module.exports = 'hello-from-mock'\n" }],
    })
    const npmMetadata = await fetch(`${suite.endpoints.npmRegistryUrl}@mock%2Fhello`)
    const npmBody = (await npmMetadata.json()) as {
      versions?: Record<string, { version?: string }>
    }
    expect(npmBody.versions?.['2.3.4']?.version).toBe('2.3.4')
    const npmProject = await temporaryDirectory('system-mock-npm-install-')
    await writeFile(join(npmProject, 'package.json'), '{"name":"consumer","private":true}')
    await runChecked(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        suite.endpoints.npmRegistryUrl,
        '--cache',
        join(npmProject, '.npm-cache'),
        '@mock/hello@2.3.4',
      ],
      { cwd: npmProject, timeoutMs: 30_000 },
    )
    expect(
      await readFile(join(npmProject, 'node_modules', '@mock', 'hello', 'index.js'), 'utf8'),
    ).toContain('hello-from-mock')

    await suite.client.seedPython({ name: 'mock-python-demo', version: '3.2.1' })
    const simple = await fetch(`${suite.endpoints.pypiIndexUrl}mock-python-demo/`)
    const simpleHtml = await simple.text()
    expect(simpleHtml).toContain('mock_python_demo-3.2.1-py3-none-any.whl')
    const wheelLink = /href="([^"]+)/.exec(simpleHtml)?.[1]
    expect(wheelLink).toBeString()
    const wheel = await fetch(new URL(wheelLink!, simple.url))
    expect(wheel.status).toBe(200)
    expect((await wheel.arrayBuffer()).byteLength).toBeGreaterThan(100)
    const python = Bun.which('python3') ?? Bun.which('python')
    if (python !== null) {
      const pythonTarget = await temporaryDirectory('system-mock-pip-install-')
      await runChecked(
        python,
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-input',
          '--no-cache-dir',
          '--no-deps',
          '--index-url',
          suite.endpoints.pypiIndexUrl,
          '--target',
          pythonTarget,
          'mock-python-demo==3.2.1',
        ],
        { timeoutMs: 30_000 },
      )
      expect(
        await readFile(join(pythonTarget, 'mock_python_demo', '__init__.py'), 'utf8'),
      ).toContain('system-mock')
    }

    const rendered = await fetch(`${suite.endpoints.plantumlEndpoint}/plantuml/svg`, {
      method: 'POST',
      body: '@startuml\nAlice -> Bob: hello\n@enduml',
    })
    expect(rendered.headers.get('content-type')).toContain('image/svg+xml')
    expect(await rendered.text()).toContain('system mock PlantUML renderer')
  }, 60_000)
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

test('SCIP executable accepts every indexer output flag shape', async () => {
  const worktree = await temporaryDirectory('system-mock-scip-')
  await writeFile(join(worktree, 'sample.ts'), 'export const value = 1\n')
  const entry = resolve(import.meta.dir, '..', 'src', 'scip', 'cli.ts')
  for (const args of [
    ['index', '--output', join(worktree, 'typescript.scip')],
    ['--index-output', join(worktree, 'clang.scip')],
  ]) {
    await runChecked(process.execPath, ['run', entry, ...args], { cwd: worktree })
    expect((await readFile(args.at(-1)!)).length).toBeGreaterThan(10)
  }
})

describe('development-requirement service inside the unified suite (RFC-310 PR-3)', () => {
  test('control-plane seed → data-plane fetch → Q&A round trip → reset clears', async () => {
    await suite.client.seedRequirement({
      externalId: 'REQ-S1',
      revision: 'r9',
      title: 'suite demand',
      files: [
        { fileId: 'f1', name: 'body.md', role: 'body', mediaType: 'text/markdown', content: 'x\n' },
      ],
    })
    // 环境面：adapter 子进程拿 AW_REQUIREMENT_MOCK_URL 即可直达数据面。
    expect(suite.env.AW_REQUIREMENT_MOCK_URL).toBe(suite.endpoints.developmentRequirementBaseUrl)
    const meta = (await (
      await fetch(`${suite.endpoints.developmentRequirementBaseUrl}/requirements/REQ-S1`)
    ).json()) as { revision: string; title: string }
    expect(meta).toMatchObject({ revision: 'r9', title: 'suite demand' })

    const posted = await fetch(
      `${suite.endpoints.developmentRequirementBaseUrl}/requirements/REQ-S1/questions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questions: [{ questionId: 'q1', text: 'when?' }] }),
      },
    )
    expect(posted.status).toBe(201)
    const { correlationId } = (await posted.json()) as { correlationId: string }
    const listed = await suite.client.listRequirementQuestionSets()
    expect(listed.items.some((s) => s.correlationId === correlationId)).toBe(true)

    const seeded = await suite.client.seedRequirementAnswers({
      correlationId,
      answers: [{ questionId: 'q1', answer: 'now' }],
      answerRevision: 'a5',
    })
    expect(seeded.ok).toBe(true)
    const answers = (await (
      await fetch(
        `${suite.endpoints.developmentRequirementBaseUrl}/requirements/REQ-S1/questions/${correlationId}/answers`,
      )
    ).json()) as { complete: boolean; answerRevision: string }
    expect(answers).toMatchObject({ complete: true, answerRevision: 'a5' })

    // reset 合同：seed 与 correlation 全部归零。
    await suite.client.reset()
    expect(
      (await fetch(`${suite.endpoints.developmentRequirementBaseUrl}/requirements/REQ-S1`)).status,
    ).toBe(404)
    expect((await suite.client.listRequirementQuestionSets()).items).toHaveLength(0)
  })
})
