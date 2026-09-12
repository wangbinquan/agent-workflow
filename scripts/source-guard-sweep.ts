#!/usr/bin/env bun
// 「改了 src/ 下的东西，哪些测试会被波及」——**按「谁真的去读本包源码」挑，不按文件名关键词挑**。
//
// 为什么存在：`docs/dev-gotchas.md` 已有一条教训说关键词表（`architecture|boundary|lock|guard|…`）
// 挑不全；那条教训给的两条 grep（普查 API / `'..', 'src'` 字面量）**也还漏**——
// `tests/rfc359-w29-unstarted-application-composition.test.ts` 用的是
// `resolve(import.meta.dir, '..')` 承接进一个常量再 `readFileSync`，两条都不匹配，
// 于是 2026-09-12 那次改 `cli/postgresqlDaemonApplication.ts` 本地全绿、CI 两格红。
//
// 判据收在这里，只有一条：**这个测试文件有没有去读本包 `src/` 下的源码**。三种形态都认：
//   ① 普查 API（`backendUnits` / `packageSrcUnits` / `importEdges` / `sourceUnit`）；
//   ② `readFileSync` / `ts.createSourceFile` 的实参里直接出现指向 src 的路径；
//   ③ 实参是个变量，但文件里有一个明显指向包根 / src 的常量赋值。
// 再并上 `tests/architecture/` 全量。
//
// 用法（在仓库根）：
//   bun run scripts/source-guard-sweep.ts            # 只列名单
//   AW_TEST_POSTGRESQL_URL=… bun run scripts/source-guard-sweep.ts --run   # 分批跑
//
// **`--run` 必须带 `AW_TEST_POSTGRESQL_URL`**：名单里有大量双引擎用例，缺库时它们按设计
// 「缺库即红」（不是 skip），几十条红全是噪声，真红反而淹掉。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const TESTS = join(import.meta.dir, '..', 'packages', 'backend', 'tests')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.test.ts') ? [full] : []
  })
}

const CENSUS_API = /backendUnits\(|packageSrcUnits\(|importEdges\(|sourceUnit\(/
const SRC_PATH =
  /'\.\.',\s*'src'|\.\.\/src\/|sourceRoot|SOURCE_ROOT|ROUTE_FILE|srcFile|resolve\(import\.meta\.dir,\s*'\.\.'\)/
const SRC_CONST = /^const \w+ = resolve\(import\.meta\.dir, '\.\.'(?:, 'src')?\)/m

function readsOwnSource(source: string): boolean {
  if (CENSUS_API.test(source)) return true
  for (const match of source.matchAll(/(?:readFileSync|createSourceFile)\s*\(([^\n]*)/g)) {
    if (SRC_PATH.test(match[1]!)) return true
  }
  return SRC_CONST.test(source)
}

const selected = walk(TESTS)
  .filter((file) => file.includes('/architecture/') || readsOwnSource(readFileSync(file, 'utf8')))
  .sort()

if (!process.argv.includes('--run')) {
  for (const file of selected) console.log(relative(process.cwd(), file))
  console.log(`\n${String(selected.length)} files`)
} else {
  const backend = join(import.meta.dir, '..', 'packages', 'backend')
  let failed = 0
  // 分批：`bun test` 把多个路径当过滤器，一次给上百个会「filters did not match」然后一个都不跑，
  // 且 exit 0——看起来像跑过了。`--isolate` 同样不能省（见 docs/dev-gotchas.md）。
  for (let index = 0; index < selected.length; index += 20) {
    const batch = selected.slice(index, index + 20).map((file) => relative(backend, file))
    const run = spawnSync('bun', ['test', '--isolate', ...batch], {
      cwd: backend,
      stdio: 'inherit',
    })
    if (run.status !== 0) failed += 1
  }
  if (failed > 0) {
    console.error(`\n${String(failed)} batch(es) failed`)
    process.exit(1)
  }
}
