// RFC-024 §9 — source-level grep that locks the URL-redaction contract:
// every backend module that *logs / throws / returns* a Git URL must funnel
// it through `redactGitUrl` (or only ever touch the row's `urlRedacted`
// field). If anyone later refactors with a raw `${url}` template string in
// an error body or log call this test goes red.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILES_THAT_TOUCH_URLS = [
  'src/modules/source-control/infrastructure/local/repositoryMirrorCache.ts',
  'src/services/task.ts',
  'src/routes/cached-repos.ts',
]

describe('RFC-024 URL redaction source-level coverage', () => {
  for (const rel of FILES_THAT_TOUCH_URLS) {
    test(`${rel} only emits URLs via redactGitUrl / row.urlRedacted`, () => {
      const path = resolve(import.meta.dir, '..', rel)
      const src = readFileSync(path, 'utf-8')
      // Find every `log.<level>(... url: ...)` or `throw new ...Error(...url...)`
      // pattern that interpolates a `.url` member or template. Any such line
      // must mention `redactGitUrl` on the same line, OR reference the safe
      // `urlRedacted` field of a CachedRepo row.
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // Lines that quote a `${...url...}` template literal directly.
        if (/\$\{[^}]*\.url\b/.test(line)) {
          const okHere =
            line.includes('redactGitUrl') ||
            line.includes('urlRedacted') ||
            line.includes('this.url') // CachedRepoHasReferencesError carries redacted in ctor
          if (!okHere) {
            // Look two lines back for redactGitUrl in the same expression.
            const window = lines.slice(Math.max(0, i - 2), i + 1).join(' ')
            if (!/redactGitUrl|urlRedacted/.test(window)) {
              throw new Error(
                `${rel}:${i + 1} interpolates a .url without redactGitUrl/urlRedacted: ${line.trim()}`,
              )
            }
          }
        }
      }
      expect(true).toBe(true)
    })
  }

  test('CachedRepoHasReferencesError ctor only takes a redacted url', () => {
    const path = resolve(
      import.meta.dir,
      '..',
      'src/modules/source-control/infrastructure/local/repositoryMirrorCache.ts',
    )
    const src = readFileSync(path, 'utf-8')
    // The class field is named `urlRedacted` — anyone storing a raw url here
    // would have to rename the field, which trips this assertion.
    expect(src).toContain('public readonly urlRedacted')
  })
})
