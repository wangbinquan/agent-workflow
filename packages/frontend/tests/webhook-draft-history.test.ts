import { describe, expect, test } from 'vitest'

import { WebhookDraftHistory } from '../src/components/webhooks/webhookDraftHistory'

interface Draft {
  name: string
  description: string
  repaired: boolean
}

const equal = (left: Draft, right: Draft) => JSON.stringify(left) === JSON.stringify(right)

describe('WebhookDraftHistory', () => {
  test('同一字段一次 focus session 的连续输入只形成一个撤销项', () => {
    const initial = { name: 'A', description: '', repaired: false }
    const history = new WebhookDraftHistory(initial, equal)

    history.apply({ ...history.current, name: 'AB' }, { kind: 'typing', field: 'name' })
    history.apply({ ...history.current, name: 'ABC' }, { kind: 'typing', field: 'name' })
    history.commitTyping('name')

    expect(history.undo()).toEqual(initial)
    expect(history.redo()).toEqual({ ...initial, name: 'ABC' })
  })

  test('repair 与后续多字符输入各自是原子步骤，双 Undo/Redo 精确对称', () => {
    const initial = { name: 'A', description: 'orphan', repaired: false }
    const repaired = { ...initial, description: '', repaired: true }
    const history = new WebhookDraftHistory(initial, equal)

    history.apply(repaired, { kind: 'atomic' })
    history.apply({ ...history.current, name: 'AB' }, { kind: 'typing', field: 'name' })
    history.apply({ ...history.current, name: 'ABC' }, { kind: 'typing', field: 'name' })

    expect(history.undo()).toEqual(repaired)
    expect(history.undo()).toEqual(initial)
    expect(history.redo()).toEqual(repaired)
    expect(history.redo()).toEqual({ ...repaired, name: 'ABC' })
  })

  test('Undo 后的新 mutation 截断 redo，no-op 不制造历史', () => {
    const initial = { name: 'A', description: '', repaired: false }
    const history = new WebhookDraftHistory(initial, equal)

    expect(history.apply(initial, { kind: 'atomic' })).toBe(false)
    history.apply({ ...initial, repaired: true }, { kind: 'atomic' })
    expect(history.undo()).toEqual(initial)
    history.apply({ ...initial, name: 'B' }, { kind: 'atomic' })

    expect(history.canRedo).toBe(false)
    expect(history.redo()).toBeNull()
  })
})
