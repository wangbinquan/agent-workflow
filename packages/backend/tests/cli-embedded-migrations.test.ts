// 为什么有这份测试：**发行的单二进制上 `agent-workflow backup` / `migrate` /
// `migration-report` / `package export|import` 全部当场失败**，报的是一句与它们
// 毫无关系的 `Can't find meta/_journal.json file`（2026-08-25 在
// dist/agent-workflow-macos-arm64 上实测，四条命令退出码都是 1）。
//
// 根因：这四处直接把 `Paths.migrationsDir` 交给 `openDb`，而
// `packages/backend/src/util/paths.ts:94` 解析出来的是**源码树里**的
// `packages/backend/db/migrations`——单二进制里没有这个目录。同仓的
// `cli/user.ts` / `cli/auth.ts` / `cli/restore.ts` / `cli/start.ts` 都各自手写了
// 一段「IS_EMBEDDED 时先解包到 ~/.agent-workflow/runtime/migrations」的前置，
// 那四处漏了。**这段前置被抄了六遍**，正是漏掉第七遍的原因，所以修法是收敛成
// 唯一的 `resolveMigrationsFolder()`，并由本文件钉住「不许再有人绕过它」。
//
// 为什么单测此前照不到：`packages/backend/tests/cli.test.ts` 等在源码树上跑，
// 那时 `Paths.migrationsDir` 是个真目录、`IS_EMBEDDED` 是 false，四条命令全绿；
// 而二进制 smoke 只跑 `version`。与 RFC-311 P0-1（backup worker 在发行版
// ModuleNotFound）是同一形态、同一个文件。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '../src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const FILES = walk(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const rel = (p: string) => p.slice(SRC.length + 1)

describe('单二进制上的迁移目录解析', () => {
  test('没有任何地方再把 Paths.migrationsDir 直接交给 openDb', () => {
    // 零豁免：这个写法在发行二进制上**必然**失败，没有「这一处没关系」的情形。
    const offenders = FILES.filter((f) => f.text.includes('migrationsFolder: Paths.migrationsDir'))
    expect(
      offenders.map((f) => rel(f.path)).sort(),
      "这么写在发行的单二进制上必然报 `Can't find meta/_journal.json file`——" +
        '源码树里的 db/migrations 不在可执行文件里。改用 resolveMigrationsFolder()',
    ).toEqual([])
  })

  test('cli/ 下每个开库的模块都经由 resolveMigrationsFolder 拿路径', () => {
    // 判据从源码派生，不维护名单：凡是调用 openDb 的 CLI 模块都得走解析器。
    const openers = FILES.filter((f) => rel(f.path).startsWith('cli/') && /\bopenDb\(/.test(f.text))
    expect(
      openers.length,
      'cli/ 下一个 openDb 调用都扫不到 ⇒ 这条判据在空转（改名了？换 import 了？）',
    ).toBeGreaterThan(3)
    const missing = openers
      .filter((f) => !f.text.includes('resolveMigrationsFolder'))
      .map((f) => rel(f.path))
      .sort()
    expect(
      missing,
      '这些 CLI 命令自己拼迁移目录 ⇒ 只要有人漏抄那段 IS_EMBEDDED 前置，' +
        '该命令在发行版上就是死的，而在源码树上跑的单测全绿',
    ).toEqual([])
  })

  test('那段 IS_EMBEDDED 解包前置只剩解析器一份实现', () => {
    const inlined = FILES.filter(
      (f) =>
        rel(f.path) !== 'db/migrationsFolder.ts' &&
        f.text.includes("join(Paths.root, 'runtime', 'migrations')"),
    )
    expect(
      inlined.map((f) => rel(f.path)).sort(),
      '又有人把解包前置抄了一份 ⇒ 下一处漏抄只是时间问题（这次漏了四处）',
    ).toEqual([])
  })
})
