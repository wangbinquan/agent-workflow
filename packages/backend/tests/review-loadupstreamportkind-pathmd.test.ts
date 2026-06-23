// Regression — a `path<md>` upstream port must drive a review node to READ the
// markdown file, not review the literal worktree-path string.
//
// Bug: loadUpstreamPortKind (review.ts) hand-rolled a literal
// {markdown, markdown_file, string} recognition list that silently dropped the
// equivalent parametric `path<md>` spelling → returned undefined →
// dispatchReviewNode passed `kind: undefined` to resolvePortContentDetailed,
// which raw-passes the content through (RFC-049 PR-B removed the forgiveness
// file-read). So the review saw "docs/design.md" as the body instead of the
// file's content. Fix: delegate to the canonical isReviewableBodyKindString
// predicate (kindParser), which accepts markdown / path<md> / path<markdown> /
// markdown_file uniformly — the same predicate the validator uses.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { isReviewableBodyKindString, type WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { loadUpstreamPortKind } from '../src/services/review'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function agentPayload(name: string, outputKinds: Record<string, string>) {
  return {
    name,
    description: '',
    outputs: Object.keys(outputKinds),
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    outputKinds,
  }
}

function defWith(nodeId: string, agentName: string): WorkflowDefinition {
  return {
    nodes: [{ id: nodeId, kind: 'agent-single', agentName, position: { x: 0, y: 0 } }],
    edges: [],
  } as unknown as WorkflowDefinition
}

describe('loadUpstreamPortKind — path<md> recognition (review file-read fix)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('path<md> port → returned (so resolvePortContentDetailed reads the .md file)', async () => {
    await createAgent(db, agentPayload('a-pathmd', { doc: 'path<md>' }))
    const k = await loadUpstreamPortKind(db, defWith('n1', 'a-pathmd'), 'n1', 'doc')
    expect(k).toBe('path<md>')
    expect(isReviewableBodyKindString(k!)).toBe(true)
  })

  test('legacy markdown_file → returned as a file-read (reviewable) kind', async () => {
    await createAgent(db, agentPayload('a-mf', { doc: 'markdown_file' }))
    const k = await loadUpstreamPortKind(db, defWith('n1', 'a-mf'), 'n1', 'doc')
    expect(k).toBeDefined()
    expect(isReviewableBodyKindString(k!)).toBe(true)
  })

  test('inline markdown → returned unchanged', async () => {
    await createAgent(db, agentPayload('a-md', { doc: 'markdown' }))
    expect(await loadUpstreamPortKind(db, defWith('n1', 'a-md'), 'n1', 'doc')).toBe('markdown')
  })

  test('list<path<md>> → returned (multi-document review)', async () => {
    await createAgent(db, agentPayload('a-list', { doc: 'list<path<md>>' }))
    expect(await loadUpstreamPortKind(db, defWith('n1', 'a-list'), 'n1', 'doc')).toBe(
      'list<path<md>>',
    )
  })

  test('non-markdownish kind (signal) → undefined', async () => {
    await createAgent(db, agentPayload('a-sig', { doc: 'signal' }))
    expect(await loadUpstreamPortKind(db, defWith('n1', 'a-sig'), 'n1', 'doc')).toBeUndefined()
  })

  test('port not declared in outputKinds → undefined', async () => {
    await createAgent(db, agentPayload('a-none', { other: 'path<md>' }))
    expect(await loadUpstreamPortKind(db, defWith('n1', 'a-none'), 'n1', 'doc')).toBeUndefined()
  })
})
