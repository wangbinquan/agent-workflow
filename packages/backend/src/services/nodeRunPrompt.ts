// RFC-311 T21 —— node_run prompt 正文的**唯一**读写点。
//
// 审计实测 `node_runs` 平均每行 ~10.5KB，其中 prompt_text 平均 ~6KB、占该表 57%；
// 而它的读点只有任务详情的 Prompt 页与会话视图——属于「点开才看」的内容，却让每一
// 次按 node_run 取行都跟着读溢出页。
//
// 形态（design §7.2）：新行把正文写进 `runs/{taskId}/{nodeRunId}/prompt.md` 并只存
// 路径；旧行保持 `prompt_text` 原样、**不回填**。读点双读，两种形态永久共存，没有
// 切换窗口，也就没有「切换期间读错」的那类事故。
//
// 失败模式：文件写不出去（磁盘满/权限）时**回落到写列**——prompt 是执行事实的一
// 部分，宁可让这一行胖一点，也不能因为落盘失败就把它丢了。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('node-run-prompt')

/**
 * 相对 `runs/` 的路径——存相对值，整个 home 目录可以整体搬走（备份恢复到别的机器
 * 后仍读得到；存绝对路径就做不到这一点）。
 *
 * **刻意不放在 `runs/{taskId}/{nodeRunId}/` 里**：那是 runner 的每轮临时工作目录，
 * 运行结束会被 `rmSync(runRoot)` 整个删掉（runner.ts 的既有清理契约）。design §7.2
 * 当初写的就是那个位置，实测后改到 `runs/{taskId}/prompts/{nodeRunId}.md`——它在
 * 同一棵 `runs/{taskId}/` 下（所以任务归档挪目录时照样一起走），但不在被清理的
 * 那一层。
 */
export function nodeRunPromptRelPath(taskId: string, nodeRunId: string): string {
  return join(taskId, 'prompts', `${nodeRunId}.md`)
}

export interface PromptStorage {
  promptText: string | null
  promptPath: string | null
}

/**
 * 落盘 prompt，返回该写进哪两列。成功 ⇒ `{promptText: null, promptPath: rel}`；
 * 失败 ⇒ 回落成旧形态 `{promptText: prompt, promptPath: null}`。
 */
/**
 * 小于这个尺寸就**留在列里**。收益全在长尾:审计实测均值 ~6KB、占 node_runs 表
 * 57%,而把一条 200 字节的 prompt 落成一个文件既省不了空间,又平白多一个「文件可能
 * 不在」的失败面。SQLite 自己对溢出页也是同一套判据——超过阈值才外置。
 */
const PROMPT_SPILL_MIN_BYTES = 4_096

export function storeNodeRunPrompt(
  taskId: string,
  nodeRunId: string,
  prompt: string,
  runsDir: string = Paths.runsDir,
): PromptStorage {
  if (Buffer.byteLength(prompt, 'utf-8') < PROMPT_SPILL_MIN_BYTES) {
    return { promptText: prompt, promptPath: null }
  }
  const rel = nodeRunPromptRelPath(taskId, nodeRunId)
  const abs = join(runsDir, rel)
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, prompt, 'utf-8')
    return { promptText: null, promptPath: rel }
  } catch (err) {
    log.warn('prompt spill failed; keeping it in the row', {
      nodeRunId,
      error: (err as Error).message,
    })
    return { promptText: prompt, promptPath: null }
  }
}

/**
 * 双读。列有值就是旧行；否则按路径读文件。文件缺失（被 GC / 手工删掉 / 归档挪走）
 * 返回 null 而不是抛——Prompt 页显示「不可用」远好于整页 500。
 */
export function readNodeRunPrompt(
  /** 允许 null/undefined:取不到的行自然没有 prompt,调用点不必各写一遍判空。 */
  row: { promptText: string | null; promptPath: string | null } | null | undefined,
  runsDir: string = Paths.runsDir,
): string | null {
  if (row === null || row === undefined) return null
  if (row.promptText !== null) return row.promptText
  if (row.promptPath === null) return null
  const abs = join(runsDir, row.promptPath)
  if (!existsSync(abs)) return null
  try {
    return readFileSync(abs, 'utf-8')
  } catch (err) {
    log.warn('prompt file unreadable', { path: row.promptPath, error: (err as Error).message })
    return null
  }
}
