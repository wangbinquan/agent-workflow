// RFC-250 T28 — blocker/advisory feedback must keep using the shared semantic
// surfaces. A bare `.error-banner` has neither the NoticeBanner role contract
// nor FeedbackStack spacing and must not return at these audited callsites.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

function read(relative: string): string {
  return readFileSync(path.join(src, relative), 'utf8')
}

describe('RFC-250 shared feedback source ratchet', () => {
  test.each(['components/AgentForm.tsx', 'routes/workgroups.detail.tsx'])(
    '%s has no bare error-banner and uses shared feedback surfaces',
    (relative) => {
      const source = read(relative)
      expect(source).not.toMatch(/className=["'{`]error-banner(?:\s|["'}])/)
      expect(source).toMatch(/<(?:ErrorBanner|NoticeBanner)(?:\s|>)/)
      expect(source).toMatch(/<FeedbackStack(?:\s|>)/)
    },
  )

  test('workgroup advisory readiness uses NoticeBanner warning semantics', () => {
    const source = read('routes/workgroups.detail.tsx')
    expect(source).toMatch(/<NoticeBanner\s+tone="warning"/)
    expect(source).toMatch(/<NoticeBanner\s+tone="error"/)
  })
})
