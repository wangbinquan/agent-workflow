// RFC-035 PR3 — source-level guard for the EmptyState / LoadingState
// rollout. Each retrofitted route MUST import + render the shared
// primitives instead of the bare `<div className="muted">` pattern.

// ⚠️ RFC-317 T64（findings G-06）—— 本文件只覆盖 `RETROFITTED_ROUTES` 里的路由，
// 不是全前端棘轮：新写一个自造空状态在这里不会红。下面那条 coverage 自证至少防住
// 「删条目消红」——名单只能增不能减，且每个条目必须指向真实文件。
import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const RETROFITTED_ROUTES = [
  // RFC-169: the four resource pages (agents / skills / mcps / plugins) moved
  // their list loading/empty states into the shared ResourceSplitPage (asserted
  // separately below); their empty panes still render <EmptyState>.
  // RFC-191: workflows/workgroups likewise moved theirs into the shared
  // ResourceGalleryPage (asserted separately below).
  'routes/tasks.tsx',
  'routes/reviews.tsx',
  'routes/repos.tsx',
] as const

describe('RFC-035 EmptyState / LoadingState rollout', () => {
  for (const rel of RETROFITTED_ROUTES) {
    test(`${rel} renders <LoadingState> + <EmptyState>`, () => {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(/<LoadingState[\s/>]/.test(body), `${rel} <LoadingState>`).toBe(true)
      expect(/<EmptyState[\s/>]/.test(body), `${rel} <EmptyState>`).toBe(true)
    })
  }

  // RFC-169: the split shell is where the four resource pages' list
  // loading/empty states now live.
  test('components/split/ResourceSplitPage.tsx renders <LoadingState> + <EmptyState>', () => {
    const body = readFileSync(path.resolve(SRC, 'components/split/ResourceSplitPage.tsx'), 'utf8')
    expect(/<LoadingState[\s/>]/.test(body)).toBe(true)
    expect(/<EmptyState[\s/>]/.test(body)).toBe(true)
  })

  // RFC-191: the gallery shell is where workflows/workgroups' list
  // loading/empty states now live.
  test('components/gallery/ResourceGalleryPage.tsx renders <LoadingState> + <EmptyState>', () => {
    const body = readFileSync(
      path.resolve(SRC, 'components/gallery/ResourceGalleryPage.tsx'),
      'utf8',
    )
    expect(/<LoadingState[\s/>]/.test(body)).toBe(true)
    expect(/<EmptyState[\s/>]/.test(body)).toBe(true)
  })

  test('home/InboxPreviewList.tsx renders the compact <EmptyState>', () => {
    const body = readFileSync(path.resolve(SRC, 'components/home/InboxPreviewList.tsx'), 'utf8')
    expect(/<EmptyState[\s\S]+?size="compact"/.test(body)).toBe(true)
  })

  test('retrofitted routes no longer render <div className="muted">{t(\'common.loading\')}</div>', () => {
    for (const rel of RETROFITTED_ROUTES) {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(
        /<div className="muted">\{t\('common\.loading'\)\}<\/div>/.test(body),
        `${rel} contains the old loading pattern`,
      ).toBe(false)
    }
  })
})

// RFC-317 T64（findings G-06）—— **名单只能增不能减**。
//
// 本文件的判据是「这些路由用了 EmptyState / LoadingState」。它对新路由完全失明，
// 那部分覆盖由别处承担；这里至少堵住最容易的一条退路：**把条目从名单里删掉来消红**。
describe('RFC-317 T64 —— 迁移名单的 coverage 自证', () => {
  test('名单非空，且每个条目都指向真实文件（删条目消红会在这里红）', () => {
    // 3 是**今天的真实条数**（RFC-169 / RFC-191 把另外六个资源页的空/载入态搬进了
    // 共享的 ResourceSplitPage / ResourceGalleryPage，那部分由本文件下方各自的断言覆盖，
    // 不再逐路由列在这里）。写死当前值而不是拍一个更大的数：目的是「不许减」，
    // 不是「必须涨」。
    expect(RETROFITTED_ROUTES.length).toBe(3)
    for (const route of RETROFITTED_ROUTES) {
      expect(existsSync(path.resolve(SRC, route)), `名单里的 ${route} 不存在`).toBe(true)
    }
  })
})
