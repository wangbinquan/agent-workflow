// RFC-302 — the workflow Dagre planner is a shared kernel. Keep the separate
// structure-graph renderer legal, but prevent frontend/backend from growing a
// second workflow-layout implementation or reviving the deleted facade.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO = resolve(import.meta.dir, '..', '..', '..')

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('RFC-302 workflow layout source ownership', () => {
  test('keeps one shared workflow planner and no frontend legacy facade', () => {
    const legacyFrontendPlanner = resolve(REPO, 'packages/frontend/src/lib/workflow-layout.ts')
    expect(existsSync(legacyFrontendPlanner)).toBe(false)

    const sources = ['shared', 'frontend', 'backend'].flatMap((name) =>
      sourceFiles(resolve(REPO, 'packages', name, 'src')),
    )
    const relativeSources = (needle: string): string[] =>
      sources
        .filter((path) => readFileSync(path, 'utf8').includes(needle))
        .map((path) => relative(REPO, path))
        .sort()

    expect(relativeSources('export function planWorkflowLayout(')).toEqual([
      'packages/shared/src/workflowLayout.ts',
    ])
    expect(relativeSources("from '@dagrejs/dagre'")).toEqual([
      'packages/frontend/src/lib/structureGraph.ts',
      'packages/shared/src/workflowLayout.ts',
    ])
  })
})
