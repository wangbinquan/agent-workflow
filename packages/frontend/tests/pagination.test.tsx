// RFC-261 — Pagination 公共组件单测：nav 角色与 aria、禁用边界（首页/末页/单页/
// 整体 disabled）、onPageChange 目标页码、直接跳页与越界钳制。该组件是服务端
// offset 分页列表面的公共原语（首个消费者：webhook 投递审计面板）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toBeTruthy()
    expect(btn('Go to page')).toBeTruthy()
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
    expect(
      (screen.getByRole('spinbutton', { name: 'Page number' }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect(btn('Go to page').disabled).toBe(true)
    rerender(<Pagination page={2} pageCount={3} disabled onPageChange={() => {}} />)
    expect(btn('Previous').disabled).toBe(true)
    expect(btn('Next').disabled).toBe(true)
    expect(
      (screen.getByRole('spinbutton', { name: 'Page number' }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect(btn('Go to page').disabled).toBe(true)
  })

  test('onPageChange 携带目标页码', () => {
    const calls: number[] = []
    render(<Pagination page={2} pageCount={5} onPageChange={(page) => calls.push(page)} />)
    fireEvent.click(btn('Previous'))
    fireEvent.click(btn('Next'))
    expect(calls).toEqual([1, 3])
  })

  test('直接跳页：表单提交携带指定页，越界值钳制到首末页', () => {
    const calls: number[] = []
    const { rerender } = render(
      <Pagination page={2} pageCount={500} onPageChange={(page) => calls.push(page)} />,
    )
    const input = screen.getByRole('spinbutton', { name: 'Page number' }) as HTMLInputElement
    const form = input.closest('form')
    expect(form).not.toBeNull()
    const select = vi.spyOn(input, 'select')
    fireEvent.focus(input)
    expect(select).toHaveBeenCalledOnce()

    fireEvent.change(input, { target: { value: '237' } })
    fireEvent.submit(form!)
    expect(calls).toEqual([237])

    rerender(<Pagination page={237} pageCount={500} onPageChange={(page) => calls.push(page)} />)
    expect(
      (screen.getByRole('spinbutton', { name: 'Page number' }) as HTMLInputElement).value,
    ).toBe('237')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Page number' }), {
      target: { value: '999' },
    })
    fireEvent.click(btn('Go to page'))
    expect(calls).toEqual([237, 500])

    rerender(<Pagination page={500} pageCount={500} onPageChange={(page) => calls.push(page)} />)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Page number' }), {
      target: { value: '0' },
    })
    fireEvent.click(btn('Go to page'))
    expect(calls).toEqual([237, 500, 1])
  })

  test('直接跳页：空值或小数不发起翻页，并恢复当前页码', () => {
    const calls: number[] = []
    render(<Pagination page={12} pageCount={50} onPageChange={(page) => calls.push(page)} />)
    const input = screen.getByRole('spinbutton', { name: 'Page number' }) as HTMLInputElement

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(btn('Go to page'))
    expect(calls).toEqual([])
    expect(input.value).toBe('12')

    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.click(btn('Go to page'))
    expect(calls).toEqual([])
    expect(input.value).toBe('12')
  })
})
