// RFC-150 PR-1 — <Segmented> primitive contract lock.
//
// Locks the radiogroup/radio/aria-checked DOM shape (byte-compatible with the
// pre-RFC hand-rolled `.segmented` controls), radio no-op-on-active-click
// semantics, disabled behavior, kbd shortcut slot, data-* passthrough, the
// ChipsInput-style testidPrefix derivation (+ explicit testid overrides) and
// the stopPointerPropagation canvas contract (ClarifyDirectiveToggle relies
// on all three: stops mouseDown AND click bubbling; active click no-ops).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { createRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Segmented, type SegmentedOption } from '../src/components/Segmented'

type Mode = 'designer' | 'questioner'

const OPTIONS: ReadonlyArray<SegmentedOption<Mode>> = [
  { value: 'designer', label: 'Designer' },
  { value: 'questioner', label: 'Questioner' },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('<Segmented> — radiogroup shape', () => {
  test('container is role=radiogroup with aria-label + .segmented class', () => {
    render(<Segmented value="designer" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />)
    const group = screen.getByRole('radiogroup', { name: 'Scope' })
    expect(group.className).toBe('segmented')
  })

  test('className is appended after the segmented namespace', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Scope"
        className="memory-form__scope-segmented"
      />,
    )
    expect(screen.getByRole('radiogroup').className).toBe('segmented memory-form__scope-segmented')
  })

  test('options are type=button role=radio with aria-checked on the active one', () => {
    render(<Segmented value="questioner" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    for (const r of radios) expect(r.getAttribute('type')).toBe('button')
    expect(screen.getByRole('radio', { name: 'Designer' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    expect(screen.getByRole('radio', { name: 'Questioner' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  test('active option carries segmented__option--active; inactive does not', () => {
    render(<Segmented value="designer" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />)
    expect(screen.getByRole('radio', { name: 'Designer' }).className).toBe(
      'segmented__option segmented__option--active',
    )
    expect(screen.getByRole('radio', { name: 'Questioner' }).className).toBe('segmented__option')
  })

  test('title passthrough on the option button', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={[{ value: 'designer', label: 'D', title: 'Designer answers' }]}
        ariaLabel="Scope"
      />,
    )
    expect(screen.getByRole('radio').getAttribute('title')).toBe('Designer answers')
  })

  test('activeOptionRef points only to the active option and follows value changes', () => {
    const activeOptionRef = createRef<HTMLButtonElement>()
    const { rerender } = render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Scope"
        activeOptionRef={activeOptionRef}
      />,
    )

    expect(activeOptionRef.current).toBe(screen.getByRole('radio', { name: 'Designer' }))

    rerender(
      <Segmented
        value="questioner"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Scope"
        activeOptionRef={activeOptionRef}
      />,
    )
    expect(activeOptionRef.current).toBe(screen.getByRole('radio', { name: 'Questioner' }))
  })
})

describe('<Segmented> — change semantics', () => {
  test('uses roving tabindex and arrow keys select/focus the next enabled radio', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="designer"
        onChange={onChange}
        options={[
          { value: 'designer', label: 'Designer' },
          { value: 'disabled' as Mode, label: 'Disabled', disabled: true },
          { value: 'questioner', label: 'Questioner' },
        ]}
        ariaLabel="Scope"
      />,
    )

    const designer = screen.getByRole('radio', { name: 'Designer' })
    const questioner = screen.getByRole('radio', { name: 'Questioner' })
    expect(designer.getAttribute('tabindex')).toBe('0')
    expect(questioner.getAttribute('tabindex')).toBe('-1')

    designer.focus()
    fireEvent.keyDown(designer, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('questioner')
    expect(document.activeElement).toBe(questioner)
  })

  test('Home/End and backward arrows wrap across the enabled radios', () => {
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState<Mode>('designer')
      return (
        <Segmented
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
          options={OPTIONS}
          ariaLabel="Scope"
        />
      )
    }
    render(<Harness />)
    const designer = screen.getByRole('radio', { name: 'Designer' })
    const questioner = screen.getByRole('radio', { name: 'Questioner' })

    fireEvent.keyDown(designer, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('questioner')
    expect(document.activeElement).toBe(questioner)

    fireEvent.keyDown(questioner, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('designer')
    expect(document.activeElement).toBe(designer)

    fireEvent.keyDown(designer, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('questioner')
    fireEvent.keyDown(questioner, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('designer')
  })

  test('clicking a non-active option fires onChange with its value', () => {
    const onChange = vi.fn()
    render(<Segmented value="designer" onChange={onChange} options={OPTIONS} ariaLabel="Scope" />)
    fireEvent.click(screen.getByRole('radio', { name: 'Questioner' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('questioner')
  })

  test('clicking the already-active option is a no-op (radio semantics)', () => {
    const onChange = vi.fn()
    render(<Segmented value="designer" onChange={onChange} options={OPTIONS} ariaLabel="Scope" />)
    fireEvent.click(screen.getByRole('radio', { name: 'Designer' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  test('control-level disabled disables every option and swallows clicks', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="designer"
        onChange={onChange}
        options={OPTIONS}
        ariaLabel="Scope"
        disabled
      />,
    )
    for (const r of screen.getAllByRole('radio')) {
      expect((r as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Questioner' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  test('per-option disabled only disables that option', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="designer"
        onChange={onChange}
        options={[
          { value: 'designer', label: 'Designer' },
          { value: 'questioner', label: 'Questioner', disabled: true },
        ]}
        ariaLabel="Scope"
      />,
    )
    expect((screen.getByRole('radio', { name: 'Questioner' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('radio', { name: 'Designer' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Questioner' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  test('first enabled option remains in the Tab order when the active option is disabled', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={[
          { value: 'designer', label: 'Designer', disabled: true },
          { value: 'questioner', label: 'Questioner' },
        ]}
        ariaLabel="Scope"
      />,
    )

    expect(screen.getByRole('radio', { name: 'Designer' }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('radio', { name: 'Questioner' }).getAttribute('tabindex')).toBe('0')
  })

  test('first enabled option remains in the Tab order when value is absent from dynamic options', () => {
    render(
      <Segmented
        value={'missing' as Mode}
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Scope"
      />,
    )

    expect(screen.getByRole('radio', { name: 'Designer' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('radio', { name: 'Questioner' }).getAttribute('tabindex')).toBe('-1')
  })
})

describe('<Segmented> — shortcut / data / testid slots', () => {
  test('shortcut renders an aria-hidden <kbd class="kbd-shortcut segmented__shortcut">', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={[
          { value: 'designer', label: 'Designer', shortcut: 'Q', shortcutTestid: 'scope-d-kbd' },
          { value: 'questioner', label: 'Questioner', shortcut: 'W' },
        ]}
        ariaLabel="Scope"
      />,
    )
    const kbd = screen.getByTestId('scope-d-kbd')
    expect(kbd.tagName).toBe('KBD')
    expect(kbd.className).toBe('kbd-shortcut segmented__shortcut')
    expect(kbd.getAttribute('aria-hidden')).toBe('true')
    expect(kbd.textContent).toBe('Q')
    // The accessible name stays the label; the kbd hint is decorative but
    // still lives inside the option button.
    expect(screen.getByRole('radio', { name: 'Designer' }).contains(kbd)).toBe(true)
  })

  test('no shortcut → no kbd element', () => {
    const { container } = render(
      <Segmented value="designer" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />,
    )
    expect(container.querySelector('kbd')).toBeNull()
  })

  test('data map expands to data-* attributes on the option button', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={[
          { value: 'designer', label: 'D', data: { directive: 'continue', foo: 'bar' } },
          { value: 'questioner', label: 'Q' },
        ]}
        ariaLabel="Scope"
      />,
    )
    const btn = screen.getByRole('radio', { name: 'D' })
    expect(btn.getAttribute('data-directive')).toBe('continue')
    expect(btn.getAttribute('data-foo')).toBe('bar')
    expect(screen.getByRole('radio', { name: 'Q' }).hasAttribute('data-directive')).toBe(false)
  })

  test('testidPrefix derives container + per-option testids (ChipsInput contract)', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Scope"
        testidPrefix="clarify-scope"
      />,
    )
    expect(screen.getByTestId('clarify-scope')).toBe(screen.getByRole('radiogroup'))
    expect(screen.getByTestId('clarify-scope-designer')).toBe(
      screen.getByRole('radio', { name: 'Designer' }),
    )
    expect(screen.getByTestId('clarify-scope-questioner')).toBe(
      screen.getByRole('radio', { name: 'Questioner' }),
    )
  })

  test('explicit rootTestid / option testid win over the prefix derivation', () => {
    render(
      <Segmented
        value="designer"
        onChange={() => {}}
        options={[
          { value: 'designer', label: 'Designer', testid: 'clarify-scope-q1-designer' },
          { value: 'questioner', label: 'Questioner' },
        ]}
        ariaLabel="Scope"
        testidPrefix="clarify-scope"
        rootTestid="clarify-scope-segmented-q1"
      />,
    )
    expect(screen.getByTestId('clarify-scope-segmented-q1')).toBe(screen.getByRole('radiogroup'))
    expect(screen.queryByTestId('clarify-scope')).toBeNull()
    expect(screen.getByTestId('clarify-scope-q1-designer')).toBe(
      screen.getByRole('radio', { name: 'Designer' }),
    )
    // Options without an explicit testid still fall back to the prefix.
    expect(screen.getByTestId('clarify-scope-questioner')).toBe(
      screen.getByRole('radio', { name: 'Questioner' }),
    )
  })

  test('no testidPrefix → no data-testid attributes at all', () => {
    const { container } = render(
      <Segmented value="designer" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />,
    )
    expect(container.querySelector('[data-testid]')).toBeNull()
  })
})

describe('<Segmented> — stopPointerPropagation (canvas contract)', () => {
  test('stops mouseDown AND click bubbling past the control; onChange still fires', () => {
    const onChange = vi.fn()
    const outerClick = vi.fn()
    const outerMouseDown = vi.fn()
    render(
      <div onClick={outerClick} onMouseDown={outerMouseDown}>
        <Segmented
          value="designer"
          onChange={onChange}
          options={OPTIONS}
          ariaLabel="Scope"
          stopPointerPropagation
        />
      </div>,
    )
    const target = screen.getByRole('radio', { name: 'Questioner' })
    fireEvent.mouseDown(target)
    fireEvent.click(target)
    expect(onChange).toHaveBeenCalledWith('questioner')
    expect(outerClick).not.toHaveBeenCalled()
    expect(outerMouseDown).not.toHaveBeenCalled()
  })

  test('clicking the active option still no-ops but keeps the bubble stopped', () => {
    const onChange = vi.fn()
    const outerClick = vi.fn()
    render(
      <div onClick={outerClick}>
        <Segmented
          value="designer"
          onChange={onChange}
          options={OPTIONS}
          ariaLabel="Scope"
          stopPointerPropagation
        />
      </div>,
    )
    const active = screen.getByRole('radio', { name: 'Designer' })
    fireEvent.mouseDown(active)
    fireEvent.click(active)
    expect(onChange).not.toHaveBeenCalled()
    expect(outerClick).not.toHaveBeenCalled()
  })

  test('without the flag, events bubble normally', () => {
    const outerClick = vi.fn()
    const outerMouseDown = vi.fn()
    render(
      <div onClick={outerClick} onMouseDown={outerMouseDown}>
        <Segmented value="designer" onChange={() => {}} options={OPTIONS} ariaLabel="Scope" />
      </div>,
    )
    const target = screen.getByRole('radio', { name: 'Questioner' })
    fireEvent.mouseDown(target)
    fireEvent.click(target)
    expect(outerClick).toHaveBeenCalled()
    expect(outerMouseDown).toHaveBeenCalled()
  })
  test('allowActiveReselect：点击已 active 值仍触发 onChange（session-mode 显式落库场景）', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="isolated"
        onChange={onChange}
        ariaLabel="mode"
        allowActiveReselect
        options={[
          { value: 'isolated', label: 'Isolated' },
          { value: 'inline', label: 'Inline' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Isolated' }))
    expect(onChange).toHaveBeenCalledWith('isolated')
  })

  test('缺省（无 allowActiveReselect）：active 点击保持 no-op', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="a"
        onChange={onChange}
        ariaLabel="m"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

// RFC-192 — options must never wrap: inside a shrinking flex context (the
// /tasks toolbar) the labels used to collapse into vertical per-character
// text. Locked at the CSS layer since the failure is purely layout.
describe('segmented option nowrap (RFC-192)', () => {
  test('.segmented__option declares white-space: nowrap', () => {
    const css = readFileSync(
      resolve(path.dirname(new URL(import.meta.url).pathname), '../src/styles.css'),
      'utf8',
    )
    const block = css.match(/\.segmented__option\s*\{[^}]*\}/)
    expect(block, '.segmented__option rule must exist').not.toBeNull()
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })
})
