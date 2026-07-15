// RFC-080 PR-B — KindSelect: the shared output-port kind control.
//   1. decompose/recompose — locale-free grammar round-trip (the core logic).
//   2. i18n drift guard (layer 3b) — every OUTPUT_KIND_UI labelKey resolves in
//      BOTH locales (a new kind without a label fails here, not at runtime).
//   3. render smoke — picking a base option emits the canonical kind.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { OUTPUT_KIND_UI, PATH_EXT_UI } from '@agent-workflow/shared'
import { decompose, recompose, KindSelect } from '../src/components/KindSelect'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

describe('KindSelect decompose / recompose (grammar round-trip)', () => {
  test('base kinds round-trip', () => {
    for (const k of ['string', 'markdown', 'signal']) {
      const d = decompose(k)
      expect(d).toMatchObject({ mode: 'guided', leafId: k, listWrap: false })
      if (d.mode === 'guided') expect(recompose(d.listWrap, d.leafId, d.ext)).toBe(k)
    }
  })

  test("'' defaults to base string", () => {
    expect(decompose('')).toMatchObject({ mode: 'guided', leafId: 'string', listWrap: false })
  })

  test('path<*> / path<md> are guided; non-builtin ext (path<json>) → advanced', () => {
    expect(decompose('path<*>')).toMatchObject({ mode: 'guided', leafId: 'path', ext: '*' })
    expect(decompose('path<md>')).toMatchObject({ mode: 'guided', leafId: 'path', ext: 'md' })
    // Only the built-in PATH_EXT_UI exts (* / md) drive the guided ext dropdown.
    // path<json> still round-trips, but via the advanced raw-text field until
    // 'json' is promoted into the catalog; recompose builds it verbatim.
    expect(decompose('path<json>').mode).toBe('advanced')
    expect(recompose(false, 'path', 'json')).toBe('path<json>')
    expect(recompose(false, 'path', '')).toBe('path<*>')
  })

  test('markdown_file folds to path<md> on read', () => {
    expect(decompose('markdown_file')).toMatchObject({ mode: 'guided', leafId: 'path', ext: 'md' })
  })

  test('list<base> and list<path<md>>', () => {
    expect(decompose('list<string>')).toMatchObject({
      mode: 'guided',
      leafId: 'string',
      listWrap: true,
    })
    expect(decompose('list<path<md>>')).toMatchObject({
      mode: 'guided',
      leafId: 'path',
      ext: 'md',
      listWrap: true,
    })
    expect(recompose(true, 'path', 'md')).toBe('list<path<md>>')
    expect(recompose(true, 'string', '*')).toBe('list<string>')
  })

  test('nested list<list<…>> and garbage → advanced', () => {
    expect(decompose('list<list<string>>').mode).toBe('advanced')
    expect(decompose('not a kind <<<').mode).toBe('advanced')
  })
})

describe('RFC-080 drift guard 3b — OUTPUT_KIND_UI labels resolve in both locales', () => {
  function resolve(obj: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((o, k) => {
      if (o !== null && typeof o === 'object' && k in (o as Record<string, unknown>)) {
        return (o as Record<string, unknown>)[k]
      }
      return undefined
    }, obj)
  }
  for (const d of OUTPUT_KIND_UI) {
    test(`${d.id}: label + description present in en-US + zh-CN`, () => {
      expect(typeof resolve(enUS, d.labelKey)).toBe('string')
      expect(typeof resolve(zhCN, d.labelKey)).toBe('string')
      expect(typeof resolve(enUS, d.descriptionKey)).toBe('string')
      expect(typeof resolve(zhCN, d.descriptionKey)).toBe('string')
    })
  }
  // The path ext sub-dropdown (PATH_EXT_UI) + its aria-label must also resolve.
  for (const e of PATH_EXT_UI) {
    test(`path ext '${e.ext}': ${e.labelKey} present in en-US + zh-CN`, () => {
      expect(typeof resolve(enUS, e.labelKey)).toBe('string')
      expect(typeof resolve(zhCN, e.labelKey)).toBe('string')
    })
  }
  test('kindSelect.extLabel present in en-US + zh-CN', () => {
    expect(typeof resolve(enUS, 'kindSelect.extLabel')).toBe('string')
    expect(typeof resolve(zhCN, 'kindSelect.extLabel')).toBe('string')
  })
})

describe('KindSelect render smoke', () => {
  // Test env defaults to en-US (happy-dom navigator), like agent-form-role.test.

  test('picking a base option emits the canonical kind', () => {
    const onChange = vi.fn<(k: string) => void>()
    render(<KindSelect value="string" onChange={onChange} ariaLabel="Output kind" />)
    const trigger = screen.getByRole('combobox', { name: 'Output kind' })
    fireEvent.click(trigger)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').toLowerCase().includes('markdown'),
    )
    expect(opt).toBeDefined()
    fireEvent.mouseDown(opt!)
    expect(onChange).toHaveBeenCalledWith('markdown')
  })

  test('base options render their catalog descriptions', () => {
    render(<KindSelect value="string" onChange={() => {}} ariaLabel="Output kind" />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Output kind' }))
    expect(document.querySelectorAll('.select__option-sub')).toHaveLength(OUTPUT_KIND_UI.length)
  })

  test('a list<path<md>> value renders a list toggle that is on + a path ext dropdown on Markdown', () => {
    render(
      <KindSelect
        value="list<path<md>>"
        onChange={vi.fn()}
        ariaLabel="Output kind"
        testidPrefix="k"
      />,
    )
    // list toggle (Switch) is checked.
    expect(screen.getByLabelText('list')).toBeTruthy()
    // path ext is now a Select (its trigger shows the Markdown (.md) label),
    // a second combobox distinct from the base-kind one.
    const extTrigger = screen.getByRole('combobox', { name: 'file extension' })
    expect((extTrigger.textContent ?? '').toLowerCase()).toContain('markdown')
  })

  test('picking md from the path ext dropdown emits path<md> (the review-ready kind)', () => {
    const onChange = vi.fn<(k: string) => void>()
    // Selecting the generic "file path" lands on path<*>; the ext dropdown is
    // how the user reaches the markdown-file kind that review nodes accept.
    render(<KindSelect value="path<*>" onChange={onChange} ariaLabel="Output kind" />)
    const extTrigger = screen.getByRole('combobox', { name: 'file extension' })
    fireEvent.click(extTrigger)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').toLowerCase().includes('markdown'),
    )
    expect(opt).toBeDefined()
    fireEvent.mouseDown(opt!)
    expect(onChange).toHaveBeenCalledWith('path<md>')
  })

  test('contextLabel distinguishes every repeated guided control and className reaches the wrapper', () => {
    render(
      <KindSelect
        value="path<md>"
        onChange={() => {}}
        className="port-kind"
        contextLabel="artifact"
      />,
    )

    const wrapper = document.querySelector('.kind-select')
    expect(wrapper?.classList.contains('port-kind')).toBe(true)
    expect(
      screen.getByRole('combobox', {
        name: `artifact — ${enUS.kindSelect.baseLabel}`,
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('combobox', {
        name: `artifact — ${enUS.kindSelect.extLabel}`,
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('checkbox', {
        name: `artifact — ${enUS.kindSelect.listToggle}`,
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: `artifact — ${enUS.kindSelect.advancedToggle}`,
      }),
    ).toBeTruthy()
  })

  test('onValidityChange reports transitions once; advanced input solely owns its parse error', async () => {
    const validity = vi.fn<(valid: boolean) => void>()

    function Probe() {
      const [value, setValue] = useState('string')
      return (
        <KindSelect
          value={value}
          onChange={setValue}
          onValidityChange={validity}
          contextLabel="report"
          className="port-kind"
          testidPrefix="k"
        />
      )
    }

    render(<Probe />)
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true))
    fireEvent.click(
      screen.getByRole('button', {
        name: `report — ${enUS.kindSelect.advancedToggle}`,
      }),
    )

    const input = screen.getByTestId('k-advanced-input')
    expect(document.querySelector('.kind-select')?.className).toContain(
      'kind-select--advanced port-kind',
    )
    fireEvent.change(input, { target: { value: 'not a kind' } })
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false))

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(alerts[0]?.id)

    fireEvent.change(input, { target: { value: 'list<path<md>>' } })
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: `report — ${enUS.kindSelect.guidedToggle}`,
      }),
    )
    expect(
      screen.getByRole('combobox', {
        name: `report — ${enUS.kindSelect.baseLabel}`,
      }),
    ).toBeTruthy()
    expect(validity.mock.calls.map(([valid]) => valid)).toEqual([true, false, true])
  })

  test('Advanced to Guided realigns the keyboard active option with the current value', async () => {
    const changes = vi.fn<(value: string) => void>()

    function Probe() {
      const [value, setValue] = useState('string')
      return (
        <KindSelect
          value={value}
          onChange={(next) => {
            changes(next)
            setValue(next)
          }}
          ariaLabel="Output kind"
          testidPrefix="guided-realign"
        />
      )
    }

    render(<Probe />)
    fireEvent.click(screen.getByRole('button', { name: enUS.kindSelect.advancedToggle }))
    fireEvent.change(screen.getByTestId('guided-realign-advanced-input'), {
      target: { value: 'markdown' },
    })
    fireEvent.click(screen.getByRole('button', { name: enUS.kindSelect.guidedToggle }))

    const trigger = screen.getByRole('combobox', { name: 'Output kind' })
    expect(trigger.textContent).toContain('markdown')
    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'Enter' })

    expect(changes.mock.calls.map(([value]) => value)).toEqual(['markdown', 'markdown'])
  })
})
