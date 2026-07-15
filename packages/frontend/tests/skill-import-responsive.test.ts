// RFC-196: source-level responsive guard for the extremely narrow split
// detail column. Real geometry is covered by e2e/skill-import.spec.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
const SKILLS_ROUTE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.tsx'),
  'utf-8',
)
const SKILLS_NEW_ROUTE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.new.tsx'),
  'utf-8',
)

describe('RFC-196 Skill ZIP responsive CSS', () => {
  test('retires the table/private chrome and keeps every feature seam shrinkable', () => {
    expect(CSS).not.toContain('.zip-import__table')
    expect(CSS).not.toContain('.zip-import__rename')
    expect(CSS).not.toContain('.zip-import__error')
    expect(CSS).toContain('.skill-import__phase')
    expect(CSS).toContain('.zip-candidate__decision')
    expect(CSS).toContain('min-width: 0;')
  })

  test('narrow layout stacks file, decision, action, and result controls', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px)'))
    for (const selector of [
      '.file-dropzone__selection',
      '.zip-candidate__decision',
      '.skill-import__actions',
      '.skill-import__result-actions',
    ]) {
      expect(mobile).toContain(selector)
    }
    expect(mobile).toContain('grid-template-columns: minmax(0, 1fr);')
  })

  test('phone layout delegates shell and list/detail navigation to shared primitives', () => {
    expect(CSS).not.toContain('.app-shell:has(.skill-import) > .sidebar')
    expect(CSS).not.toContain('.page--split:has(.skill-import) .split__list')
    expect(CSS).not.toContain('.skill-import__mobile-back')
    expect(CSS).toContain(".page--split[data-mobile-view='detail'] .split__list")
    expect(CSS).toContain('.split__mobile-back')
    expect(SKILLS_ROUTE).toContain('listTo="/skills"')
    expect(SKILLS_ROUTE).toContain("mobileBackLabel={t('common.backToList')}")
    expect(SKILLS_ROUTE).toContain('mobileBackTestId="skills-mobile-back"')
    expect(SKILLS_NEW_ROUTE).not.toContain('skill-import__mobile-back')
  })

  test('directory example wraps instead of introducing an inner horizontal scrollbar', () => {
    const structure = CSS.slice(
      CSS.indexOf('.skill-import__structure pre'),
      CSS.indexOf('.skill-import__select-action'),
    )
    expect(structure).toContain('overflow: hidden;')
    expect(structure).toContain('overflow-wrap: anywhere;')
    expect(structure).toContain('white-space: pre-wrap;')
  })
})
