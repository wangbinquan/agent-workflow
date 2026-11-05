// RFC-450 — 代码平台连接与调用归 integration（RFC-294 W4 B / D 第十五步）。
//
// 锁四件事：
// ① `services/codeHost/` 已删除，`src/` 下没有文件 import `services/codeHost/*`（census AST，别名与相对路径都认，带负对照）；
//    两个代码平台路由不再 import `services/`。
// ② 「测试连接」用例（原在 routes/codeHosts.ts 的测试端点）：未传字段回落已存值、只在测的就是已存那套时回写、
//    缺字段报 `code-host-not-configured`、GitHub 关闭 TLS 校验报 `code-host-tls-option-unsupported`。
// ③ MR 用例只经绑定里的 `requests` 发请求。
// ④ 装配：个人凭据路由用的探测把出站 fetch 注入点绑在 composition 上。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { CodeHostProvider, CodeHostTestResult } from '@agent-workflow/shared'
import { testCodeHostConnection } from '@/modules/integration/application/codeHostConnectionTest'
import { observeMergeRequest } from '@/modules/integration/application/mrEnsure'
import type {
  CodeHostCallDeps,
  CodeHostCallSpec,
  CodeHostRequests,
  ResolvedCodeHostConnection,
} from '@/modules/integration/application/ports/codeHostCalls'
import type { CodeHostConnectionCredential } from '@/modules/integration/application/ports/codeHostConnections'
import { composeCodeHostConnectionProbe } from '@/modules/integration/composition'
import { ValidationError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
      .filter((specifier) => matches(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${relative(SRC, path)} -> ${specifier}`)
  })
}

const isCodeHostFamily = (target: string) => target.startsWith('services/codeHost/')

describe('RFC-450 —— 引用', () => {
  test('services/codeHost/ 已删除，src/ 下没有文件 import services/codeHost/*', () => {
    expect(existsSync(join(SRC, 'services', 'codeHost'))).toBe(false)
    expect(importsMatching(walk(SRC), isCodeHostFamily)).toEqual([])
  }, 60_000)

  test('两个代码平台路由不再 import services/', () => {
    const routes = ['routes/codeHosts.ts', 'routes/accountRepositoryTransportCredentials.ts'].map(
      (route) => join(SRC, route),
    )
    expect(importsMatching(routes, (target) => target.startsWith('services/'))).toEqual([])
  })

  test('负对照：判据认得出别名与相对路径，也分得清同前缀的 services/codeHostAuthorGate', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isCodeHostFamily(targetOf(probe, '@/services/codeHost/call') ?? '')).toBe(true)
    expect(isCodeHostFamily(targetOf(probe, '../services/codeHost/url.ts') ?? '')).toBe(true)
    expect(isCodeHostFamily(targetOf(probe, '@/services/codeHostAuthorGate') ?? '')).toBe(false)
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })
})

describe('RFC-450 —— 测试连接用例', () => {
  const STORED: ResolvedCodeHostConnection = {
    provider: 'gitlab',
    baseUrl: 'https://gitlab.example.test/api/v4',
    repositoryUrlPrefixes: [],
    token: 'stored-token',
    rejectUnauthorized: true,
  }
  const RESULT: CodeHostTestResult = { ok: true, at: 1, login: 'aw-bot' }

  function fixture(stored: ResolvedCodeHostConnection | null) {
    const probed: CodeHostConnectionCredential[] = []
    const recorded: Array<{ provider: CodeHostProvider; result: CodeHostTestResult }> = []
    const deps = {
      service: {
        resolve: async () => stored,
        recordTest: async (provider: CodeHostProvider, result: CodeHostTestResult) => {
          recorded.push({ provider, result })
        },
      },
      probe: {
        probe: async (credential: CodeHostConnectionCredential) => {
          probed.push(credential)
          return RESULT
        },
      },
    }
    return { deps, probed, recorded }
  }

  test('未传字段回落已存值；测的就是已存那套时回写结果', async () => {
    const { deps, probed, recorded } = fixture(STORED)
    expect(await testCodeHostConnection(deps, 'gitlab', {})).toBe(RESULT)
    expect(probed).toEqual([
      {
        provider: 'gitlab',
        baseUrl: STORED.baseUrl,
        token: STORED.token,
        rejectUnauthorized: true,
      },
    ])
    expect(recorded).toEqual([{ provider: 'gitlab', result: RESULT }])
  })

  test('草稿值与已存值不同：只探测草稿，不回写', async () => {
    const { deps, probed, recorded } = fixture(STORED)
    await testCodeHostConnection(deps, 'gitlab', { token: 'draft-token' })
    expect(probed.map((credential) => credential.token)).toEqual(['draft-token'])
    expect(recorded).toEqual([])
  })

  test('既没有已存凭据也没给齐 base URL 与 token：code-host-not-configured，且不探测', async () => {
    const { deps, probed } = fixture(null)
    const failure = await testCodeHostConnection(deps, 'gitlab', {
      baseUrl: STORED.baseUrl,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ValidationError)
    expect((failure as ValidationError).code).toBe('code-host-not-configured')
    expect(probed).toEqual([])
  })

  test('GitHub 关闭 TLS 校验：code-host-tls-option-unsupported，且不探测', async () => {
    const { deps, probed } = fixture(null)
    const failure = await testCodeHostConnection(deps, 'github', {
      baseUrl: 'https://api.github.com',
      token: 't',
      rejectUnauthorized: false,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ValidationError)
    expect((failure as ValidationError).code).toBe('code-host-tls-option-unsupported')
    expect(probed).toEqual([])
  })
})

const STORED_CONNECTION: ResolvedCodeHostConnection = {
  provider: 'gitlab',
  baseUrl: 'https://gitlab.example.test/api/v4',
  repositoryUrlPrefixes: [],
  token: 'mr-token',
  rejectUnauthorized: true,
}

describe('RFC-450 —— MR 用例经绑定里的 requests', () => {
  test('observeMergeRequest 只经绑定给的 requests 发请求', async () => {
    const sent: Array<{ spec: CodeHostCallSpec; deps: CodeHostCallDeps }> = []
    const requests: CodeHostRequests = {
      executeCodeHostCall: async (spec, deps) => {
        sent.push({ spec, deps })
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            iid: 7,
            source_branch: 'feat',
            target_branch: 'main',
            state: 'opened',
            web_url: 'https://gitlab.example.test/grp/repo/-/merge_requests/7',
            sha: 'a'.repeat(40),
          }),
          truncated: false,
          method: 'GET',
          pathname: '/projects/grp%2Frepo/merge_requests/7',
        }
      },
      probeCodeHostConnection: async () => {
        throw new Error('observe never probes the connection')
      },
    }
    const out = await observeMergeRequest(
      {
        provider: 'gitlab',
        project: 'grp%2Frepo',
        call: { connection: { ...STORED_CONNECTION }, ctx: { ports: {} } },
        requests,
      },
      '7',
    )
    expect(out).toEqual({
      ok: true,
      mr: {
        mrRef: '7',
        state: 'opened',
        sourceSha: 'a'.repeat(40),
        targetBranch: 'main',
        webUrl: 'https://gitlab.example.test/grp/repo/-/merge_requests/7',
      },
    })
    expect(sent.map(({ spec }) => spec)).toEqual([
      { provider: 'gitlab', action: 'mr.get', params: { project: 'grp%2Frepo', mr: '7' } },
    ])
    expect(sent[0]?.deps.projectFallback).toEqual({ ok: true, value: 'grp%2Frepo' })
  })
})

describe('RFC-450 —— 装配', () => {
  test('个人凭据路由用的探测把出站 fetch 注入点绑在 composition 上', async () => {
    const seen: string[] = []
    const probe = composeCodeHostConnectionProbe({
      fetchImpl: async (url) => {
        seen.push(url)
        return new Response(JSON.stringify({ username: 'aw-bot' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const result = await probe.probe({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example.test/api/v4',
      token: 't',
      rejectUnauthorized: true,
    })
    expect(result).toMatchObject({ ok: true, login: 'aw-bot' })
    expect(seen).toEqual(['https://gitlab.example.test/api/v4/user'])
  })
})
