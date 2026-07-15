import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function declarations(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (body === undefined) throw new Error(`missing CSS block for ${selector}`)
  const entries: Array<[string, string]> = []
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const name = match[1]
    const rawValue = match[2]
    if (name !== undefined && rawValue !== undefined) entries.push([name, rawValue.trim()])
  }
  return new Map(entries)
}

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`expected six-digit hex, got ${hex}`)
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}

function luminance(hex: string): number {
  const linear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = rgb(hex)
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b))
  const darker = Math.min(luminance(a), luminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function value(theme: Map<string, string>, root: Map<string, string>, name: string): string {
  return theme.get(name) ?? root.get(name) ?? ''
}

describe('RFC-198 semantic theme contrast', () => {
  const root = declarations(':root')
  const dark = declarations(":root[data-theme='dark']")

  test.each([
    ['light', root],
    ['dark', dark],
  ] as const)('%s normal-text and filled-control pairs meet 4.5:1', (_name, theme) => {
    const panel = value(theme, root, '--panel')
    const pairs = [
      ['--text', panel],
      ['--muted', panel],
      ['--accent', panel],
      ['--success-fg', panel],
      ['--warn-fg', panel],
      ['--info-fg', panel],
      ['--danger-fg', panel],
      ['--on-accent', value(theme, root, '--accent-fill')],
      ['--on-success', value(theme, root, '--success-fill')],
      ['--on-warn', value(theme, root, '--warn-fill')],
      ['--on-info', value(theme, root, '--info-fill')],
      ['--on-danger', value(theme, root, '--danger-fill')],
    ] as const

    for (const [foregroundName, background] of pairs) {
      const foreground = value(theme, root, foregroundName)
      expect(
        contrast(foreground, background),
        `${foregroundName} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
