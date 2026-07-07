// RFC-024 T8 — locks the URL-mode "源仓库 / Source repo" row on the task
// detail page. Path-mode tasks must continue to render only the local
// repoPath row; URL-mode tasks must render the redacted URL alongside the
// cache path label.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

describe('tasks.detail.tsx URL row (RFC-024 T8)', () => {
  test('imports redactGitUrl from shared', () => {
    // flag-audit W0 后该 import 行还带 COMMIT_PUSH_NODE_PREFIX 等兄弟符号——
    // 锁的契约是「redactGitUrl 来自 shared」，不锁具体同行符号集。
    expect(SRC).toMatch(/import \{[^}]*\bredactGitUrl\b[^}]*\} from '@agent-workflow\/shared'/)
  })

  test('only renders the URL row when tk.repoUrl !== null', () => {
    expect(SRC).toContain('tk.repoUrl !== null')
    expect(SRC).toContain('data-testid="task-detail-repo-url"')
  })

  test('URL is always redacted before render', () => {
    // The only interpolation of tk.repoUrl in the JSX must go through redactGitUrl.
    const lines = SRC.split('\n')
    for (const ln of lines) {
      if (/\btk\.repoUrl\b/.test(ln) && !/!== null/.test(ln)) {
        expect(ln).toMatch(/redactGitUrl/)
      }
    }
  })

  test('label flips between metaRepo and metaRepoCachePath based on mode', () => {
    expect(SRC).toContain('metaRepoCachePath')
    expect(SRC).toContain('metaRepoUrl')
  })
})
