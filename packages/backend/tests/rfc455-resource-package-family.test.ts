// RFC-455 — 资源包一族归 resource-catalog（RFC-294 W9-D、RFC-345 T6 余项）。
//
// 锁四件事：
// ① `services/resourcePackage/**`、`services/bundle/provider.ts` 与两个操作修订摘要（16 个文件）已迁出，两个目录不在了，`src/` 与用例
//    零 import 旧路径（census AST，别名与相对路径都认，带负对照）。
// ② 落位守层次：算法层（resource-catalog `application/package`）与新 domain 文件不取任何模块的 `infrastructure/` / `composition/`、
//    不取 `services/`；`decodeZip` 只有 domain 那一份；读端口只有 `application/package/ports.ts` 一份声明。
// ③ intent 经 resource-catalog `public/queries` 取的修订摘要就是 domain 那一份，且与 shared 的 Web Crypto 版本逐例相等。
// ④ 迁进 domain 的 zip 解码行为不变：编码后解回同样的条目，拒绝路径穿越。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { mcpOperationConfigHash, pluginOperationConfigHash } from '@agent-workflow/shared'
import * as mcpRevision from '@/modules/resource-catalog/domain/mcpOperationRevision'
import * as pluginRevision from '@/modules/resource-catalog/domain/pluginOperationRevision'
import * as rcQueries from '@/modules/resource-catalog/public/queries'
import { decodeZip, ZIP_LIMITS } from '@/modules/resource-catalog/domain/zipArchive'
import { encodeZip } from '@/util/zip'
import { ValidationError } from '@/util/errors'
import { zipSync } from 'fflate'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RC = 'modules/resource-catalog/'
const PKG = RC + 'application/package/'

const MOVED: Readonly<Record<string, string>> = {
  'services/bundle/provider': RC + 'domain/bundlePlan',
  'services/mcpOperationRevision': RC + 'domain/mcpOperationRevision',
  'services/pluginOperationRevision': RC + 'domain/pluginOperationRevision',
  'services/resourcePackage/closure': PKG + 'closure',
  'services/resourcePackage/commit': PKG + 'commit',
  'services/resourcePackage/export': PKG + 'export',
  'services/resourcePackage/importPermissions': PKG + 'importPermissions',
  'services/resourcePackage/parse': PKG + 'parse',
  'services/resourcePackage/preview': PKG + 'preview',
  'services/resourcePackage/providerReadPort': PKG + 'packageDocument',
  'services/resourcePackage/requirements': PKG + 'requirements',
  'services/resourcePackage/secretInputs': PKG + 'secretInputs',
  'services/resourcePackage/serialize': PKG + 'serialize',
  'services/resourcePackage/skillTree': PKG + 'skillTree',
  'services/resourcePackage/executionAdapter': RC + 'composition/resourcePackageExecution',
  'services/resourcePackage/pluginInstallerAdapter':
    RC + 'composition/resourcePackagePluginInstaller',
}
const OLD = Object.keys(MOVED)

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

/** `file -> target` for every import / re-export whose target satisfies `matches`. */
function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && matches(target))
      .map((target) => `${relative(SRC, path).split('\\').join('/')} -> ${target}`)
  })
}

const isOld = (target: string) => OLD.includes(target)
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('RFC-455 —— 资源包一族迁出 services/', () => {
  test('16 个旧文件与两个目录都不在了，新位置都在', () => {
    for (const [from, to] of Object.entries(MOVED)) {
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
      expect([to, existsSync(join(SRC, `${to}.ts`))]).toEqual([to, true])
    }
    expect(existsSync(join(SRC, 'services', 'resourcePackage'))).toBe(false)
    expect(existsSync(join(SRC, 'services', 'bundle'))).toBe(false)
  })

  test('src/ 与用例里零 import 旧路径', () => {
    expect(importsMatching(walk(SRC), isOld)).toEqual([])
    expect(importsMatching(walk(TESTS), isOld)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(isOld(targetOf(probe, '@/services/resourcePackage/parse') ?? '')).toBe(true)
    expect(isOld(targetOf(probe, './bundle/provider.ts') ?? '')).toBe(true)
    expect(isOld(targetOf(probe, './resourcePackage/parseExtra') ?? '')).toBe(false)
    expect(
      importsMatching([join(SRC, 'bootstrap', 'standalone.ts')], (t) => t.startsWith(RC)),
    ).not.toEqual([])
  })
})

describe('RFC-455 —— 落位守层次', () => {
  const movedFiles = Object.values(MOVED)
    .filter((to) => !to.startsWith(RC + 'composition/'))
    .concat([RC + 'domain/zipArchive'])
    .map((to) => join(SRC, `${to}.ts`))

  test('算法层与新 domain 文件不取 infrastructure / composition / services', () => {
    expect(
      importsMatching(movedFiles, (t) =>
        /^(?:modules\/[^/]+\/(?:infrastructure|composition)(?:\/|$)|services\/)/.test(t),
      ),
    ).toEqual([])
  })

  test('decodeZip 只有 domain 那一份；skill-zip 改取它', () => {
    const defining = walk(SRC).filter((path) =>
      /export function decodeZip\b|export const ZIP_LIMITS\b/.test(readFileSync(path, 'utf8')),
    )
    expect(defining.map((path) => relative(SRC, path).split('\\').join('/'))).toEqual([
      RC + 'domain/zipArchive.ts',
    ])
    expect(source(RC + 'infrastructure/legacy/skill-zip.ts')).toContain(
      "import { decodeZip } from '../../domain/zipArchive'",
    )
  })

  test('读端口与资源快照只在 ports.ts 声明一次', () => {
    const declaring = walk(SRC).filter((path) =>
      /interface ResourcePackage(?:ReadPort|ResourceSnapshot)\b/.test(readFileSync(path, 'utf8')),
    )
    expect(declaring.map((path) => relative(SRC, path).split('\\').join('/'))).toEqual([
      PKG + 'ports.ts',
    ])
  })

  test('intent 只经 resource-catalog public 取修订摘要', () => {
    const manifest = source('modules/intent/application/manifest.ts')
    expect(manifest).toContain("from '@/modules/resource-catalog/public/queries'")
    expect(manifest).not.toMatch(/OperationRevision'/)
  })
})

describe('RFC-455 —— 修订摘要与 zip 解码的行为', () => {
  const mcp = {
    id: 'mcp-1',
    name: 'probe',
    description: 'd',
    ownerUserId: 'u-1',
    visibility: 'private',
    aclRevision: 3,
    type: 'local',
    config: { command: ['node', 'server.js'], env: { A: '1' } },
    enabled: true,
    schemaVersion: 1,
    createdAt: 10,
    updatedAt: 20,
  } as never
  const plugin = {
    id: 'plugin-1',
    name: 'probe-plugin',
    description: '',
    spec: 'file:/tmp/p',
    ownerUserId: null,
    visibility: 'public',
    aclRevision: 0,
    enabled: true,
    sourceKind: 'file',
    cachedPath: '/tmp/cache',
    resolvedVersion: '1.0.0',
    installedAt: 5,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  } as never

  test('public/queries 导出的就是 domain 那一份', () => {
    expect(rcQueries.mcpOperationConfigHashOf).toBe(mcpRevision.mcpOperationConfigHashOf)
    expect(rcQueries.pluginOperationConfigHashOf).toBe(pluginRevision.pluginOperationConfigHashOf)
  })

  test('与 shared 的 Web Crypto 版本逐例相等，并写进 operationConfigHash', async () => {
    const mcpHash = mcpRevision.mcpOperationConfigHashOf(mcp)
    expect(mcpHash).toMatch(/^[0-9a-f]{64}$/)
    expect(mcpHash).toBe(await mcpOperationConfigHash(mcp))
    expect(mcpRevision.withMcpOperationConfigHash(mcp).operationConfigHash).toBe(mcpHash)
    const pluginHash = pluginRevision.pluginOperationConfigHashOf(plugin)
    expect(pluginHash).toBe(await pluginOperationConfigHash(plugin))
    expect(pluginRevision.withPluginOperationConfigHash(plugin).operationConfigHash).toBe(
      pluginHash,
    )
  })

  test('zip 解码：编码后解回同样的条目，拒绝路径穿越', () => {
    const files = [
      { path: 'skills/a/SKILL.md', bytes: new TextEncoder().encode('# a\n') },
      { path: 'manifest.json', bytes: new TextEncoder().encode('{}') },
    ]
    const entries = decodeZip(encodeZip(files)).filter((entry) => !entry.isDir)
    expect(
      entries.map((entry) => [entry.path, new TextDecoder().decode(entry.bytes())]).sort(),
    ).toEqual([
      ['manifest.json', '{}'],
      ['skills/a/SKILL.md', '# a\n'],
    ])
    // `encodeZip` 自己就拒绝穿越路径，所以穿越样本用 fflate 直接打包，确保走到的是 decodeZip 的校验。
    let rejected: unknown
    try {
      decodeZip(zipSync({ '../evil.txt': new TextEncoder().encode('x') }))
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(ValidationError)
    expect((rejected as ValidationError).code).toBe('zip-traversal')
    expect(ZIP_LIMITS.entries).toBeGreaterThan(0)
  })
})
