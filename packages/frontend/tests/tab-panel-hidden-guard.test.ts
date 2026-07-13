// RFC-169 follow-up — regression lock for the keep-mounted tab-panel hidden bug.
//
// The agent Prompt tab and the skill Content tab render a fill-height
// MarkdownEditor via the `.agent-form__panel--prompt` class. That class needs
// `display: flex` for the fill layout — but a BARE `.agent-form__panel--prompt
// { display: flex }` overrides the UA rule `[hidden] { display: none }` (author
// beats UA), so the keep-mounted (hidden) panel stayed visible on EVERY tab,
// showing the edit/preview panes everywhere (user-reported: "每个 tab 页都有个
// 编辑预览窗", skills the same).
//
// jsdom (vitest, css:false) can't compute `display`, so this is a source-level
// lock: the panel's display rule MUST be scoped to `:not([hidden])` so the
// `hidden` attribute wins when the panel is inactive.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')

describe('agent-form__panel--prompt hidden guard', () => {
  test('the prompt/content panel display rule is scoped to :not([hidden])', () => {
    // The selector that carries `display: flex` must be guarded so it does not
    // override the keep-mounted `hidden` attribute.
    expect(CSS).toMatch(/\.agent-form__panel--prompt:not\(\[hidden\]\)\s*\{/)
  })

  test('there is no un-guarded `.agent-form__panel--prompt {` display rule', () => {
    // A bare `.agent-form__panel--prompt {` block (no :not([hidden])) would
    // re-introduce the override. Only the guarded selector may exist.
    expect(CSS).not.toMatch(/\.agent-form__panel--prompt\s*\{/)
  })
})
