// RFC-151 PR-4 — OidcProviderDialog create/edit strategy convergence.
//
// The dialog used to scatter SEVEN `props.mode === …` branches (title /
// endpoint / clientSecret wire shape / required / placeholder / test-button
// render gate / a throw inside the test mutation). They're now one local
// strategy lookup; in particular the "no test connection before the provider
// is saved" rule is encoded ONCE (`testConnection: null` in the create
// strategy) and both the footer button and the mutation read that same
// field. Source-level lock (the settings route has no render harness).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function read(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

describe('RFC-151 OidcProviderDialog mode strategy', () => {
  const settings = () => read('routes/settings.tsx')

  test('exactly one mode branch survives: the strategy selector itself', () => {
    const occurrences = settings().match(/props\.mode ===/g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  test('test-connection affordance derives from the strategy single-source', () => {
    const src = settings()
    // create strategy disables it…
    expect(src).toContain('testConnection: null')
    // …the footer render gate reads the SAME field…
    expect(src).toContain('strategy.testConnection !== null && (')
    // …and the mutation body narrows on it instead of a second mode check.
    expect(src).toContain('strategy.testConnection === null')
  })

  test('clientSecret field wiring reads the strategy, not the mode', () => {
    const src = settings()
    expect(src).toContain('required={strategy.clientSecretRequired}')
    expect(src).toContain('placeholder={strategy.clientSecretPlaceholder}')
    expect(src).toContain('...strategy.clientSecretBody(clientSecret)')
  })

  test('the dead create-mode throw copy (testSaveFirst) is fully removed', () => {
    expect(settings()).not.toContain('testSaveFirst')
    expect(read('i18n/zh-CN.ts')).not.toContain('testSaveFirst')
    expect(read('i18n/en-US.ts')).not.toContain('testSaveFirst')
  })
})
