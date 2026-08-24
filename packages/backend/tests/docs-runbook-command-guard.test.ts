// 运维 runbook 里出现的每条 `agent-workflow <cmd>` 必须是真命令（RFC-310 T111① 收口时加）。
//
// 为什么这条测试存在：`docs/release-upgrade-rollback.md` 是**出事时才会被打开**的文档——
// 升级失败、要回滚、半夜。那一刻发现文档里的命令不存在，成本远高于平时。而 CLI 的命令表
// 在 `src/main.ts` 里，改名 / 删命令时**没有任何东西会提醒你还有一份文档在引用它**。
//
// 判据取「文档引用 ⊆ 真实命令」这一个方向，不反过来要求「每条命令都要写进文档」：
// 后者会逼着 runbook 变成 CLI 参考手册，而 runbook 的价值恰恰在于**只讲出事时要按的那几个键**。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const RUNBOOK = 'docs/release-upgrade-rollback.md'

/** `src/main.ts` 的命令分派表——唯一事实源。 */
function cliCommands(): Set<string> {
  const main = readFileSync(resolve(ROOT, 'packages/backend/src/main.ts'), 'utf8')
  return new Set([...main.matchAll(/case '([a-z0-9-]+)'/g)].map((m) => m[1]!))
}

/** runbook 里被当成命令引用的第一个 token（`agent-workflow <cmd>`）。 */
export function referencedCommands(markdown: string): string[] {
  return [
    ...new Set(
      [...markdown.matchAll(/agent-workflow\s+([a-z0-9-]+)/g)]
        .map((m) => m[1]!)
        // `agent-workflow-*` 是备份文件名前缀，不是命令。
        .filter((name) => name !== 'home'),
    ),
  ].sort()
}

/** 文档里引用了、但命令表里没有的那些。纯函数——扫描与自证共用同一份实现。 */
export function unknownCommands(markdown: string, commands: ReadonlySet<string>): string[] {
  return referencedCommands(markdown).filter((name) => !commands.has(name))
}

describe('运维 runbook 的命令引用', () => {
  test('runbook 里的每条命令都在 CLI 分派表里', () => {
    const markdown = readFileSync(resolve(ROOT, RUNBOOK), 'utf8')
    const referenced = referencedCommands(markdown)
    expect(referenced.length, `${RUNBOOK} 里一条命令都没扫到——判据的被测面没了`).toBeGreaterThan(5)

    const commands = cliCommands()
    expect(commands.size, 'main.ts 的命令表没解析出来').toBeGreaterThan(8)

    const missing = unknownCommands(markdown, commands)
    expect(
      missing,
      `${RUNBOOK} 引用了不存在的命令。改 CLI 时请同批改文档——这份文档是出事时才被打开的，` +
        '那一刻发现命令不存在的代价远高于现在。',
    ).toEqual([])
  })

  test('matcher 自证：伪造的失效引用必须被抓到', () => {
    // 负 fixture：判据的两端各喂一个合成样本，证明它现在还咬得动。
    // 没有这条，`toEqual([])` 在正则失配 / 命令表解析断掉时会安静地全绿。
    const fakeCommands = new Set(['start', 'stop'])
    expect(
      unknownCommands('先 `agent-workflow rollback` 再 `agent-workflow start`', fakeCommands),
      '判据认不出「文档引用了不存在的命令」了',
    ).toEqual(['rollback'])
    expect(
      unknownCommands('先 `agent-workflow stop` 再 `agent-workflow start`', fakeCommands),
      '判据把合法引用误判成失效引用了',
    ).toEqual([])
  })

  test('matcher 自证：能认出命令引用，也不把备份文件名当命令', () => {
    expect(referencedCommands('跑 `agent-workflow doctor` 再 `agent-workflow start`')).toEqual([
      'doctor',
      'start',
    ])
    // 备份文件名形如 `agent-workflow-2026-08-24.tar.gz`：连字符后面不是命令。
    expect(referencedCommands('产物 agent-workflow-2026 落在 backups/')).toEqual([])
  })
})
