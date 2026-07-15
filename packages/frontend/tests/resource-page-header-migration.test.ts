// RFC-198 PR4 §5.3 — resource create/detail headers use the shared PageHeader.
//
// The split rail remains mounted beside these routes and already owns the page
// h1, so every split create/detail heading must stay h2. Source locks complement
// the rendered split-route tests by preventing a future native header fork.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(import.meta.dirname, '..', 'src')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

const CREATE_ROUTES = [
  'routes/agents.new.tsx',
  'routes/skills.new.tsx',
  'routes/mcps.new.tsx',
  'routes/plugins.new.tsx',
] as const

const SPLIT_DETAIL_ROUTES = [
  'routes/agents.detail.tsx',
  'routes/skills.detail.tsx',
  'routes/mcps.detail.tsx',
  'routes/plugins.detail.tsx',
] as const

describe('RFC-198 resource PageHeader migration', () => {
  test.each(CREATE_ROUTES)('%s delegates create chrome to an h2 PageHeader', (path) => {
    const source = read(path)
    expect(source).toContain("import { PageHeader } from '@/components/PageHeader'")
    expect(source).toContain('<PageHeader')
    expect(source).toContain('headingLevel={2}')
    expect(source).not.toContain('<header className="page__header')
  })

  test('DetailHeaderActions delegates heading/actions without owning native header chrome', () => {
    const source = read('components/DetailHeaderActions.tsx')
    expect(source).toContain("import { PageHeader } from '@/components/PageHeader'")
    expect(source).toContain('title={props.title}')
    expect(source).toContain('headingLevel={props.headingLevel}')
    expect(source).toContain('actions={')
    expect(source).not.toContain('<header className="page__header')
  })

  test.each(SPLIT_DETAIL_ROUTES)('%s keeps the rail/detail outline at h2', (path) => {
    const source = read(path)
    expect(source).toContain('<DetailHeaderActions')
    expect(source).toContain('headingLevel={2}')
    expect(source).not.toContain('</DetailHeaderActions>')
  })
})
