// RFC-151 PR-1 — McpFields joins the RFC-150 <Segmented> adoption set.
//
// The MCP form's two mode pickers (type local/remote, oauthMode auto/disabled)
// were the last hand-rolled `role="radiogroup"` + native-radio chip-rows in a
// form (a direct RFC-150 adoption debt; CLAUDE.md bans bespoke radio groups).
// Locks:
//   1. both pickers render the shared <Segmented> (.segmented radiogroup DOM),
//   2. change semantics survive the swap (click fires the form onChange),
//   3. nameLocked → the TYPE picker is disabled, the oauth picker is NOT
//      (oauth mode stays editable on /mcps/$name; type is create-only),
//   4. source-level: no native radio / chip-row markup may sneak back in.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { McpFields } from '../src/components/McpFields'
import { EMPTY_LOCAL_FORM, type McpFormState } from '../src/lib/mcp-form'

function mount(overrides: Partial<McpFormState> = {}, nameLocked = false) {
  const onChange = vi.fn<(next: McpFormState) => void>()
  const value: McpFormState = { ...EMPTY_LOCAL_FORM, ...overrides }
  render(<McpFields value={value} onChange={onChange} nameLocked={nameLocked} errors={{}} />)
  return { onChange, value }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('McpFields — type picker is the shared <Segmented>', () => {
  test('renders a .segmented radiogroup with the two type options', () => {
    mount()
    const group = screen.getByRole('radiogroup', { name: 'Type' })
    expect(group.className).toContain('segmented')
    const local = screen.getByRole('radio', { name: 'Local (stdio)' })
    const remote = screen.getByRole('radio', { name: 'Remote (http / sse)' })
    expect(local.getAttribute('aria-checked')).toBe('true')
    expect(remote.getAttribute('aria-checked')).toBe('false')
  })

  test('clicking Remote flips form.type via onChange', () => {
    const { onChange, value } = mount()
    fireEvent.click(screen.getByRole('radio', { name: 'Remote (http / sse)' }))
    expect(onChange).toHaveBeenCalledWith({ ...value, type: 'remote' })
  })

  test('nameLocked disables the type options (type is create-only)', () => {
    const { onChange } = mount({}, true)
    const remote = screen.getByRole('radio', { name: 'Remote (http / sse)' }) as HTMLButtonElement
    expect(remote.disabled).toBe(true)
    fireEvent.click(remote)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('McpFields — oauthMode picker is the shared <Segmented>', () => {
  test('remote form renders the oauth radiogroup; clicking false sets disabled mode', () => {
    const { onChange, value } = mount({ type: 'remote' })
    const group = screen.getByRole('radiogroup', { name: 'OAuth' })
    expect(group.className).toContain('segmented')
    fireEvent.click(screen.getByRole('radio', { name: 'false' }))
    expect(onChange).toHaveBeenCalledWith({ ...value, oauthMode: 'disabled' })
  })

  test('nameLocked does NOT disable the oauth picker (mode stays editable on edit)', () => {
    const { onChange, value } = mount({ type: 'remote' }, true)
    const off = screen.getByRole('radio', { name: 'false' }) as HTMLButtonElement
    expect(off.disabled).toBe(false)
    fireEvent.click(off)
    expect(onChange).toHaveBeenCalledWith({ ...value, oauthMode: 'disabled' })
  })
})

describe('McpFields — segmented adoption grep lock', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'components', 'McpFields.tsx'), 'utf8')

  test('renders the shared <Segmented> primitive', () => {
    expect(src).toContain("import { Segmented } from './Segmented'")
    expect(src).toContain('<Segmented')
  })

  test('no hand-rolled radiogroup / native radio / chip-row remains', () => {
    expect(src.includes('role="radiogroup"'), 'hand-rolled role="radiogroup"').toBe(false)
    expect(src.includes('type="radio"'), 'native <input type="radio">').toBe(false)
    expect(src.includes('chip-row'), 'legacy chip-row markup').toBe(false)
  })
})
