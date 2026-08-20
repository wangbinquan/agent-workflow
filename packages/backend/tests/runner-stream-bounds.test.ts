// design/test-guard-audit-2026-07-21 gap B4-runtime-6 (Top-14) — a runaway or
// hostile child's stdout must not OOM the shared daemon.
//
// Two unbounded vectors are bounded here:
//   1. pumpLines' line buffer — a child emitting megabytes with NO newline grew
//      it without limit (and then handed the whole monster line to a DB insert).
//   2. the agent-text accumulator the envelope is parsed from — millions of
//      small lines grew an unbounded string.
//
// Both are exercised through the exported primitives so the bound is pinpointed
// at the source, not diagnosed through a full node run.

import { describe, expect, test } from 'bun:test'
import {
  appendBoundedTail,
  clampTailLine,
  MAX_AGENT_TEXT_CHARS,
  MAX_STDERR_TAIL_CHARS,
  MAX_STDERR_TAIL_LINE_CHARS,
  MAX_STREAM_LINE_CHARS,
} from '../src/services/runner'
// RFC-282 E1a — the runner's `pumpLines` twin was src-dead (every stream goes
// through the unified executor since RFC-280) and had drifted on the
// truncation marker; the bound lock now pins the ONE pump in managedProcess.
// Behavior deltas taken over from the live implementation (registered §7):
// the marker text is '…[line truncated]' and a truncated line ALSO fires
// onLineTruncated. Everything else asserts unchanged.
import { pump } from '../src/services/execution/managedProcess'

const pumpLines = (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
) => pump(stream, onLine, undefined)

/** A ReadableStream that emits the given UTF-8 chunks then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!))
        i += 1
      } else {
        controller.close()
      }
    },
  })
}

describe('managedProcess pump per-line bound (B4-runtime-6; E1a lock migration)', () => {
  test('normal newline-delimited lines pass through unchanged', async () => {
    const seen: string[] = []
    await pumpLines(streamOf(['a\nb\n', 'c\n']), (l) => {
      seen.push(l)
    }).done
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  test('a monster line with no newline is truncated, not buffered without limit', async () => {
    const seen: string[] = []
    // 3x the cap of a single 'x' run, no newline anywhere.
    const monster = 'x'.repeat(MAX_STREAM_LINE_CHARS * 3)
    await pumpLines(streamOf([monster]), (l) => {
      seen.push(l)
    }).done
    // Exactly one flushed line, capped in size, with the truncation marker.
    expect(seen.length).toBe(1)
    expect(seen[0]!.length).toBeLessThanOrEqual(MAX_STREAM_LINE_CHARS + 64)
    expect(seen[0]!).toContain('line truncated')
  })

  test('parsing resumes on the next newline after a truncated monster line', async () => {
    const seen: string[] = []
    const monster = 'x'.repeat(MAX_STREAM_LINE_CHARS * 2)
    // monster (no newline) … then a newline ends it, then a normal line.
    await pumpLines(streamOf([monster, 'STILLMONSTER\nnormal\n']), (l) => {
      seen.push(l)
    }).done
    // First: the truncated marker for the monster. The 'STILLMONSTER' tail is
    // discarded (it belongs to the same over-long line). Then 'normal'.
    expect(seen[0]!).toContain('line truncated')
    expect(seen).toContain('normal')
    // The discarded tail must NOT surface as its own line.
    expect(seen.some((l) => l.includes('STILLMONSTER'))).toBe(false)
  })

  test('a no-newline tail under the cap is still flushed at EOF', async () => {
    const seen: string[] = []
    await pumpLines(streamOf(['partial-no-newline']), (l) => {
      seen.push(l)
    }).done
    expect(seen).toEqual(['partial-no-newline'])
  })
})

describe('appendBoundedTail — rolling agent-text cap (B4-runtime-6)', () => {
  test('keeps everything while under the cap', () => {
    let buf = ''
    buf = appendBoundedTail(buf, 'first', MAX_AGENT_TEXT_CHARS)
    buf = appendBoundedTail(buf, 'second', MAX_AGENT_TEXT_CHARS)
    expect(buf).toBe('first\nsecond')
  })

  test('bounds memory and PRESERVES THE TAIL (the winning envelope is last)', () => {
    const cap = 1000
    let buf = ''
    // Push far more than 2x the cap in small pieces.
    for (let i = 0; i < 10_000; i += 1) buf = appendBoundedTail(buf, `line-${i}`, cap)
    // Never exceeds 2x the cap (the slice threshold).
    expect(buf.length).toBeLessThanOrEqual(2 * cap)
    // The most recent content survived — an envelope appended last is intact.
    buf = appendBoundedTail(buf, '<workflow-output>ENVELOPE</workflow-output>', cap)
    expect(buf).toContain('<workflow-output>ENVELOPE</workflow-output>')
    // …while the very first line has been evicted.
    expect(buf).not.toContain('line-0\n')
  })

  test('the production cap leaves ample room for a realistic envelope', () => {
    // 8 MiB dwarfs any real <workflow-output> block.
    expect(MAX_AGENT_TEXT_CHARS).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

// RFC-310 T132 后续 —— 2026-08-20 windows CI 实撞：stderr 尾巴拿到手了，里面却全是
// 压缩过的 minified 源码片段，真正的 error 消息一个字都没有。原因是 bundle 的源码行
// 是**单行几十 KB**，只按总长度取尾巴时它一行就把窗口占满、把写在最前面的错因整个挤
// 出去——「有尾巴」于是等于「仍然不可归因」，白改一轮。
// 这组用例锁的就是那次的形状：逐行先裁头，长行不得吃掉后续行的位置。
describe('clampTailLine — 单行不得吃掉整个 stderr 尾巴窗口', () => {
  test('short lines pass through byte-for-byte', () => {
    expect(clampTailLine('error: ENOENT no such file or directory')).toBe(
      'error: ENOENT no such file or directory',
    )
  })

  test('a long line keeps its HEAD (the cause is written first) and says how much was dropped', () => {
    const line = `error: boom${'x'.repeat(5_000)}`
    const clamped = clampTailLine(line)
    expect(clamped.startsWith('error: boom')).toBe(true)
    expect(clamped.length).toBeLessThan(MAX_STDERR_TAIL_LINE_CHARS + 32)
    expect(clamped).toContain('chars)')
  })

  test('a minified source line cannot evict the error message that preceded it', () => {
    // 复刻实撞形状：第 1 行是错因，第 2 行是 40KB 的 bundle 源码行。
    let buf = ''
    for (const line of [
      'error: Cannot find module "node:foo"',
      `var J=1,$=2;${'q'.repeat(40_000)}`,
      '      at <anonymous> (stub.js:1:1)',
    ]) {
      buf = appendBoundedTail(buf, clampTailLine(line), MAX_STDERR_TAIL_CHARS)
    }
    expect(buf).toContain('error: Cannot find module "node:foo"')
    expect(buf).toContain('at <anonymous>')
    expect(buf.length).toBeLessThanOrEqual(2 * MAX_STDERR_TAIL_CHARS)
  })
})
