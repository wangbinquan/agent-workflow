// RFC-596 — 事件收件箱的通道在 integration 的业务层改用中立名字（RFC-294 §14：业务层部署模式分支 1 → 0）。
//
// 为什么存在：托管事件入站的接纳通道原先在 application 端口里叫 `crewstation`——那是 CrewStation 事件源配置与收件箱表里的取值，是部署的
// 词汇。现在业务层叫 `admit`（`shadow` 不变），配置与表照旧是 `crewstation`，互译只在托管适配器的一对函数里做。锁三件事：
// ① integration 的 domain / application / engine / inbound / public 全部源码里没有 `crewstation` / `standalone` 字符串（字面量类型与值都算；判据带负对照）。
// ② 互译是全的、互逆的（两个方向逐值核对）。
// ③ 三处跨层（配置 → 目标、目标 → 行、行 → 目标）都经这对函数；表的枚举与配置 schema 仍是 `crewstation` / `shadow`（不改持久值与外部合同）。
//
// 覆盖范围（C12）：① 覆盖 integration 业务层的全部源码；② ③ 只读三个文件。行为由既有用例覆盖（`rfc370-v3-event-ingress-decisions`、
// `rfc370-m3-event-inbox` 的路由与收件箱）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import {
  bindingModeOfEventChannel,
  eventChannelOfBindingMode,
} from '@/modules/integration/infrastructure/crewstation/eventChannel'

const SRC = join(import.meta.dir, '..', 'src')
const INTEGRATION = join(SRC, 'modules', 'integration')
const BUSINESS_LAYERS = ['domain', 'application', 'engine', 'inbound', 'public'] as const
const DEPLOYMENT_NAMES = new Set(['crewstation', 'standalone'])
const slash = (path: string) => path.split('\\').join('/')
const read = (...parts: string[]) => readFileSync(join(INTEGRATION, ...parts), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

/** String literals (plain and no-substitution template, values and literal types) that are a deployment name. */
function deploymentNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && DEPLOYMENT_NAMES.has(node.text)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('RFC-596 —— 事件通道在业务层用中立名字', () => {
  test('integration 的业务层源码里没有部署名字符串', () => {
    const files = BUSINESS_LAYERS.flatMap((layer) => walk(join(INTEGRATION, layer)))
    expect(files.length).toBeGreaterThanOrEqual(80)
    expect(
      files.flatMap((path) =>
        deploymentNames(path, readFileSync(path, 'utf8')).map(
          (name) => `${slash(relative(SRC, path))}: ${name}`,
        ),
      ),
    ).toEqual([])
  })

  test('负对照：字面量类型、值与模板字符串都会被认出，注释与更长的字符串不算', () => {
    expect(
      deploymentNames(
        'probe.ts',
        '// a crewstation note\n' +
          "export type Channel = 'crewstation' | 'shadow'\n" +
          "const mode = 'standalone'\n" +
          'const other = `crewstation`\n' +
          "const longer = 'crewstation-shadow'\n",
      ),
    ).toEqual(['crewstation', 'standalone', 'crewstation'])
  })

  test('互译是全的、互逆的', () => {
    expect([eventChannelOfBindingMode('crewstation'), eventChannelOfBindingMode('shadow')]).toEqual(
      ['admit', 'shadow'],
    )
    expect([bindingModeOfEventChannel('admit'), bindingModeOfEventChannel('shadow')]).toEqual([
      'crewstation',
      'shadow',
    ])
    for (const mode of ['crewstation', 'shadow'] as const)
      expect(bindingModeOfEventChannel(eventChannelOfBindingMode(mode))).toBe(mode)
    for (const channel of ['admit', 'shadow'] as const)
      expect(eventChannelOfBindingMode(bindingModeOfEventChannel(channel))).toBe(channel)
  })

  test('三处跨层都经这对函数；表的枚举与配置 schema 不变', () => {
    const contract = read('infrastructure', 'crewstation', 'eventContract.ts')
    const inbox = read('infrastructure', 'crewstation', 'eventInbox.ts')
    expect(contract).toContain('channel: eventChannelOfBindingMode(binding.mode),')
    expect(inbox).toContain('mode: bindingModeOfEventChannel(target.channel),')
    expect(inbox).toContain('channel: eventChannelOfBindingMode(target.mode),')
    expect(contract).not.toMatch(/channel: binding\.mode\b/)
    expect(inbox).not.toMatch(/mode: target\.channel\b|channel: target\.mode\b/)
    expect(contract).toContain("mode: z.enum(['crewstation', 'shadow']),")
    expect(read('infrastructure', 'persistence', 'schema.ts')).toContain(
      "mode: c.enum('mode', ['shadow', 'crewstation']),",
    )
  })
})
