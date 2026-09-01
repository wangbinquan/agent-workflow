// RFC-317 T71（findings RT-01）—— runtime 的能力声明必须在**每一个** spawn 入口生效。
//
// 事故形态：`acceptsExtraArgs` / `acceptsSandboxCompatibilityMarker` 是 driver 的能力
// 声明，`validateExtraArgs` 的错误文案把它当能力说——「只有声明了 acceptsExtraArgs 的
// driver 才会消费它」。但这道门此前**只在注册写路径**（createRuntime / updateRuntime）
// 上被查过：
//
//   · `POST /api/runtimes/probe` 把请求体里的 `extraArgs` / `isSandbox` 直接交给
//     `smokeRuntime` 拉起真子进程，一次都不校验；
//   · `POST /api/runtimes` 的预检 smoke 跑在 `createRuntime` **之前**——所以「保存时会
//     校验」救不了它：一组不被接受的参数会先被**执行**，之后才因保存失败而报错。
//
// 「只在两个入口之一被强制的能力声明不是能力，是约定」。今天这条缺口是惰性的
// （opencode 的 spawn 既不读 extraArgs 也不写 IS_SANDBOX），但一个未来的 driver 只要
// 开始读这两个字段，任何 `settings:write` 调用方就立刻拿到一条未经校验的 argv / env 通道。
//
// 本文件两层：①行为——两条请求体通道各自 400 且**没有 spawn 发生**（用 spy smoke 证明，
// 光看状态码分不出「拒绝了」与「跑完才拒绝」）；②源码棘轮——`src/routes` 下每一处
// `smokeRuntime(` 调用都必须在同一个函数体内先出现 `assertRuntimeSpawnCapabilities(`，
// 否则将来新加的第四个 spawn 站点会重演同一个洞。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { loadConfig } from '../src/config'
import { createApp, type RuntimeDiagnosticTestDependencies } from '../src/server'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import type { SmokeOptions, SmokeResult } from '../src/services/runtimeSmoke'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')

const CONFORMING: SmokeResult = {
  outcome: 'conforms',
  conforms: true,
  detail: 'spy',
  sawNonce: true,
  sawEnvelope: false,
  exitCode: 0,
}

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
  /** 每次 smokeRuntime 调用的入参——空数组即「没有 spawn 发生」。 */
  spawns: SmokeOptions[]
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc317-cap-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
  const spawns: SmokeOptions[] = []
  const runtimeDiagnosticTestDependencies: RuntimeDiagnosticTestDependencies = {
    smokeRuntime: (options: SmokeOptions) => {
      spawns.push(options)
      return Promise.resolve(CONFORMING)
    },
  }
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    runtimeDiagnosticTestDependencies,
  })
  return { db, app, tmp, spawns }
}

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('RFC-317 T71 —— spawn 前的 runtime 能力门（findings RT-01）', () => {
  test('POST /api/runtimes/probe：opencode + isSandbox=true ⇒ 422 且零 spawn', async () => {
    const h = await buildHarness()
    try {
      const res = await post(h.app, '/api/runtimes/probe', {
        protocol: 'opencode',
        binaryPath: '/nonexistent/opencode',
        isSandbox: true,
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code?: string }
      expect(body.code).toBe('runtime-is-sandbox-unsupported')
      // 状态码本身分不出「拒绝了」与「跑完了才拒绝」——这一条才是要点。
      expect(h.spawns, '能力门必须在 spawn 之前；这里出现调用说明子进程已经起过了').toEqual([])
    } finally {
      rmSync(h.tmp, { recursive: true, force: true })
    }
  })

  test('POST /api/runtimes/probe：opencode + extraArgs ⇒ 422 且零 spawn', async () => {
    const h = await buildHarness()
    try {
      const res = await post(h.app, '/api/runtimes/probe', {
        protocol: 'opencode',
        binaryPath: '/nonexistent/opencode',
        extraArgs: ['--dangerously-skip-permissions'],
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code?: string }
      expect(body.code).toBe('runtime-extra-args-protocol')
      expect(h.spawns).toEqual([])
    } finally {
      rmSync(h.tmp, { recursive: true, force: true })
    }
  })

  test('POST /api/runtimes 的预检 smoke 同样在 spawn 前拒绝（保存校验救不了它）', async () => {
    const h = await buildHarness()
    try {
      const res = await post(h.app, '/api/runtimes', {
        name: 'rt-cap-gate',
        protocol: 'opencode',
        binaryPath: '/nonexistent/opencode',
        probe: true,
        extraArgs: ['--x'],
      })
      expect(res.status).toBe(422)
      expect(
        h.spawns,
        '预检 smoke 跑在 createRuntime 之前，所以必须自己带门——否则不被接受的参数会先被执行一遍',
      ).toEqual([])
    } finally {
      rmSync(h.tmp, { recursive: true, force: true })
    }
  })

  test('声明了该能力的 driver 不受影响：claude-code + isSandbox=true 正常进 spawn', async () => {
    const h = await buildHarness()
    try {
      const res = await post(h.app, '/api/runtimes/probe', {
        protocol: 'claude-code',
        binaryPath: '/nonexistent/claude',
        isSandbox: true,
      })
      expect(res.status).toBe(200)
      expect(
        h.spawns.length,
        '正向路径必须真的到达 smokeRuntime，否则上面三条证明不了「门」只挡该挡的',
      ).toBe(1)
      expect(h.spawns[0]?.isSandbox).toBe(true)
    } finally {
      rmSync(h.tmp, { recursive: true, force: true })
    }
  })

  test('源码棘轮：src/routes 下每一处 smokeRuntime( 的同一函数体内必须先有能力门', () => {
    const files = readdirRecursive(ROUTES_DIR).filter((p) => p.endsWith('.ts'))
    expect(files.length, 'src/routes 枚举断了，本条棘轮失去意义').toBeGreaterThan(10)

    const offenders: string[] = []
    let smokeSites = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(SPAWN_CALLEE + '(')) continue
      const scan = scanUngatedSpawnSites(file.replace(/^.*\/src\//, 'src/'), text)
      smokeSites += scan.sites
      offenders.push(...scan.offenders)
    }
    expect(smokeSites, 'src/routes 下一处 spawn 调用都没找到——判据的被测面没了').toBeGreaterThan(2)
    expect(
      offenders,
      '这些 spawn 站点没有在同一函数体内先过 assertRuntimeSpawnCapabilities。' +
        'RT-01 的成因就是「能力门只装在注册写路径上」——新加一个 spawn 入口会原样重演。',
    ).toEqual([])
  })

  // ── matcher 自证（R11 / T14）──────────────────────────────────────────────
  //
  // 上面那条是「断言不存在」的扫描：语料变空、AST 逻辑写错、被测名字改掉，
  // 任何一种都会让它安静地全绿。下面两条把判据喂给合成样本，正反各一。
  // 样本刻意不写任何真实文件路径 / 退役标识符——仓内别的源码扫描守卫看得见这段文本
  // （`docs/dev-gotchas.md` 记过：负 fixture 里的伪造样本仍然是仓里的真实字符）。

  test('matcher 自证：没有能力门的 spawn 站点必须被抓到', () => {
    const sample = [
      'export function mount(app: unknown): void {',
      '  register(app, async (c) => {',
      '    const body = parse(await c.json())',
      `    const r = await ${SPAWN_CALLEE}({ protocol: body.protocol })`,
      '    return c.json({ r })',
      '  })',
      '}',
    ].join('\n')
    const scan = scanUngatedSpawnSites('src/routes/__fixture__.ts', sample)
    expect(scan.sites).toBe(1)
    expect(scan.offenders.length, '判据已经认不出「无门的 spawn」了').toBe(1)
  })

  test('matcher 自证：门在同一函数体内且位置在前时必须放行', () => {
    const sample = [
      'export function mount(app: unknown): void {',
      '  register(app, async (c) => {',
      '    const body = parse(await c.json())',
      `    ${GATE_CALLEE}(body.protocol, { extraArgs: body.extraArgs })`,
      `    const r = await ${SPAWN_CALLEE}({ protocol: body.protocol })`,
      '    return c.json({ r })',
      '  })',
      '}',
    ].join('\n')
    const scan = scanUngatedSpawnSites('src/routes/__fixture__.ts', sample)
    expect(scan.sites).toBe(1)
    expect(
      scan.offenders,
      '判据把合规写法也判成违规了——那会逼着后来的人把代码写成它认得的样子',
    ).toEqual([])
  })
})

const SPAWN_CALLEE = 'smokeRuntime'
const GATE_CALLEE = 'assertRuntimeSpawnCapabilities'

/** 纯函数：扫描与 matcher 自证共用同一份实现（否则自证证明的只是拷贝还咬得动）。 */
function scanUngatedSpawnSites(
  label: string,
  text: string,
): { sites: number; offenders: string[] } {
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true)
  const offenders: string[] = []
  let sites = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SPAWN_CALLEE
    ) {
      sites++
      const fn = enclosingFunction(node)
      const scope = fn === null ? source : fn
      if (!callsGateBefore(scope, node.getStart(source))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        offenders.push(`${label}:${line + 1}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { sites, offenders }
}

function readdirRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readdirRecursive(p))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

/** 同一作用域内、位置早于 `before` 的 `assertRuntimeSpawnCapabilities(` 调用。 */
function callsGateBefore(scope: ts.Node, before: number): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === GATE_CALLEE &&
      node.getStart() < before
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return found
}
