// RFC-239 T5 — ChangeNarrative schema: lenient on model-authored collections
// (malformed group / reading-order entries are DROPPED, not fatal), strict on
// the overview (a narrative without one has nothing to render and must reject
// so the service never persists a husk).

import { describe, expect, test } from 'bun:test'
import { changeNarrativeSchema, changeNarrativeStatusSchema } from '../src/schemas/changeNarrative'

const BASE = {
  version: 1,
  overview: '新增贪吃蛇游戏的完整实现,UI 与引擎分层清晰。',
  groups: [{ key: 'repo:main/mod:ui', summary: 'Swing 绘制层:窗口、菜单与画布渲染。' }],
  readingOrder: [{ ref: 'src/snakegame/SnakeGame.java', why: '程序入口,先看装配。' }],
  generatedAt: 1_788_200_000_000,
  inputDigest: 'deadbeefdeadbeef',
}

describe('RFC-239 change narrative schema', () => {
  test('well-formed document round-trips', () => {
    const n = changeNarrativeSchema.parse(BASE)
    expect(n.groups).toHaveLength(1)
    expect(n.readingOrder[0]?.ref).toBe('src/snakegame/SnakeGame.java')
  })

  test('malformed group/readingOrder entries are dropped, valid ones kept', () => {
    const n = changeNarrativeSchema.parse({
      ...BASE,
      groups: [
        { key: 'docs', summary: '文档组说明。' },
        { key: '', summary: 'bad: empty key' },
        { summary: 'bad: no key' },
        'not-an-object',
        42,
      ],
      readingOrder: [{ ref: 'docs', why: '先读文档。' }, { ref: 'x' }, null],
    })
    expect(n.groups).toEqual([{ key: 'docs', summary: '文档组说明。' }])
    expect(n.readingOrder).toEqual([{ ref: 'docs', why: '先读文档。' }])
  })

  test('missing/empty overview rejects; unknown extra fields are tolerated', () => {
    expect(() => changeNarrativeSchema.parse({ ...BASE, overview: '' })).toThrow()
    const { overview: _drop, ...rest } = BASE
    expect(() => changeNarrativeSchema.parse(rest)).toThrow()
    const n = changeNarrativeSchema.parse({ ...BASE, futureField: 'ignored' })
    expect(n.overview).toBe(BASE.overview)
  })

  test('status union parses all three arms and rejects unknown status', () => {
    expect(changeNarrativeStatusSchema.parse({ status: 'ready', narrative: BASE }).status).toBe(
      'ready',
    )
    expect(changeNarrativeStatusSchema.parse({ status: 'generating', startedAt: 1 }).status).toBe(
      'generating',
    )
    expect(changeNarrativeStatusSchema.parse({ status: 'failed', message: 'x' }).status).toBe(
      'failed',
    )
    expect(() => changeNarrativeStatusSchema.parse({ status: 'other' })).toThrow()
  })
})
