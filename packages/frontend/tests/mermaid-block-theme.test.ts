// Regression: dark-mode mermaid SVG used to ship with mermaid's default
// (light) palette — node label text rendered in a dark color against the
// dark page background, making diagrams illegible. MermaidBlock.render now
// accepts a `theme: 'light' | 'dark'` arg and (re-)calls mermaid.initialize
// before each render with `theme: 'base'` + custom `themeVariables` keyed
// to the app's CSS palette, so diagrams read like part of the UI in both
// modes (and avoid the all-grey look mermaid's stock 'dark' theme has).
//
// If a future refactor drops the theme arg, stops calling initialize per
// render, or reverts to mermaid's stock 'default' / 'dark' themes, these
// assertions go red.

import { describe, expect, test, vi, beforeEach } from 'vitest'

const initializeSpy = vi.fn()
const renderSpy = vi.fn(async (_id: string, _src: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"/></svg>',
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeSpy,
    render: renderSpy,
  },
}))

import { MermaidBlock } from '../src/components/review/MermaidBlock'

describe('MermaidBlock — theme is plumbed into mermaid.initialize', () => {
  beforeEach(() => {
    initializeSpy.mockClear()
    renderSpy.mockClear()
    document.body.innerHTML = ''
  })

  test('theme="dark" calls mermaid.initialize with base + dark themeVariables', async () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    await MermaidBlock.render(mount, 'flowchart TD\n A[hi]', 'dark')

    expect(initializeSpy).toHaveBeenCalled()
    const call = initializeSpy.mock.calls[initializeSpy.mock.calls.length - 1]?.[0]
    expect(call).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
    })
    // Dark palette: nodes ride the app's --panel, text rides --text, accents
    // ride --accent. The exact hex values come from styles.css and are
    // mirrored in MermaidBlock.THEME_VARS — locking the contract avoids
    // silent palette drift between styles.css and mermaid output.
    expect(call?.themeVariables).toMatchObject({
      darkMode: 'true',
      background: '#15181d', // --bg dark
      primaryColor: '#1c2028', // --panel dark
      primaryTextColor: '#e6e7ea', // --text dark
      primaryBorderColor: '#8eb8ff', // --accent dark
      lineColor: '#95a0b3', // --muted dark
    })
  })

  test('theme="light" maps to base + light themeVariables', async () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    await MermaidBlock.render(mount, 'flowchart TD\n A[hi]', 'light')

    const call = initializeSpy.mock.calls[initializeSpy.mock.calls.length - 1]?.[0]
    expect(call).toMatchObject({ theme: 'base' })
    expect(call?.themeVariables).toMatchObject({
      background: '#ffffff', // --panel light
      primaryColor: '#ffffff',
      primaryTextColor: '#1f2328', // --text light
      primaryBorderColor: '#1f5fda', // --accent light
      lineColor: '#5b6271', // --muted light
    })
    // Light preset must NOT carry mermaid's darkMode flag.
    expect(call?.themeVariables?.darkMode).toBeUndefined()
  })

  test('omitted theme defaults to light', async () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    await MermaidBlock.render(mount, 'flowchart TD\n A[hi]')

    const call = initializeSpy.mock.calls[initializeSpy.mock.calls.length - 1]?.[0]
    expect(call).toMatchObject({ theme: 'base' })
    expect(call?.themeVariables?.primaryTextColor).toBe('#1f2328')
  })

  test('initialize runs on every render so theme flips re-color subsequent diagrams', async () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    await MermaidBlock.render(mount, 'flowchart TD\n A[hi]', 'light')
    await MermaidBlock.render(mount, 'flowchart TD\n A[hi]', 'dark')

    expect(initializeSpy).toHaveBeenCalledTimes(2)
    expect(initializeSpy.mock.calls[0]?.[0]?.themeVariables?.darkMode).toBeUndefined()
    expect(initializeSpy.mock.calls[1]?.[0]?.themeVariables?.darkMode).toBe('true')
  })
})
