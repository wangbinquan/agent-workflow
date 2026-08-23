// Guard: everything Playwright loads must run on NODE, not Bun.
//
// WHY THIS EXISTS (commit 86ebbf2d, CI runs on 2026-08-04)
// -------------------------------------------------------
// `bun run e2e` shells out to Playwright, and Playwright runs the spec files —
// and everything they import — on its OWN Node runner. RFC-254 T29 moved the
// fixture SQLite boundary onto `import { Database } from 'bun:sqlite'`, which
// Node cannot resolve. The failure is not a skipped test or a red assertion:
// the suite dies at LOAD time, before any test runs, with
//
//     Error: Only URLs with a scheme in: file, data, and node are supported
//     by the default ESM loader. Received protocol 'bun:'
//
// and Playwright then reports "No tests found" — which reads like a filter
// typo, not a broken import. All four e2e shards stayed down for four commits
// because nothing between `bun run test` and `git push` looks at this.
//
// The Bun-only work still exists; it lives in a CHILD process now
// (`e2e/fixtures/sqlite-exec.ts`, spawned by `e2e/command.ts`). That is the
// distinction this guard draws: the fixtures directory is executed BY Bun (the
// compiled stub, the sqlite runner) and may use it freely; the files Playwright
// itself imports may not.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const E2E_DIR = resolve(import.meta.dir, '..', '..', '..', 'e2e')

/** The files Playwright's Node runner loads: `e2e/*.ts`, fixtures excluded. */
function nodeLoadedFiles(): string[] {
  return readdirSync(E2E_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
}

// Every spelling that reaches a `bun:` module, not just the static one:
//   import x from 'bun:sqlite'   /   import 'bun:sqlite'   /   await import('bun:sqlite')
// The dynamic form matters most — it is what someone reaches for after being
// told "no static bun: import here", and it fails at the FIRST FIXTURE CALL
// rather than at load, which is strictly harder to diagnose than the outage
// this guard commemorates.
const BUN_MODULE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]bun:[^'"]+['"]/
// The `Bun` global by any route: `Bun.spawn`, `Bun['spawn']`, `globalThis.Bun`,
// and `const { spawn } = Bun`. Requiring a literal dot (the first version did)
// let the bracket and destructuring forms through, and all of them are
// `undefined` under Node.
const BUN_GLOBAL_USE = /(?<![\w$])Bun\s*(?:\.\s*[A-Za-z$_]|\[)|=\s*Bun\b/

function withoutCommentsOrStrings(source: string): string {
  return (
    source
      .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
      .replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
      .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
      // Template literals keep their `${…}` contents: those are CODE, and
      // blanking the whole literal hid `` `${Bun.version}` `` from the scan.
      .replaceAll(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``')
  )
}

describe('RFC-254 — the Playwright-loaded e2e files stay Node-compatible', () => {
  test('the scan actually sees files', () => {
    const files = nodeLoadedFiles()
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('harness.ts')
    expect(files).toContain('command.ts')
  })

  test('none of them import a `bun:` module', () => {
    const offenders = nodeLoadedFiles().filter((name) =>
      BUN_MODULE_IMPORT.test(readFileSync(join(E2E_DIR, name), 'utf8')),
    )
    expect(offenders, 'these run under Node — move the Bun work into a child process').toEqual([])
  })

  test('none of them touch the `Bun` global', () => {
    const offenders = nodeLoadedFiles().filter((name) =>
      BUN_GLOBAL_USE.test(withoutCommentsOrStrings(readFileSync(join(E2E_DIR, name), 'utf8'))),
    )
    expect(offenders, '`Bun` is undefined under Node — spawn `bun` instead').toEqual([])
  })

  test('no Playwright-loaded file imports out of the fixtures directory', () => {
    // `e2e/fixtures/**` is exempt from the two rules above BECAUSE it is
    // executed by Bun — `sqlite-exec.ts` imports `bun:sqlite` two directories
    // from that boundary. The exemption only holds while nothing Node loads
    // pulls a fixture into its import graph, and a single
    // `import { x } from './fixtures/…'` in a spec reopens the outage.
    const offenders = nodeLoadedFiles().filter((name) =>
      /\bfrom\s*['"]\.[./]*\/?fixtures\//.test(readFileSync(join(E2E_DIR, name), 'utf8')),
    )
    expect(offenders, 'fixtures are executed by Bun — Node must not import them').toEqual([])
  })

  test('the Bun-side runner it delegates to is still there', () => {
    // If this file were renamed or removed, `runSqlite` would fail at RUN time
    // in every fixture that plants state — worth failing here instead.
    const runner = readFileSync(join(E2E_DIR, 'fixtures', 'sqlite-exec.ts'), 'utf8')
    expect(runner).toContain("from 'bun:sqlite'")
    expect(readFileSync(join(E2E_DIR, 'command.ts'), 'utf8')).toContain('sqlite-exec.ts')
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**本文件自己的 matcher**。
//
// 这两条正则要抓的是「Node 侧代码里混进了 Bun 专有 API」。它们都带 lookbehind /
// 可选分组，最容易的静默失效是有人「整理」时删掉一支写法——扫描照跑、永远零违规。
describe('RFC-317 T14 —— matcher 自证：伪造的 Bun 用法必须被抓到', () => {
  test('bun: 模块的各种引入写法都命中', () => {
    for (const fabricated of [
      "import { file } from 'bun:sqlite'",
      'const db = await import("bun:test")',
      "export { x } from 'bun:ffi'",
    ]) {
      expect(BUN_MODULE_IMPORT.test(fabricated), `没抓到：${fabricated}`).toBe(true)
    }
    expect(BUN_MODULE_IMPORT.test("import { readFileSync } from 'node:fs'")).toBe(false)
  })

  test('Bun 全局的属性访问 / 下标 / 赋值都命中，同名前缀不误报', () => {
    for (const fabricated of ['Bun.spawn(cmd)', 'Bun["env"]', 'const runner = Bun']) {
      expect(BUN_GLOBAL_USE.test(fabricated), `没抓到：${fabricated}`).toBe(true)
    }
    expect(BUN_GLOBAL_USE.test('const BunnyHop = 1')).toBe(false)
  })

  test('注释 / 字符串里提到 Bun 不算违规（否则规则没法在它适用的地方被解释）', () => {
    const fabricated = '// 这里以前用 Bun.spawn\nconst hint = "Bun.spawn 不可用"\nconst x = 1\n'
    const cleaned = withoutCommentsOrStrings(fabricated)
    expect(BUN_GLOBAL_USE.test(cleaned)).toBe(false)
  })
})
