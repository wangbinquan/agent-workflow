// RFC-082 — lock the pure bubble-layout math extracted from
// reviews.detail.tsx into lib/review/bubbleLayout.ts. These back the RFC-009
// behaviors (header floor, collision-avoidance, orphan stacking) that the
// ReviewDocPane extraction must preserve byte-for-byte.

import { describe, expect, test } from 'vitest'
import { computeBubbleLayout, BUBBLE_GAP_PX } from '../src/lib/review/bubbleLayout'

describe('computeBubbleLayout', () => {
  test('non-overlapping bubbles keep their anchor tops', () => {
    const r = computeBubbleLayout({
      located: [
        { id: 'a', top: 0, height: 40 },
        { id: 'b', top: 200, height: 40 },
      ],
      orphans: [],
      headerFloor: 0,
      rootHeight: 500,
      gap: BUBBLE_GAP_PX,
    })
    expect(r.tops.get('a')).toBe(0)
    expect(r.tops.get('b')).toBe(200)
    // minHeight = body height (cursor 200+40+8=248 < 500)
    expect(r.minHeight).toBe(500)
  })

  test('overlapping bubbles get bumped down by height + gap', () => {
    const r = computeBubbleLayout({
      located: [
        { id: 'a', top: 0, height: 40 },
        { id: 'b', top: 10, height: 40 }, // would overlap a (a ends at 48)
        { id: 'c', top: 20, height: 40 }, // would overlap b
      ],
      orphans: [],
      headerFloor: 0,
      rootHeight: 0,
      gap: 8,
    })
    expect(r.tops.get('a')).toBe(0)
    expect(r.tops.get('b')).toBe(48) // max(10, 0+40+8)
    expect(r.tops.get('c')).toBe(96) // max(20, 48+40+8)
    expect(r.minHeight).toBe(144) // 96+40+8
  })

  test('header floor pushes the first bubble down so it never hides under the sticky header', () => {
    const r = computeBubbleLayout({
      located: [{ id: 'a', top: 0, height: 30 }],
      orphans: [],
      headerFloor: 50,
      rootHeight: 0,
      gap: 8,
    })
    expect(r.tops.get('a')).toBe(50) // max(0, 50)
  })

  test('orphans stack after the last located bubble', () => {
    const r = computeBubbleLayout({
      located: [{ id: 'a', top: 0, height: 40 }],
      orphans: [
        { id: 'x', height: 30 },
        { id: 'y', height: 30 },
      ],
      headerFloor: 0,
      rootHeight: 0,
      gap: 8,
    })
    expect(r.tops.get('a')).toBe(0)
    expect(r.tops.get('x')).toBe(48) // 0+40+8
    expect(r.tops.get('y')).toBe(86) // 48+30+8
    expect(r.minHeight).toBe(124) // 86+30+8
  })

  test('located bubbles are re-sorted by measured top (defensive against reordered anchors)', () => {
    const r = computeBubbleLayout({
      located: [
        { id: 'late', top: 300, height: 20 },
        { id: 'early', top: 100, height: 20 },
      ],
      orphans: [],
      headerFloor: 0,
      rootHeight: 0,
      gap: 8,
    })
    expect(r.tops.get('early')).toBe(100)
    expect(r.tops.get('late')).toBe(300)
  })

  test('empty input → empty tops, minHeight = rootHeight', () => {
    const r = computeBubbleLayout({
      located: [],
      orphans: [],
      headerFloor: 0,
      rootHeight: 720,
    })
    expect(r.tops.size).toBe(0)
    expect(r.minHeight).toBe(720)
  })

  // RFC-241 阶段 2 — orphanPlacement 双分支纯函数锁(design v6 §机制 2)。
  describe('orphanPlacement (RFC-241 阶段 2)', () => {
    const input = {
      located: [{ id: 'a', top: 10, height: 40 }],
      orphans: [
        { id: 'x', height: 30 },
        { id: 'y', height: 30 },
      ],
      headerFloor: 20,
      rootHeight: 0,
      gap: 8,
    }

    test("'top':orphan 从 headerFloor 起先行堆叠,located 游标从 orphan 堆之后继续", () => {
      const r = computeBubbleLayout({ ...input, orphanPlacement: 'top' })
      expect(r.tops.get('x')).toBe(20) // headerFloor
      expect(r.tops.get('y')).toBe(58) // 20+30+8
      expect(r.tops.get('a')).toBe(96) // max(10, 58+30+8)
      expect(r.minHeight).toBe(144) // 96+40+8
    })

    test("'bottom' 与缺省逐字节一致(保 ReviewDocPane 现行为)", () => {
      const explicit = computeBubbleLayout({ ...input, orphanPlacement: 'bottom' })
      const implicit = computeBubbleLayout(input)
      expect([...explicit.tops.entries()]).toEqual([...implicit.tops.entries()])
      expect(explicit.minHeight).toBe(implicit.minHeight)
      expect(implicit.tops.get('a')).toBe(20) // max(10, headerFloor)
      expect(implicit.tops.get('x')).toBe(68) // 20+40+8
      expect(implicit.tops.get('y')).toBe(106) // 68+30+8
    })

    test("'top' 且无 located:orphan 即整列,minHeight 覆盖 orphan 堆", () => {
      const r = computeBubbleLayout({
        located: [],
        orphans: [{ id: 'x', height: 30 }],
        headerFloor: 20,
        rootHeight: 0,
        gap: 8,
        orphanPlacement: 'top',
      })
      expect(r.tops.get('x')).toBe(20)
      expect(r.minHeight).toBe(58)
    })
  })
})
