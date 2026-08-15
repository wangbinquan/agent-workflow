import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8')
}

/**
 * These are the page-level surfaces found by the 2026-07-30 banner-spacing
 * audit. The minimum invocation count prevents a later refactor from silently
 * returning one of the independently rendered feedback groups to a bare,
 * zero-gap page container.
 */
const COVERAGE: ReadonlyArray<readonly [file: string, minimumStacks: number]> = [
  ['routes/users.tsx', 1],
  ['routes/skills.detail.tsx', 1],
  ['routes/skills.new.tsx', 1],
  ['routes/tasks.new.tsx', 1],
  ['routes/settings.tsx', 2],
  ['routes/agents.detail.tsx', 1],
  ['routes/agents.new.tsx', 1],
  ['routes/mcps.detail.tsx', 1],
  ['routes/mcps.new.tsx', 1],
  ['routes/plugins.detail.tsx', 1],
  ['routes/plugins.new.tsx', 1],
  // User-reported regression (2026-08-15): the live-update banner above the
  // task operations surface also needs the standard section gap.
  ['routes/tasks.tsx', 2],
  ['routes/reviews.tsx', 1],
  ['routes/clarify.tsx', 1],
  ['routes/scheduled.tsx', 1],
  ['routes/memory.tsx', 1],
  ['routes/fusions.detail.tsx', 1],
  ['routes/scheduled.$id.tsx', 2],
  ['routes/clarify.detail.tsx', 2],
  ['routes/workgroups.detail.tsx', 1],
  ['components/canvas/NodeInspector.tsx', 1],
  ['components/gallery/ResourceGalleryPage.tsx', 1],
  ['components/intent/IntentOpPreview.tsx', 1],
  ['components/intent/IntentSessionList.tsx', 1],
  ['components/intent/IntentTurnSession.tsx', 1],
  ['components/mcps/McpInventoryPanel.tsx', 1],
  ['components/ModelSelect.tsx', 2],
  ['components/NodeDetailDrawer.tsx', 2],
  ['components/memory/MemoryAllList.tsx', 1],
  ['components/memory/MemoryApprovalQueue.tsx', 1],
  ['components/memory/MemoryDistillJobsTable.tsx', 1],
  ['components/memory/MemoryFusionList.tsx', 2],
  ['components/memory/MemoryScopedList.tsx', 2],
  ['components/skill/SkillVersionHistory.tsx', 1],
]

describe('page feedback spacing coverage', () => {
  test.each(COVERAGE)('%s keeps every audited feedback group explicit', (file, minimumStacks) => {
    const source = read(file)
    expect(source).toContain("from '@/components/FeedbackStack'")
    expect(source.match(/<FeedbackStack(?:\s|>)/g)?.length ?? 0).toBeGreaterThanOrEqual(
      minimumStacks,
    )
  })
})
