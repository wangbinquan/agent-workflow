// RFC-019: source-layer guards for /skills/new wiring of the Upload ZIP tab.
// Locks two invariants so a future refactor can't silently lose the integration:
//   1. The route imports ImportZipPanel and declares a 'zip' tab value.
//   2. The tab button uses the stable data-testid the panel tests rely on.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROUTE_PATH = resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.new.tsx')
const PANEL_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'components',
  'skills',
  'ImportZipPanel.tsx',
)

describe('/skills/new — Upload ZIP tab wiring', () => {
  test('imports ImportZipPanel component', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("from '@/components/skills/ImportZipPanel'")
    expect(src).toContain('<ImportZipPanel')
  })

  test("declares 'zip' tab value and renders panel for that tab", () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("'zip'")
    expect(src).toContain("t('skills.tabZip')")
  })

  test('tab button has stable testid skills-tab-zip', () => {
    // RFC-150 PR-2: the tab strip is the shared <TabBar>; the stable testid
    // now flows through the TabDef `testid` prop (renders the same
    // data-testid="skills-tab-zip" attribute on the tab button).
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("testid: 'skills-tab-zip'")
  })

  test('true tabs share stable ids with their keep-mounted panels', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("from '@/components/split/TabPanels'")
    expect(src).toContain('idPrefix="skills-new"')
    expect(src).toContain('<TabPanels<Tab>')
    expect(src).not.toContain('<div role="tabpanel"')
  })

  test('ZIP mode owns a dynamic import heading and no create action', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("tab === 'zip' ? t('skills.importTitle')")
    expect(src).toContain("t('skills.importSubtitle')")
    expect(src).toContain("tab !== 'zip'")
  })

  test('panel uses shared primitives and no longer renders the RFC-019 table/raw rename input', () => {
    const src = readFileSync(PANEL_PATH, 'utf-8')
    expect(src).toContain("from '@/components/FileDropzone'")
    expect(src).toContain("from '@/components/Card'")
    expect(src).toContain("from '@/components/StatusChip'")
    expect(src).toContain("from '@/components/ErrorBanner'")
    expect(src).toContain("from '@/components/Form'")
    expect(src).not.toContain('<table')
    expect(src).not.toContain('type="text"')
    expect(src).not.toContain('zip-import__')
  })
})
