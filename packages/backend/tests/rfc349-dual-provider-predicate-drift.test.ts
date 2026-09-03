// RFC-349 AC-12 的一条**结构性**补充：两个 provider 各抄一遍的业务判据会悄悄漂。
//
// 已有的 `rfc349-dual-provider-behavior-oracle` 跑的是**机制**对拍——CAS、lease/fence、
// 幂等、outbox、顺序、apply 恢复。它证明不了「同一条业务判据在两个 adapter 里还是同一
// 条」。2026-09-03 RFC-352 在 memory 侧实撞：列表逐行盖的 `canManage` 在 SQLite 侧停在
// 「只有 owner」、PostgreSQL 侧是 `write|own`，于是拿到 `write` 授权的人在两种部署上看到
// 的按钮不一样，而两边 API 门都放行。根因就是同一段判据抄了两遍。
//
// RFC-349 造了 216 个 `postgresql*` adapter，个个与某个 `sqlite*` 同名文件配对，这个形状
// 在本仓是系统性的。这条守卫把「同名顶层函数在配对文件里实现不同」的集合钉成 exact 清单：
// 新出现一条就红，逼作者要么把判据收成一份、要么在这里写明为什么这一条**必须**按 provider
// 分叉（方言 SQL、驱动错误形状、行命名）。
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

/**
 * 允许分叉的同名函数，逐条写明理由。**只有下面三类才是正当的**：
 *   ① 方言 SQL（where 构造、大小写/排序、锁语法）；
 *   ② 驱动错误形状（SQLite 的 message 前缀 vs PostgreSQL 的 SQLSTATE）；
 *   ③ 行命名（原生 SQL 的 snake_case vs drizzle 映射后的 camelCase）与其上的取值转换
 *      （`x === 1` vs 原生 boolean）。
 * 业务判据（谁能改、算什么、默认值、失败怎么归类）**不在此列**——那种必须收成一份。
 */
const ALLOWED_DIVERGENCE: Readonly<Record<string, string>> = {
  'modules/memory/infrastructure/FusionPersistence.ts::uniqueViolation': '驱动错误形状',
  'modules/code-capability/infrastructure/DeliveryChain.ts::toRow': '行命名与取值转换',
  'modules/development-automation/infrastructure/MissionStore.ts::toMissionRow': '行命名与取值转换',
  'modules/development-automation/infrastructure/PlaybookSagaStore.ts::approval': '仅换行排版',
  'modules/development-automation/infrastructure/PlaybookSagaStore.ts::step': '仅换行排版',
  'modules/digital-employee/infrastructure/AuthoringStore.ts::toTool': '行命名与取值转换',
  'modules/digital-employee/infrastructure/AuthoringStore.ts::uniqueError': '驱动错误形状',
  'modules/identity-access/infrastructure/UserAccessRepository.ts::mapGrant':
    '行命名（snake_case vs camelCase）',
  'modules/identity-access/infrastructure/UserAccessRepository.ts::mapUser': '行命名与取值转换',
  'modules/intent/infrastructure/IntentApplyOperations.ts::intentResourcePlanOf': '仅形参命名',
  'modules/resource-catalog/infrastructure/PluginRepository.ts::ownerScopedNameWhere': '方言 SQL',
  'modules/resource-catalog/infrastructure/McpRepository.ts::ownerScopedNameWhere': '方言 SQL',
  'modules/resource-catalog/infrastructure/WorkgroupRepository.ts::ownerScopedNameWhere':
    '方言 SQL',
  'modules/resource-catalog/infrastructure/CatalogQuery.ts::catalogWhere': '方言 SQL',
  'modules/resource-catalog/infrastructure/ResourcePackageMaintenance.ts::parseArtifacts':
    '行命名与取值转换',
  'modules/task-execution/infrastructure/TaskCatalogSources.ts::source': '组装形状不同（非判据）',
  'modules/task-execution/infrastructure/TaskCatalogSources.ts::targetLabel': '入参形状不同',
  'modules/task-execution/infrastructure/RuntimeSessionLeaseOperations.ts::constraintViolation':
    '驱动错误形状',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Top-level `function name(...) { … }` bodies, by name. */
function topLevelFunctions(source: string): Map<string, string> {
  const found = new Map<string, string>()
  const signature = /^(?:export )?function (\w+)\s*\(/gm
  for (const match of source.matchAll(signature)) {
    const open = source.indexOf('{', match.index + match[0].length)
    if (open < 0) continue
    let depth = 0
    let cursor = open
    while (cursor < source.length) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    found.set(match[1]!, source.slice(open, cursor + 1))
  }
  return found
}

function normalize(body: string): string {
  return body
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/[^\n]*/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

describe('RFC-349 AC-12 — provider adapters must not fork a business predicate', () => {
  test('every same-named helper that differs across a provider pair is an accounted-for fork', () => {
    const divergent: string[] = []
    let pairs = 0
    for (const sqlitePath of walk(SRC)) {
      const file = sqlitePath.slice(sqlitePath.lastIndexOf('/') + 1)
      if (!file.startsWith('sqlite')) continue
      const postgresqlPath = sqlitePath.replace(/\/sqlite(?=[^/]*$)/, '/postgresql')
      let postgresqlSource: string
      try {
        postgresqlSource = readFileSync(postgresqlPath, 'utf8')
      } catch {
        continue
      }
      pairs += 1
      const sqliteFunctions = topLevelFunctions(readFileSync(sqlitePath, 'utf8'))
      const postgresqlFunctions = topLevelFunctions(postgresqlSource)
      const suffix = file.slice('sqlite'.length)
      const key = `${sqlitePath.slice(SRC.length + 1, sqlitePath.lastIndexOf('/'))}/${suffix}`
      for (const [name, sqliteBody] of sqliteFunctions) {
        const postgresqlBody = postgresqlFunctions.get(name)
        if (postgresqlBody === undefined) continue
        if (normalize(sqliteBody) === normalize(postgresqlBody)) continue
        divergent.push(`${key}::${name}`)
      }
    }

    expect(pairs, 'provider adapter 配对全没了 ⇒ 这条守卫已经什么都没扫').toBeGreaterThan(100)
    expect(
      divergent.sort(),
      '两个 provider 的同名函数实现不同。业务判据必须收成一份（见 memory 的 canManage 事故）；' +
        '确属方言 SQL / 驱动错误形状 / 行命名的，在 ALLOWED_DIVERGENCE 里逐条写明理由',
    ).toEqual(Object.keys(ALLOWED_DIVERGENCE).sort())
  })

  test('the allowlist explains every entry, and only with the three accepted reasons', () => {
    const accepted = [
      '方言 SQL',
      '驱动错误形状',
      '行命名',
      '仅换行排版',
      '仅形参命名',
      '组装形状不同（非判据）',
      '入参形状不同',
    ]
    for (const [entry, reason] of Object.entries(ALLOWED_DIVERGENCE)) {
      expect(reason.length, `${entry} 没写理由`).toBeGreaterThan(3)
      expect(
        accepted.some((prefix) => reason.startsWith(prefix)),
        `${entry} 的理由「${reason}」不在可接受的分叉类别里——业务判据不许分叉`,
      ).toBe(true)
    }
  })
})
