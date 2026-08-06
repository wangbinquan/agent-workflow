// RFC-261 — Pagination 公共组件单测：nav 角色与 aria、禁用边界（首页/末页/单页/
// 整体 disabled）、onPageChange 目标页码。该组件是服务端 offset 分页列表面的
// 公共原语（首个消费者：webhook 投递审计面板）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import i18n from '../src/i18n'
import { Pagination } from '../src/components/Pagination'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(cleanup)

function btn(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

describe('RFC-261 · Pagination', () => {
  test('nav 角色 + 「第 x / y 页」文案', () => {
    render(<Pagination page={2} pageCount={5} onPageChange={() => {}} />)
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy()
    expect(screen.getByText('Page 2 of 5')).toBeTruthy()
  })

  test('禁用边界：首页禁上一页、末页禁下一页、单页双禁、disabled 全禁', () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={() => {}} />)
    expect(btn('Previous').disabled).toBe(true)
    expect(btn('Next').disabled).toBe(false)
    rerender(<Pagination page={3} pageCount={3} onPageChange={() => {}} />)
    expect(btn('Previous').disabled).toBe(false)
    expect(btn('Next').disabled).toBe(true)
    rerender(<Pagination page={1} pageCount={1} onPageChange={() => {}} />)
    expect(btn('Previous').disabled).toBe(true)
    expect(btn('Next').disabled).toBe(true)
    rerender(<Pagination page={2} pageCount={3} disabled onPageChange={() => {}} />)
    expect(btn('Previous').disabled).toBe(true)
    expect(btn('Next').disabled).toBe(true)
  })

  test('onPageChange 携带目标页码', () => {
    const calls: number[] = []
    render(<Pagination page={2} pageCount={5} onPageChange={(page) => calls.push(page)} />)
    fireEvent.click(btn('Previous'))
    fireEvent.click(btn('Next'))
    expect(calls).toEqual([1, 3])
  })
})
