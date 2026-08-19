// RFC-311 T21 —— node_run prompt 正文外置到文件 + 读点双读。
//
// 审计实测:`node_runs` 平均每行 ~10.5KB,其中 prompt_text 平均 ~6KB、占该表 57%,
// 而它只在详情页 Prompt 面板与会话视图被读——「点开才看」的内容却让每一次按
// node_run 取行都跟着读溢出页。
//
// 锁四件事(前两条是功能,后两条是它**不能**做的事):
//   1. 新行:正文落 `runs/{taskId}/{nodeRunId}/prompt.md`,行里只留相对路径;
//   2. 双读:新行从文件还原、**旧行(列里有值)照常返回**——不回填意味着两种形态
//      永久共存,读点必须同时认;
//   3. 落盘失败(目录不可写)**回落成写列**,而不是把 prompt 丢掉;
//   4. 文件缺失(被清理/归档挪走)返回 null,而不是抛——Prompt 面板显示「不可用」
//      远好于整页 500。

import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import {
  nodeRunPromptRelPath,
  readNodeRunPrompt,
  storeNodeRunPrompt,
} from '../src/services/nodeRunPrompt'

describe('RFC-311 T21 — node_run prompt spill', () => {
  test('a large prompt spills to a file and reads back through the dual read', () => {
    const runs = mkdtempSync(join(tmpdir(), 'aw-rfc311-prompt-'))
    try {
      // 阈值以上才外置(见 PROMPT_SPILL_MIN_BYTES 的理由)。
      const prompt = 'analyse the diff\n'.repeat(500)
      const stored = storeNodeRunPrompt('task-1', 'run-1', prompt, runs)

      // 行里不再带正文,只带路径。
      expect(stored.promptText).toBeNull()
      expect(stored.promptPath).toBe(nodeRunPromptRelPath('task-1', 'run-1'))
      const abs = join(runs, stored.promptPath!)
      expect(existsSync(abs)).toBe(true)
      expect(readFileSync(abs, 'utf-8')).toBe(prompt)

      expect(readNodeRunPrompt(stored, runs)).toBe(prompt)
    } finally {
      rmSync(runs, { recursive: true, force: true })
    }
  })

  test('a small prompt stays in the column — spilling it would cost a file and save nothing', () => {
    const runs = mkdtempSync(join(tmpdir(), 'aw-rfc311-prompt-'))
    try {
      const small = 'do the thing'
      const stored = storeNodeRunPrompt('task-s', 'run-s', small, runs)
      expect(stored.promptText).toBe(small)
      expect(stored.promptPath).toBeNull()
      expect(readNodeRunPrompt(stored, runs)).toBe(small)
      expect(existsSync(join(runs, 'task-s'))).toBe(false)
    } finally {
      rmSync(runs, { recursive: true, force: true })
    }
  })

  test('legacy rows keep working — the column wins when it has a value', () => {
    const runs = mkdtempSync(join(tmpdir(), 'aw-rfc311-prompt-'))
    try {
      // 旧行:列里有正文、没有路径。不回填是刻意的,所以这条形态必须永久可读。
      expect(readNodeRunPrompt({ promptText: 'legacy body', promptPath: null }, runs)).toBe(
        'legacy body',
      )
      // 两者都有时以列为准(理论上不会同时出现,但读点不该在这种行上说谎)。
      const stored = storeNodeRunPrompt('t', 'r', 'from file '.repeat(500), runs)
      expect(
        readNodeRunPrompt({ promptText: 'from column', promptPath: stored.promptPath }, runs),
      ).toBe('from column')
    } finally {
      rmSync(runs, { recursive: true, force: true })
    }
  })

  test('a spill failure falls back to the column instead of losing the prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc311-prompt-ro-'))
    const runs = join(root, 'runs')
    mkdirSync(runs)
    try {
      // 只读目录 ⇒ mkdir/write 必失败。prompt 是执行事实,宁可让这一行胖一点。
      chmodSync(runs, 0o500)
      const stored = storeNodeRunPrompt('task-x', 'run-x', 'must survive '.repeat(500), runs)
      expect(stored.promptPath).toBeNull()
      expect(stored.promptText).toBe('must survive '.repeat(500))
      expect(readNodeRunPrompt(stored, runs)).toBe('must survive '.repeat(500))
    } finally {
      chmodSync(runs, 0o700)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing file degrades to null rather than throwing', () => {
    const runs = mkdtempSync(join(tmpdir(), 'aw-rfc311-prompt-'))
    try {
      const stored = storeNodeRunPrompt('task-2', 'run-2', 'body '.repeat(1000), runs)
      rmSync(join(runs, stored.promptPath!))
      expect(readNodeRunPrompt(stored, runs)).toBeNull()
      // 路径为空的空行同样不该抛。
      expect(readNodeRunPrompt({ promptText: null, promptPath: null }, runs)).toBeNull()
    } finally {
      rmSync(runs, { recursive: true, force: true })
    }
  })
})

// 外置之后,**直接读 `nodeRuns.promptText` 的生产代码会静默拿到 null**——新行的
// 正文在文件里。没有守卫的话,下一个人加个读点、本地拿旧行测一测就绿了,上线才
// 发现 Prompt 面板空白。
//
// 判据放在**文件级**而不是行级:凡是引用了 `nodeRuns` 表、又读 `.promptText` 的
// 生产文件,必须导入 `readNodeRunPrompt`。行级正则试过,会把三类东西误判——MCP
// 运行测试的**同名字段**(那是另一张表,不引用 nodeRuns)、注释、以及已经过双读
// 解析的值(`inlineSiblings[0].promptText`)。文件级判据对「新加的读点」同样
// fail-closed,而误判为零。
describe('RFC-311 T21 — 生产代码只能通过双读拿 prompt', () => {
  test('the promptText column is only ever selected, never consumed as the body', () => {
    const srcDir = resolve(import.meta.dir, '..', 'src')
    const offenders: string[] = []
    let scanned = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        if (full.endsWith(join('services', 'nodeRunPrompt.ts'))) continue
        const text = readFileSync(full, 'utf-8')
        scanned += 1
        // MCP 运行测试的轮次表有**同名字段**,那是另一张表,与本条无关。
        if (!/\bnodeRuns\b/.test(text)) continue
        for (const [i, line] of text.split('\n').entries()) {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
          // 允许:`promptText: nodeRuns.promptText`(把列取回来交给双读)。
          if (/promptText:\s*nodeRuns\.promptText/.test(line)) continue
          if (/\.promptText\b/.test(line)) {
            offenders.push(`${relative(srcDir, full)}:${i + 1}  ${trimmed}`)
          }
        }
      }
    }
    walk(srcDir)
    // 失败关闭:扫描面本身要有下界,否则「没找到违规」和「没扫到文件」同形。
    expect(scanned).toBeGreaterThan(200)
    expect(
      offenders,
      `这些行把 node_run 的 promptText **列**当正文用了。新行的正文在文件里、列是\n` +
        `null,必须改走 readNodeRunPrompt();已解析的值请用别的字段名(见 sessionView\n` +
        `的 promptBody),让两者在类型层就分得开:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
