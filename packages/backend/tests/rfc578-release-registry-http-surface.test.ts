// RFC-578 补正 —— 发布注册表的能力探测随路由迁移失效（回归）。
//
// 为什么存在：`scripts/release-upgrade/registry.ts` 按 `routes/` 下的文件路径判断一个发布版本有没有某项能力（memories、
// schedules、workgroups、mcps、skillId、workgroupId），发布升级门按这些能力决定种什么数据、验什么端点。RFC-294 W9-D 把
// 路由迁进各模块的 `inbound/`（RFC-438 的定时任务、RFC-578 的记忆……），只按路径判会把之后的新版本记成“没有这项能力”，
// 发布门随之少验而不报错。探测改为：旧路径照旧认（已发布的版本读出来一样），旧路径不在时读 HTTP 面注册的端点。锁三件事：
// ① 读法：只认 `routes/**` 与各模块 `inbound/**`，按带引号的完整端点匹配（负对照：别处提到、只是前缀相同的都不算）；
// ② 现状：本仓库的 HTTP 面注册了六项探测要找的每一个端点；
// ③ 接线：registry.ts 的六项探测都经这个读法兜底。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { HTTP_SURFACE_FILE, httpSurfaceRegisters } from '../../../scripts/release-upgrade/lib/model'

const REPO = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = join(REPO, 'packages', 'backend', 'src')

/** The endpoints the six capability probes fall back to. */
const PROBED = [
  '/api/mcps',
  '/api/scheduled-tasks',
  '/api/workgroups',
  '/api/memories',
  '/api/skills/:id',
  '/api/workgroups/:id',
] as const

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('RFC-578 补正 —— HTTP 面的端点读法', () => {
  test('只认 routes/ 与模块 inbound/ 下的 TS 文件', () => {
    expect(HTTP_SURFACE_FILE.test('packages/backend/src/routes/workgroups.ts')).toBe(true)
    expect(
      HTTP_SURFACE_FILE.test('packages/backend/src/modules/memory/inbound/http/memoryRoutes.ts'),
    ).toBe(true)
    expect(HTTP_SURFACE_FILE.test('packages/backend/src/mcp/tools.ts')).toBe(false)
    expect(HTTP_SURFACE_FILE.test('packages/backend/src/modules/memory/application/x.ts')).toBe(
      false,
    )
    expect(HTTP_SURFACE_FILE.test('packages/frontend/src/routes/workgroups.tsx')).toBe(false)
  })

  test('按带引号的完整端点匹配；别处提到、只是前缀相同的都不算', () => {
    const files = new Map([
      [
        'packages/backend/src/modules/memory/inbound/http/memoryRoutes.ts',
        "registerRoute(app, { method: 'GET', path: '/api/memories' })",
      ],
      [
        'packages/backend/src/routes/skills.ts',
        "registerRoute(app, { path: '/api/skills/:id/files' })",
      ],
      ['packages/backend/src/mcp/tools.ts', "const target = '/api/mcps'"],
      ['packages/frontend/src/routes/workgroups.tsx', "fetch('/api/workgroups')"],
    ])
    const registers = httpSurfaceRegisters([...files.keys()], (path) => files.get(path) ?? '')
    expect(registers('/api/memories')).toBe(true)
    expect(registers('/api/skills/:id')).toBe(false)
    expect(registers('/api/mcps')).toBe(false)
    expect(registers('/api/workgroups')).toBe(false)
  })

  test('只读一次 HTTP 面，且只在需要时才读', () => {
    const reads: string[] = []
    const files = ['packages/backend/src/routes/a.ts', 'packages/backend/src/routes/b.ts']
    const registers = httpSurfaceRegisters(files, (path) => {
      reads.push(path)
      return "path: '/api/a'"
    })
    expect(reads).toEqual([])
    expect(registers('/api/a')).toBe(true)
    expect(registers('/api/b')).toBe(false)
    expect(reads).toEqual(files)
  })
})

describe('RFC-578 补正 —— 本仓库的 HTTP 面与 registry.ts 的接线', () => {
  test('本仓库的 HTTP 面注册了六项探测要找的每一个端点', () => {
    const files = walk(BACKEND_SRC).map((path) => relative(REPO, path).split('\\').join('/'))
    expect(files.filter((file) => HTTP_SURFACE_FILE.test(file)).length).toBeGreaterThan(50)
    const registers = httpSurfaceRegisters(files, (path) => readFileSync(join(REPO, path), 'utf8'))
    for (const endpoint of PROBED) expect([endpoint, registers(endpoint)]).toEqual([endpoint, true])
  })

  test('registry.ts 的六项能力探测都经这个读法兜底', () => {
    const registry = readFileSync(join(REPO, 'scripts', 'release-upgrade', 'registry.ts'), 'utf8')
    expect(registry).toContain('httpSurfaceRegisters(')
    for (const endpoint of PROBED)
      expect([endpoint, registry.includes(`registers('${endpoint}')`)]).toEqual([endpoint, true])
  })
})
