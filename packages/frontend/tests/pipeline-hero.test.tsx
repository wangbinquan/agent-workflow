// RFC-190 — PipelineHero: the homepage/onboarding hero's animated
// mini-pipeline (git snapshot → code → audit ×3 → aggregate → fix).
//
// Why this test exists:
//  - the SVG must stay decorative (aria-hidden) with the wrapping link
//    carrying the accessible name — the `/` axe e2e gate depends on it;
//  - its gradient ids must stay in the `aw-pipe-*` namespace: reusing the
//    sidebar logo's `aw-stream-*` ids would create duplicate DOM ids (those
//    ids are source-locked to __root.tsx by sidebar-brand-icon.test.ts);
//  - the aggregate stage is part of the platform's real Code→Audit→Fix
//    data flow (audits aggregate BEFORE the fixer — design gate P1-8) and
//    must not be "simplified" away;
//  - every animated selector must be disabled under prefers-reduced-motion
//    (source-level lock, same idiom as running-node-highlight-styles).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import '../src/i18n'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
  }
})

import { PipelineHero } from '../src/components/home/PipelineHero'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-190 PipelineHero', () => {
  test('decorative svg inside an accessible link to /workflows', () => {
    render(<PipelineHero />)
    const link = screen.getByTestId('pipeline-hero')
    expect(link.tagName.toLowerCase()).toBe('a')
    expect(link.getAttribute('href')).toBe('/workflows')
    expect(link.getAttribute('aria-label')).toBeTruthy()
    const svg = link.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  test('gradient ids live in aw-pipe-*, never the source-locked aw-stream-*', () => {
    const { container } = render(<PipelineHero />)
    const html = container.innerHTML
    expect(html).toContain('aw-pipe-a')
    expect(html).toContain('aw-pipe-b')
    expect(html).toContain('aw-pipe-c')
    expect(html).not.toContain('aw-stream-')
  })

  test('topology includes the aggregate stage between audits and fix', () => {
    const { container } = render(<PipelineHero />)
    const labels = Array.from(container.querySelectorAll('text')).map((t) => t.textContent ?? '')
    // zh default locale in tests; accept either bundle to stay locale-proof.
    expect(labels.some((l) => /聚合|Aggregate/.test(l))).toBe(true)
    expect(labels.some((l) => /修复|Fix/.test(l))).toBe(true)
    // three audit nodes (the fan-out), each marked live/breathing
    const live = container.querySelectorAll('.pipeline-hero__node--live')
    expect(live.length).toBe(3)
  })

  test('SOURCE LOCK: all three animated selectors go animation:none under reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8')
    for (const selector of [
      String.raw`\.pipeline-hero__edge`,
      String.raw`\.pipeline-hero__dot`,
      String.raw`\.pipeline-hero__node--live`,
    ]) {
      const re = new RegExp(
        String.raw`@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?` +
          selector +
          String.raw`[^]*?animation:\s*none`,
      )
      expect(re.test(css), `reduced-motion must disable ${selector}`).toBe(true)
    }
  })
})
