// RFC-449 — 代码平台调用对 task-execution 与 development-automation 改为注入（RFC-294 W4 B / D 准备）。
//
// 锁三件事：
// ① 两个模块下没有文件 import `services/codeHost/*`（census AST，别名与相对路径都认，带负对照）——后继 RFC-450 把该家族迁入
//    integration 时不会产生 DAG 外的边（DAG 只给 integration → task-execution / development-automation）。
// ② 代码平台节点的请求端口取运行时选项注入的实现；未注入时三个请求都按「未配置」失败而不抛错。
// ③ 装配根注入的就是代码平台请求的生产实现（RFC-450 起取自 integration composition 的 `codeHostNodeRequests`）。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createCodeHostNodeExecutionPorts } from '@/modules/task-execution/composition/codeHostNodeExecution'
import type { CodeHostRequestPort } from '@/modules/task-execution/application/ports/codeHostNodeExecution'
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

function codeHostImports(moduleDir: string): string[] {
  return walk(join(SRC, moduleDir)).flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
      .filter((specifier) => targetOf(path, specifier)?.startsWith('services/codeHost/') ?? false)
      .map((specifier) => `${relative(SRC, path)} -> ${specifier}`)
  })
}

function bindingWith(codeHostRequests?: CodeHostRequestPort) {
  return createCodeHostNodeExecutionPorts({
    opts: codeHostRequests === undefined ? {} : { codeHostRequests },
  } as never)
}

describe('RFC-449 —— 引用', () => {
  test('task-execution 与 development-automation 下没有文件 import services/codeHost/*', () => {
    expect(codeHostImports('modules/task-execution')).toEqual([])
    expect(codeHostImports('modules/development-automation')).toEqual([])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'modules', 'task-execution', 'composition', 'probe.ts')
    expect(targetOf(probe, '@/services/codeHost/call')).toBe('services/codeHost/call')
    expect(targetOf(probe, '../../../services/codeHost/recoveryProbe.ts')).toBe(
      'services/codeHost/recoveryProbe',
    )
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })

  test('装配根注入的是 integration 的代码平台请求实现', () => {
    const bootstrap = readFileSync(join(SRC, 'bootstrap/daemonModules/taskExecution.ts'), 'utf8')
    expect(bootstrap).toContain('codeHostRequests: codeHostNodeRequests,')
    expect(bootstrap).toContain(
      "import { codeHostNodeRequests } from '@/modules/integration/composition'",
    )
  })
})

describe('RFC-449 —— 请求端口', () => {
  test('注入时原样取用注入的实现', () => {
    const injected: CodeHostRequestPort = {
      executeCodeHostCall: async () => ({
        ok: true,
        status: 200,
        body: '{}',
        truncated: false,
        method: 'GET',
        pathname: '/',
      }),
      resolveProjectFallback: () => ({ ok: true, value: 'acme/app' }),
      probeCodeHostMutation: async () => ({
        kind: 'applied',
        proofCode: 'x',
        responseStatus: 200,
        responseBody: '',
      }),
    }
    expect(bindingWith(injected).requests).toBe(injected)
  })

  test('未注入时三个请求都按 code-host-not-configured 失败，不抛错', async () => {
    const requests = bindingWith().requests
    expect(
      await requests.executeCodeHostCall(
        { provider: 'gitlab', action: 'get-project', params: {} },
        {
          connection: {
            provider: 'gitlab',
            baseUrl: 'https://gitlab.example.test',
            repositoryUrlPrefixes: [],
            token: 't',
            rejectUnauthorized: true,
          },
          ctx: { ports: {} },
          projectFallback: { ok: true, value: 'acme/app' },
        },
      ),
    ).toMatchObject({ ok: false, code: 'code-host-not-configured' })
    expect(
      requests.resolveProjectFallback({
        provider: 'github',
        baseUrl: 'https://api.github.com',
        repositoryUrlPrefixes: [],
        repoUrl: null,
        repoCount: 0,
      }),
    ).toMatchObject({ ok: false, code: 'code-host-not-configured' })
    expect(
      await requests.probeCodeHostMutation({
        descriptor: {} as never,
        resolveConnection: async () => null,
      }),
    ).toEqual({
      kind: 'unknown',
      proofCode: 'code-host-not-configured',
      responseStatus: null,
      responseBody: '',
    })
  })
})
