// RFC-290 — NumberInput range hints must expose bounded values without making
// callers repeat prose. These cases lock the product request, the conversion
// edge cases, and the accessible-name regression found by the design gate.
import { render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Field, NumberInput } from '../src/components/Form'
import i18n from '../src/i18n'
import { formatUnitValue } from '../src/lib/formatUnit'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
const SRC_ROOT = resolve(import.meta.dirname, '..', 'src')

function sourceTsxFiles(dir = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return sourceTsxFiles(path)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

function renderInput(
  props: Partial<React.ComponentProps<typeof NumberInput>> = {},
  field: { hint?: string; error?: string } = { hint: '用途说明' },
) {
  return render(
    <Field label="超时" hint={field.hint} error={field.error}>
      <NumberInput value={1} onChange={() => {}} min={1} {...props} />
    </Field>,
  )
}

function range(): HTMLElement | null {
  return document.querySelector('.form-field__range')
}

describe('RFC-290 NumberInput range hint', () => {
  test('max enables the default hint while min-only renders no range', () => {
    const { rerender } = render(
      <Field label="并发数" hint="用途说明">
        <NumberInput value={1} onChange={() => {}} min={1} max={32} />
      </Field>,
    )
    expect(range()?.textContent).toBe('范围 1 – 32')

    rerender(
      <Field label="并发数" hint="用途说明">
        <NumberInput value={1} onChange={() => {}} min={1} />
      </Field>,
    )
    expect(range()).toBeNull()
  })

  test('max-only uses the defensive copy and explicit opt-out suppresses it', () => {
    const { rerender } = render(
      <Field label="上限">
        <NumberInput value={1} onChange={() => {}} max={10} />
      </Field>,
    )
    expect(range()?.textContent).toBe('最大 10')

    rerender(
      <Field label="上限">
        <NumberInput value={1} onChange={() => {}} min={1} max={10} rangeHint={false} />
      </Field>,
    )
    expect(range()).toBeNull()
  })

  test.each([
    ['ms', 30_000, 3_600_000, '范围 30000 – 3600000（30 秒 – 1 小时）'],
    ['bytes', 0, 262_144, '范围 0 – 262144（0 – 256 KiB）'],
    ['days', 1, 3650, '范围 1 – 3650（1 天 – 10 年）'],
  ] as const)('unit=%s appends the expected human conversion', (unit, min, max, expected) => {
    renderInput({ min, max, unit })
    expect(range()?.textContent).toBe(expected)
  })

  test('a max-only unit range converts only its max endpoint', () => {
    renderInput({ min: undefined, max: 3_600_000, unit: 'ms' })
    expect(range()?.textContent).toBe('最大 3600000（1 小时）')
  })

  test('a value that enters the minute tier but is not divisible does not fall back to seconds', () => {
    renderInput({ min: 30_000, max: 90_000, unit: 'ms' })
    expect(range()?.textContent).toBe('范围 30000 – 90000')
    expect(formatUnitValue(90_000, 'ms', i18n.t)).toBeNull()
  })

  test('zero is a successful literal conversion and a missing unit stays numeric-only', () => {
    expect(formatUnitValue(0, 'bytes', i18n.t)).toBe('0')
    renderInput({ min: 0, max: 262_144 })
    expect(range()?.textContent).toBe('范围 0 – 262144')
  })

  test('range is described exactly once and caller descriptions are preserved', () => {
    render(
      <>
        <span id="caller-description">调用方说明</span>
        <Field label="超时" hint="用途说明">
          <NumberInput
            value={30_000}
            onChange={() => {}}
            min={30_000}
            max={3_600_000}
            unit="ms"
            aria-describedby="caller-description"
          />
        </Field>
      </>,
    )

    const input = screen.getByRole('spinbutton', { name: '超时 用途说明' })
    expect(
      screen.queryByRole('spinbutton', {
        description: '调用方说明 范围 30000 – 3600000（30 秒 – 1 小时）',
      }),
    ).toBe(input)
    const hint = range()
    expect(hint?.getAttribute('aria-hidden')).toBe('true')
    const ids = input.getAttribute('aria-describedby')?.split(/\s+/)
    expect(ids).toContain('caller-description')
    expect(ids).toContain(hint?.id)
  })

  test('an error replaces the field hint but leaves the corrective range visible', () => {
    renderInput({ max: 10 }, { hint: '用途说明', error: '超出范围' })
    expect(screen.queryByText('用途说明')).toBeNull()
    expect(screen.getByText('超出范围')).toBeTruthy()
    expect(range()?.textContent).toBe('范围 1 – 10')
  })

  test('English uses plural forms and ASCII parentheses', async () => {
    await i18n.changeLanguage('en-US')
    renderInput({ min: 30_000, max: 3_600_000, unit: 'ms' })
    expect(range()?.textContent).toBe('Range 30000 – 3600000 (30 seconds – 1 hour)')
  })

  test('the flex-order rule keeps the range after Field hint/error visually', () => {
    expect(CSS).toMatch(
      /\.form-field__range\s*\{[^}]*\border:\s*1\s*;[^}]*font-size:\s*12px\s*;[^}]*color:\s*var\(--muted\)\s*;/s,
    )
  })

  test('all nine bounded NumberInput callers show the hint except compact Pagination', () => {
    const bounded = sourceTsxFiles().flatMap((path) => {
      const file = relative(SRC_ROOT, path).split(sep).join('/')
      const source = readFileSync(path, 'utf8')
      return (source.match(/<NumberInput\b[\s\S]*?\/>/g) ?? [])
        .filter((tag) => /\bmax=/.test(tag))
        .map((tag) => ({ file, tag }))
    })
    const optedOut = bounded.filter(({ tag }) => tag.includes('rangeHint={false}'))

    expect(bounded).toHaveLength(9)
    expect(bounded.length - optedOut.length).toBe(8)
    expect(optedOut.map(({ file }) => file)).toEqual(['components/Pagination.tsx'])
  })
})
