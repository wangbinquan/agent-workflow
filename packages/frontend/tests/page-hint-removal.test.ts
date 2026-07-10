// RFC-155 — page-header explanatory hint removal locks.
//
// The user asked for every static "how the system works" subtitle under page
// headers to go (22 sites). These are table-driven bans (banned locks live at
// the table level, not per-file greps scattered around):
//   1. the removed i18n keys must stay out of BOTH bundles — keyed by
//      namespace path, so a same-named key in another namespace (e.g. the
//      kept `auth.subtitle`, `launch.upload.hint`) doesn't false-positive;
//   2. each de-hinted route must not re-grow a `t('<its old key>')` call;
//   3. keep-list anchors: the dynamic header lines that LOOK like hints but
//      carry live data must survive (over-deletion guard).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '..', 'src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** namespace-path → the removed key names inside it. */
const REMOVED_HINT_KEYS: Record<string, string[]> = {
  tasks: ['hint'],
  agents: ['hint', 'detailHint', 'newHint'],
  workflows: ['hint'],
  plugins: ['hint', 'detailHint', 'newHint'],
  repos: ['hint'],
  reviews: ['hint'],
  mcps: ['hint', 'detailHint', 'newHint'],
  users: ['hint'],
  memory: ['hint'],
  account: ['subtitle'],
  editor: ['newHint'],
  settings: ['hintBacked', 'hintPatched', 'hintRestart'],
  skills: [
    'hintBefore',
    'hintManaged',
    'hintMid',
    'hintManagedPath',
    'hintBetween',
    'hintExternal',
    'hintAfter',
    'newHintBefore',
    'newHintManaged',
    'newHintMid',
    'newHintExternal',
    'newHintAfter',
  ],
  launch: ['hintBefore', 'hintCode', 'hintAfter'],
  'clarify.list': ['hint'],
}

/** route file → the t() keys its header used to render. */
const DEHINTED_ROUTES: Record<string, string[]> = {
  'routes/tasks.tsx': ['tasks.hint'],
  'routes/agents.tsx': ['agents.hint'],
  'routes/agents.detail.tsx': ['agents.detailHint'],
  'routes/agents.new.tsx': ['agents.newHint'],
  'routes/workflows.tsx': ['workflows.hint'],
  'routes/plugins.tsx': ['plugins.hint'],
  'routes/plugins.detail.tsx': ['plugins.detailHint'],
  'routes/plugins.new.tsx': ['plugins.newHint'],
  'routes/repos.tsx': ['repos.hint'],
  'routes/reviews.tsx': ['reviews.hint'],
  'routes/mcps.tsx': ['mcps.hint'],
  'routes/mcps.detail.tsx': ['mcps.detailHint'],
  'routes/mcps.new.tsx': ['mcps.newHint'],
  'routes/users.tsx': ['users.hint'],
  'routes/memory.tsx': ['memory.hint'],
  'routes/account.tsx': ['account.subtitle'],
  'routes/clarify.tsx': ['clarify.list.hint'],
  'routes/settings.tsx': ['settings.hintBacked', 'settings.hintPatched', 'settings.hintRestart'],
  'routes/skills.tsx': ['skills.hintBefore', 'skills.hintAfter'],
  'routes/skills.new.tsx': ['skills.newHintBefore', 'skills.newHintAfter'],
  'routes/workflows.edit.tsx': ['editor.newHint'],
  // RFC-165: routes/workflows.launch.tsx was deleted outright (wizard replaced it).
}

/**
 * Walk a bundle source and collect `namespace.path.key` for every literal key
 * line, tracking nesting by 2-space indentation (same grammar both bundles
 * use for both the type declaration and the value object).
 */
function collectKeyPaths(bundleSrc: string): Set<string> {
  const paths = new Set<string>()
  const stack: string[] = []
  for (const line of bundleSrc.split('\n')) {
    const open = line.match(/^( +)([A-Za-z0-9_]+): \{$/)
    if (open?.[1] !== undefined && open[2] !== undefined) {
      const level = open[1].length / 2
      stack.length = level - 1
      stack.push(open[2])
      continue
    }
    const key = line.match(/^( +)([A-Za-z0-9_]+):( |$)/)
    if (key?.[1] !== undefined && key[2] !== undefined) {
      const level = key[1].length / 2
      paths.add([...stack.slice(0, level - 1), key[2]].join('.'))
    }
  }
  return paths
}

describe('RFC-155 — removed hint keys stay out of both bundles', () => {
  const bundles = { 'i18n/zh-CN.ts': null, 'i18n/en-US.ts': null }
  for (const bundle of Object.keys(bundles)) {
    test(bundle, () => {
      const paths = collectKeyPaths(read(bundle))
      for (const [ns, keys] of Object.entries(REMOVED_HINT_KEYS)) {
        for (const key of keys) {
          expect(paths.has(`${ns}.${key}`), `${bundle} still defines ${ns}.${key}`).toBe(false)
        }
      }
      // Sanity: the walker itself works (a live key resolves).
      expect(paths.has('agents.title')).toBe(true)
    })
  }
})

describe('RFC-155 — de-hinted routes do not re-reference their old keys', () => {
  for (const [route, keys] of Object.entries(DEHINTED_ROUTES)) {
    test(route, () => {
      const src = read(route)
      for (const key of keys) {
        expect(src.includes(`t('${key}'`), `${route} re-references ${key}`).toBe(false)
      }
    })
  }
})

describe('RFC-155 — keep-list anchors (over-deletion guard)', () => {
  test('dynamic header lines survive', () => {
    // workflows.edit header status line (id · version · save state).
    expect(read('routes/workflows.edit.tsx')).toMatch(/statusSaving/)
    // reviews detail iteration/decision hint — also locked by
    // reviews-detail-title-description.test.ts.
    expect(read('routes/reviews.detail.tsx')).toMatch(/t\('reviews\.detailHint'/)
    // skills detail source-chip + path line.
    expect(read('routes/skills.detail.tsx')).toMatch(/managedPath \?\? meta\.data\.externalPath/)
    // auth landing subtitle is out of scope (not an in-app page header).
    expect(read('routes/auth.tsx')).toMatch(/auth-page__hint/)
  })
})
