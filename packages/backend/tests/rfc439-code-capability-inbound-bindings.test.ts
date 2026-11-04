// RFC-439 — 代码能力的两个 HTTP 绑定归入 code-capability 模块（RFC-294 W4 B / D 第五步，E8 前置）。
//
// 锁四件事：
// ① 位置：`routes/code.ts`、`routes/capabilityTemplates.ts` 不存在，绑定在模块的 `inbound/http`；
//    挂载经 `composition/routes` 转出，`composition.ts` 仍是 RFC-395 登记的 schema-only 根。
// ② B / D 退出门：`routes/` 下没有任何文件深引模块内部（与 R1 账本同一判据，计数归零）。
// ③ 方向：两个绑定只依赖本模块（相对路径、不碰 infrastructure）与 HTTP 传输工具，
//    不 import legacy `services/`、`@/db` 与他域。
// ④ 生产应用里 `/api/code/*` 与 `/api/capability-templates*` 的路由元数据与响应不变。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { CODE_CAPABILITIES } from '@/modules/code-capability/domain/stageContract'
import { lookupRouteMeta } from '@/routes/registry'
import { importEdges, inboundBoundaryEdges, sourceUnit } from './architecture/census'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const MODULE = join(SRC, 'modules', 'code-capability')

const BINDINGS = ['inbound/http/codeRoutes.ts', 'inbound/http/capabilityTemplateRoutes.ts'] as const

/** 绑定可以用的模块外依赖：框架、共享合同与 HTTP 传输工具。 */
const TRANSPORT_ALLOWLIST = new Set([
  'hono',
  '@agent-workflow/shared',
  '@/auth/actor',
  '@/routes/registry',
  '@/routes/resourceAcl',
  '@/util/errors',
  '@/util/http',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/**
 * 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重。
 * 走 census 的 AST 提取，与 R1 账本同一口径；注释与字符串里的「from '…'」不会被误认。
 */
function specifiers(path: string, text: string): string[] {
  return [...new Set(importEdges(sourceUnit(path, text)).map((edge) => edge.specifier))]
}

describe('RFC-439 —— 位置', () => {
  test('两个原路由文件不再存在，绑定与挂载入口就位', () => {
    expect(existsSync(join(SRC, 'routes', 'code.ts'))).toBe(false)
    expect(existsSync(join(SRC, 'routes', 'capabilityTemplates.ts'))).toBe(false)
    for (const path of [...BINDINGS, 'composition/routes.ts']) {
      expect(existsSync(join(MODULE, path)), path).toBe(true)
    }
  })

  test('挂载入口只转出两个绑定；composition.ts 仍只转出 schema', () => {
    const routes = readFileSync(join(MODULE, 'composition', 'routes.ts'), 'utf8')
    expect(specifiers('composition/routes.ts', routes).sort()).toEqual([
      '../inbound/http/capabilityTemplateRoutes',
      '../inbound/http/codeRoutes',
    ])
    expect(routes).toContain('mountCodeRoutes')
    expect(routes).toContain('mountCapabilityTemplateRoutes')
    const root = readFileSync(join(MODULE, 'composition.ts'), 'utf8')
    expect(specifiers('composition.ts', root)).toEqual(['./infrastructure/persistence/schema'])
  })

  test('server.ts 经 composition 挂载，不再 import 旧路由', () => {
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8')
    expect(server).toContain("from '@/modules/code-capability/composition/routes'")
    expect(server).not.toContain("from '@/routes/code'")
    expect(server).not.toContain("from '@/routes/capabilityTemplates'")
    expect(server).toContain('mountCodeRoutes(app, input.code.history)')
    expect(server).toContain('mountCapabilityTemplateRoutes(app, input.code.capabilityTemplates)')
  })
})

describe('RFC-439 —— B / D 退出门与方向', () => {
  test('routes/ 下没有任何文件深引模块内部（与 R1 账本同一判据）', () => {
    const units = walk(join(SRC, 'routes')).map((path) =>
      sourceUnit(relative(REPO_ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8')),
    )
    expect(units.length).toBeGreaterThan(30)
    const deep = inboundBoundaryEdges(units).map((edge) => `${edge.from} -> ${edge.specifier}`)
    expect(deep).toEqual([])
  })

  test('负对照：同一判据认得出路由对模块内部的深引', () => {
    const probe = sourceUnit(
      'packages/backend/src/routes/probe.ts',
      "import { projectStageGraph } from '@/modules/code-capability/domain/stageGraph'\n" +
        "import type { CodeMatrixQuery } from '@/modules/code-capability/public/queries'\n",
    )
    expect(inboundBoundaryEdges([probe]).map((edge) => edge.specifier)).toEqual([
      '@/modules/code-capability/domain/stageGraph',
    ])
  })

  test('两个绑定只依赖本模块与 HTTP 传输工具', () => {
    const offenders: string[] = []
    for (const path of BINDINGS) {
      const found = specifiers(path, readFileSync(join(MODULE, path), 'utf8'))
      // 非空对照：两个绑定都经 registerRoute 登记路由，提取不到它就说明判据失效。
      expect(found, path).toContain('@/routes/registry')
      for (const specifier of found) {
        if (specifier.startsWith('.')) {
          // 相对路径必须留在本模块内，且不碰适配层。
          const target = resolve(join(MODULE, path, '..'), specifier)
          if (!target.startsWith(MODULE + '/') || target.includes('/infrastructure/')) {
            offenders.push(`${path} -> ${specifier}`)
          }
          continue
        }
        if (!TRANSPORT_ALLOWLIST.has(specifier)) offenders.push(`${path} -> ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

const DAEMON_TOKEN = 'e'.repeat(64)
const AUTH = { Authorization: `Bearer ${DAEMON_TOKEN}` }

describeEachProviderHttpApplication(
  'RFC-439 —— 生产应用里的代码能力路由',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc439-code-',
  },
  (scope: ProviderHttpApplicationScope) => {
    test('路由元数据不变', async () => {
      await scope.open()
      for (const [method, path] of [
        ['GET', '/api/code/matrix/:repoId'],
        ['GET', '/api/code/work-items'],
        ['GET', '/api/code/deliveries'],
        ['GET', '/api/code/rounds/:roundId/attempts'],
        ['GET', '/api/code/capabilities'],
        ['GET', '/api/code/capabilities/:capability/graph'],
        ['GET', '/api/code/metrics'],
      ] as const) {
        expect(lookupRouteMeta(method, path), `${method} ${path}`).toMatchObject({
          permissions: ['repos:read'],
          tokenAccess: 'allow',
        })
      }
      expect(lookupRouteMeta('GET', '/api/capability-templates')).toMatchObject({
        permissions: ['capability-templates:read'],
        tokenAccess: 'allow',
      })
      expect(lookupRouteMeta('POST', '/api/capability-templates')).toMatchObject({
        permissions: ['capability-templates:create'],
      })
      expect(lookupRouteMeta('POST', '/api/capability-templates/:id/upstream/merge')).toMatchObject(
        { permissions: ['capability-templates:update'] },
      )
      expect(lookupRouteMeta('DELETE', '/api/capability-templates/:id')).toMatchObject({
        permissions: ['capability-templates:delete'],
      })
      expect(lookupRouteMeta('GET', '/api/capability-templates/:id/acl')).toBeDefined()
      expect(lookupRouteMeta('PUT', '/api/capability-templates/:id/acl')).toBeDefined()
    })

    test('未登录 401；能力目录与图投影照常应答', async () => {
      const app = (await scope.open()).app
      expect((await app.request('/api/code/capabilities')).status).toBe(401)
      expect((await app.request('/api/capability-templates')).status).toBe(401)

      const catalog = await app.request('/api/code/capabilities', { headers: AUTH })
      expect(catalog.status).toBe(200)
      const body = (await catalog.json()) as {
        items: { capability: string; agentSlots: string[] }[]
      }
      expect(body.items.map((item) => item.capability)).toEqual([...CODE_CAPABILITIES])

      const unknown = await app.request('/api/code/capabilities/not-a-capability/graph', {
        headers: AUTH,
      })
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({ error: 'unknown-capability' })

      const templates = await app.request('/api/capability-templates', { headers: AUTH })
      expect(templates.status).toBe(200)
    })
  },
)
