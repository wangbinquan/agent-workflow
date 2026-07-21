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
  MAX_AGENT_TEXT_CHARS,
  MAX_STREAM_LINE_CHARS,
  pumpLines,
} from '../src/services/runner'

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

describe('pumpLines per-line bound (B4-runtime-6)', () => {
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
