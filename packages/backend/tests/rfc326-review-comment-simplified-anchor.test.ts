// RFC-326 — REST: the simplified anchor on POST /api/reviews/:nodeRunId/comments
// (proposal AC-11 / AC-12 / AC-13 / AC-16; design §4.1, §4.3, §5).
//
// WHY THIS FILE EXISTS (regression intent):
//   - The route accepts BOTH `{ anchor, … }` (web) and `{ quote?, occurrence?,
//     section?, … }` (server-resolved; everything absent = document-level) —
//     both at once is a 422 `review-comment-invalid`, so is `occurrence` /
//     `section` without a `quote`, so is any field over its length cap.
//   - What lands in the row is the resolver's anchor FIELD-BY-FIELD (AC-12), and
//     GET /api/reviews/:id hands it back unchanged, with the resolver `warnings`
//     on the 201 body.
//   - Multi-document rounds (any pending row with an item_index — a ONE-item
//     `list<path<md>>` round included) refuse to guess the document: 422
//     `review-doc-version-required`; a docVersionId that is not a pending member
//     of THIS run is a 404 `doc-version-not-found` (AC-13).
//   - Anchor refusals are 422s, never 500s (AC-16): a made-up web selectedText
//     used to escape as a bare Error.
//   - `verifiedBodyLimit` (P10): the 1 MiB ceiling is enforced on real bytes on
//     both write routes — an honest oversized Content-Length fails fast without
//     reading the body, and understated / malformed lengths as well as chunked
//     streams are still cut at the limit (413 `review-body-too-large`).
//   - Every refusal leaves review_comments untouched.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  REVIEW_ANCHOR_QUOTE_MAX_CHARS,
  REVIEW_ANCHOR_SECTION_MAX_CHARS,
  REVIEW_COMMENT_TEXT_MAX_CHARS,
} from '@agent-workflow/shared'
import type { ReviewCommentAnchor } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRuns, reviewComments, tasks, workflows } from '../src/db/schema'
import {
  buildReviewAnchorDocument,
  resolveReviewAnchor,
} from '../src/modules/collaboration/public/queries'
import { REVIEW_WRITE_BODY_MAX_BYTES } from '../src/routes/reviews'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEADERS = { Authorization: 'Bearer tok', 'content-type': 'application/json' }

const SINGLE_BODY = [
  '# Design v1',
  '',
  'The `order_status` enum should include partially_refunded.',
  '',
  '## Notes',
  '',
  'The enum is also referenced by the export job.',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '<!-- hidden reviewer note -->',
  '',
  'Closing paragraph.',
  '',
].join('\n')

interface DocRow {
  id: string
  body: string
}

interface Fixture {
  db: DbClient
  app: ReturnType<typeof createApp>
  taskId: string
  reviewRunId: string
  /** Pending members of the review run, in item order. */
  docs: DocRow[]
  /** A pending doc_version of ANOTHER review run (same task). */
  foreignPendingDocId: string
  /** A decided (non-pending) doc_version of the review run. */
  decidedDocId: string
  cleanup: () => void
}

type Mode = 'single' | 'multi-path' | 'multi-inline'

async function buildFixture(mode: Mode, bodies: string[] = [SINGLE_BODY]): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc326-rest-'))
  const appHome = join(tmp, 'appHome')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME
  // The route resolves doc_version bodies under Paths.root (AGENT_WORKFLOW_HOME).
  process.env.AGENT_WORKFLOW_HOME = appHome

  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'wf', definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const reviewRunId = ulid()
  const otherRunId = ulid()
  await db.insert(nodeRuns).values([
    {
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    },
    {
      id: otherRunId,
      taskId,
      nodeId: 'rev_2',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    },
  ])

  const writeBody = (id: string, body: string): string => {
    const rel = `doc_versions/${id}.md`
    writeFileSync(join(appHome, rel), body, 'utf8')
    return rel
  }
  const baseRow = (id: string, reviewNodeRunId: string, body: string, nodeId: string) => ({
    id,
    taskId,
    reviewNodeId: nodeId,
    reviewNodeRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: writeBody(id, body),
  })

  const docs: DocRow[] = []
  for (let i = 0; i < bodies.length; i++) {
    const id = ulid()
    const body = bodies[i]!
    await db.insert(docVersions).values({
      ...baseRow(id, reviewRunId, body, 'rev_1'),
      decision: 'pending',
      ...(mode === 'single'
        ? {}
        : {
            itemIndex: i,
            selection: 'unselected',
            itemPath: mode === 'multi-path' ? `cases/${i}.md` : null,
          }),
    })
    docs.push({ id, body })
  }
  const decidedDocId = ulid()
  await db.insert(docVersions).values({
    ...baseRow(decidedDocId, reviewRunId, '# old round\n', 'rev_1'),
    versionIndex: 0,
    decision: 'iterated',
    decidedAt: Date.now() - 1000,
  })
  const foreignPendingDocId = ulid()
  await db.insert(docVersions).values({
    ...baseRow(foreignPendingDocId, otherRunId, '# other review\n', 'rev_2'),
    decision: 'pending',
  })

  const app = createApp({
    token: 'tok',
    configPath: '',
    opencodeVersion: '1.14.99',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    taskId,
    reviewRunId,
    docs,
    foreignPendingDocId,
    decidedDocId,
    cleanup: () => {
      db.$client.close()
      rmSync(tmp, { recursive: true, force: true })
      if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousAppHome
    },
  }
}

async function postJson(
  f: Fixture,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await f.app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function commentsPath(f: Fixture): string {
  return `/api/reviews/${f.reviewRunId}/comments`
}

async function commentRowCount(f: Fixture): Promise<number> {
  return (await f.db.select().from(reviewComments)).length
}

function resolved(
  body: string,
  request: { quote?: string; occurrence?: number; section?: string },
) {
  const r = resolveReviewAnchor(buildReviewAnchorDocument(body), request)
  if (!r.ok) throw new Error(`fixture resolution failed: ${r.code}`)
  return r
}

describe('RFC-326 AC-11 / AC-12 — simplified anchors over REST', () => {
  let f: Fixture
  afterEach(() => f?.cleanup())

  test('quote → 201; the stored anchor is the resolver output field-by-field; GET hands it back', async () => {
    f = await buildFixture('single')
    const expected = resolved(SINGLE_BODY, { quote: 'partially_refunded' })
    const { status, json } = await postJson(f, commentsPath(f), {
      quote: 'partially_refunded',
      commentText: 'name the state explicitly',
    })
    expect(status).toBe(201)
    expect(json.anchor).toEqual(expected.anchor)
    expect(json.warnings).toEqual([])
    expect(json.docVersionId).toBe(f.docs[0]!.id)
    expect(json.commentText).toBe('name the state explicitly')

    const row = (await f.db.select().from(reviewComments))[0]!
    expect(row.anchorOffsetStart).toBe(expected.anchor.offsetStart)
    expect(row.anchorOffsetEnd).toBe(expected.anchor.offsetEnd)
    expect(row.occurrenceIndex).toBe(expected.anchor.occurrenceIndex)
    expect(row.anchorSectionPath).toBe(expected.anchor.sectionPath)
    expect(row.anchorParagraphIdx).toBe(expected.anchor.paragraphIdx)
    expect(row.selectedText).toBe('partially_refunded')

    const res = await f.app.fetch(
      new Request(`http://localhost/api/reviews/${f.reviewRunId}`, { headers: HEADERS }),
    )
    expect(res.status).toBe(200)
    const detail = (await res.json()) as { comments: Array<{ anchor: ReviewCommentAnchor }> }
    expect(detail.comments.length).toBe(1)
    expect(detail.comments[0]!.anchor).toEqual(expected.anchor)
  })

  test('occurrence / section narrow a repeated quote; both name the same occurrence', async () => {
    f = await buildFixture('single')
    const expected = resolved(SINGLE_BODY, { quote: 'enum', occurrence: 2 })
    const bySection = await postJson(f, commentsPath(f), {
      quote: 'enum',
      section: 'Notes',
      commentText: 'second mention',
    })
    expect(bySection.status).toBe(201)
    expect(bySection.json.anchor).toEqual(expected.anchor)
    const byOccurrence = await postJson(f, commentsPath(f), {
      quote: 'enum',
      occurrence: 2,
      commentText: 'second mention again',
    })
    expect(byOccurrence.status).toBe(201)
    expect(byOccurrence.json.anchor).toEqual(expected.anchor)
    expect((expected.anchor as ReviewCommentAnchor).occurrenceIndex).toBe(2)
  })

  test('no locator at all = document-level comment on the title', async () => {
    f = await buildFixture('single')
    const expected = resolved(SINGLE_BODY, {})
    const { status, json } = await postJson(f, commentsPath(f), { commentText: 'overall: fine' })
    expect(status).toBe(201)
    expect(json.anchor).toEqual(expected.anchor)
    expect((json.anchor as ReviewCommentAnchor).selectedText).toBe('Design v1')
  })

  test('the web form still works and its offsets are canonicalised', async () => {
    f = await buildFixture('single')
    const second = SINGLE_BODY.indexOf('enum is also')
    const posted: ReviewCommentAnchor = {
      sectionPath: '## Notes',
      paragraphIdx: 0,
      offsetStart: 0, // wrong on purpose
      offsetEnd: 4,
      selectedText: 'enum',
      contextBefore: SINGLE_BODY.slice(second - 30, second),
      contextAfter: SINGLE_BODY.slice(second + 4, second + 34),
      occurrenceIndex: 1,
    }
    const { status, json } = await postJson(f, commentsPath(f), {
      anchor: posted,
      commentText: 'web',
    })
    expect(status).toBe(201)
    const anchor = json.anchor as ReviewCommentAnchor
    expect(anchor.occurrenceIndex).toBe(2)
    expect(anchor.offsetStart).toBe(second)
    expect(anchor.offsetEnd).toBe(second + 4)
    expect(anchor.sectionPath).toBe('## Notes')
    expect(json.warnings).toEqual([])
  })

  test('warnings ride on the 201: code block / spans blocks / no rendered projection', async () => {
    f = await buildFixture('single')
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ quote: 'const x = 1' }, 'quote-in-code-block'],
      [{ quote: 'partially_refunded.\n\n## Notes' }, 'quote-spans-blocks'],
      [{ quote: 'hidden reviewer note' }, 'quote-has-no-rendered-projection'],
    ]
    for (const [locator, warning] of cases) {
      const { status, json } = await postJson(f, commentsPath(f), {
        ...locator,
        commentText: `w:${warning}`,
      })
      if (warning === 'quote-spans-blocks') {
        // Crossing a heading is a refusal, not a warning — use a paragraph pair.
        expect(status).toBe(422)
        expect(json.code).toBe('review-anchor-crosses-heading')
        continue
      }
      expect(status).toBe(201)
      expect(json.warnings).toEqual([warning])
    }
    const spans = await postJson(f, commentsPath(f), {
      quote: 'export job.\n\n```ts',
      commentText: 'spans',
    })
    expect(spans.status).toBe(201)
    expect(spans.json.warnings).toContain('quote-spans-blocks')
  })
})

describe('RFC-326 AC-11 / AC-16 — refusals are 422s and write nothing', () => {
  let f: Fixture
  afterEach(() => f?.cleanup())

  test('exclusivity, dangling occurrence/section, and the three length caps', async () => {
    f = await buildFixture('single')
    const anchor = resolved(SINGLE_BODY, { quote: 'enum', occurrence: 1 }).anchor
    const bodies: Array<Record<string, unknown>> = [
      { anchor, quote: 'enum', commentText: 'both' },
      { occurrence: 1, commentText: 'no quote' },
      { section: 'Notes', commentText: 'no quote' },
      { quote: 'x'.repeat(REVIEW_ANCHOR_QUOTE_MAX_CHARS + 1), commentText: 'long quote' },
      {
        quote: 'enum',
        section: 's'.repeat(REVIEW_ANCHOR_SECTION_MAX_CHARS + 1),
        commentText: 'long section',
      },
      { quote: 'enum', commentText: 'c'.repeat(REVIEW_COMMENT_TEXT_MAX_CHARS + 1) },
      { quote: 'enum', commentText: '' },
    ]
    for (const body of bodies) {
      const { status, json } = await postJson(f, commentsPath(f), body)
      expect(status).toBe(422)
      expect(json.code).toBe('review-comment-invalid')
    }
    expect(await commentRowCount(f)).toBe(0)
  })

  test('resolver refusals: not-found carries suggestions, ambiguous carries candidates + exact total', async () => {
    f = await buildFixture('single')
    const notFound = await postJson(f, commentsPath(f), {
      quote: 'ENUM SHOULD include',
      commentText: 'x',
    })
    expect(notFound.status).toBe(422)
    expect(notFound.json.code).toBe('review-anchor-not-found')
    const nf = notFound.json.details as { suggestions: Array<{ sourceText: string }> }
    expect(nf.suggestions.map((s) => s.sourceText)).toContain('enum should include')

    const ambiguous = await postJson(f, commentsPath(f), { quote: 'enum', commentText: 'x' })
    expect(ambiguous.status).toBe(422)
    expect(ambiguous.json.code).toBe('review-anchor-ambiguous')
    const amb = ambiguous.json.details as { candidates: unknown[]; total: number }
    expect(amb.total).toBe(2)
    expect(amb.candidates.length).toBe(2)

    const outOfRange = await postJson(f, commentsPath(f), {
      quote: 'enum',
      occurrence: 3,
      commentText: 'x',
    })
    expect(outOfRange.status).toBe(422)
    expect(outOfRange.json.code).toBe('review-anchor-occurrence-out-of-range')
    expect(await commentRowCount(f)).toBe(0)
  })

  test('AC-16: a made-up web selectedText is a 422 anchor-selection-not-found, not a 500', async () => {
    f = await buildFixture('single')
    const { status, json } = await postJson(f, commentsPath(f), {
      anchor: {
        sectionPath: '',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 5,
        selectedText: 'never in this document',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'x',
    })
    expect(status).toBe(422)
    expect(json.code).toBe('anchor-selection-not-found')
    expect(await commentRowCount(f)).toBe(0)
  })
})

describe('RFC-326 AC-13 — multi-document rounds name their document', () => {
  let f: Fixture
  afterEach(() => f?.cleanup())

  test('two pending items: docVersionId omitted → 422; wrong ids → 404; right id → 201', async () => {
    f = await buildFixture('multi-path', ['# A\n\nalpha text\n', '# B\n\nbeta text\n'])
    const omitted = await postJson(f, commentsPath(f), { quote: 'alpha', commentText: 'x' })
    expect(omitted.status).toBe(422)
    expect(omitted.json.code).toBe('review-doc-version-required')

    for (const id of [f.decidedDocId, f.foreignPendingDocId, 'does-not-exist']) {
      const { status, json } = await postJson(f, commentsPath(f), {
        quote: 'alpha',
        commentText: 'x',
        docVersionId: id,
      })
      expect(status).toBe(404)
      expect(json.code).toBe('doc-version-not-found')
    }
    expect(await commentRowCount(f)).toBe(0)

    const ok = await postJson(f, commentsPath(f), {
      quote: 'beta',
      commentText: 'on B',
      docVersionId: f.docs[1]!.id,
    })
    expect(ok.status).toBe(201)
    expect(ok.json.docVersionId).toBe(f.docs[1]!.id)
    expect(ok.json.anchor).toEqual(resolved('# B\n\nbeta text\n', { quote: 'beta' }).anchor)
    const rows = await f.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, f.docs[1]!.id))
    expect(rows.length).toBe(1)
  })

  test('a ONE-item multi-document round is still multi-document (item_index set)', async () => {
    f = await buildFixture('multi-inline', ['# Only\n\nsolo text\n'])
    const omitted = await postJson(f, commentsPath(f), { quote: 'solo', commentText: 'x' })
    expect(omitted.status).toBe(422)
    expect(omitted.json.code).toBe('review-doc-version-required')
    expect(await commentRowCount(f)).toBe(0)
    const ok = await postJson(f, commentsPath(f), {
      quote: 'solo',
      commentText: 'x',
      docVersionId: f.docs[0]!.id,
    })
    expect(ok.status).toBe(201)
  })

  test('single-document rounds keep the implicit target; a foreign docVersionId is still a 404', async () => {
    f = await buildFixture('single')
    const foreign = await postJson(f, commentsPath(f), {
      quote: 'enum',
      occurrence: 1,
      commentText: 'x',
      docVersionId: f.foreignPendingDocId,
    })
    expect(foreign.status).toBe(404)
    expect(foreign.json.code).toBe('doc-version-not-found')
    const ok = await postJson(f, commentsPath(f), {
      quote: 'enum',
      occurrence: 1,
      commentText: 'x',
    })
    expect(ok.status).toBe(201)
    expect(ok.json.docVersionId).toBe(f.docs[0]!.id)
  })
})

describe('RFC-326 P10 — verified body limit on both review write routes', () => {
  let f: Fixture
  afterEach(() => f?.cleanup())

  function streamOver(limit: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    let emitted = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
        emitted += chunk.byteLength
        if (emitted > limit) controller.close()
      },
    })
  }

  function request(
    path: string,
    body: ReadableStream<Uint8Array>,
    contentLength?: string,
  ): Request {
    const headers = new Headers(HEADERS)
    if (contentLength !== undefined) headers.set('content-length', contentLength)
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  }

  async function expect413(req: Request, label: string): Promise<void> {
    const res = await Promise.race([
      f.app.fetch(req),
      Bun.sleep(1500).then(() => {
        throw new Error(`${label}: the handler tried to consume a body it should have refused`)
      }),
    ])
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ ok: false, code: 'review-body-too-large' })
    await req.body?.cancel().catch(() => {})
  }

  test('honest oversized Content-Length fails fast; understated / malformed / chunked are cut at the limit', async () => {
    f = await buildFixture('single')
    const paths = [commentsPath(f), `/api/reviews/${f.reviewRunId}/decision`]
    for (const path of paths) {
      // This stream never yields a byte: only the declaration can produce the 413.
      const never = new ReadableStream<Uint8Array>({ pull() {} })
      await expect413(request(path, never, String(REVIEW_WRITE_BODY_MAX_BYTES + 1)), 'declared')
      for (const bad of ['-1', 'NaN', String(Number.MAX_SAFE_INTEGER + 1)]) {
        await expect413(request(path, new ReadableStream({ pull() {} }), bad), `malformed ${bad}`)
      }
      await expect413(request(path, streamOver(REVIEW_WRITE_BODY_MAX_BYTES), '1'), 'understated')
      await expect413(request(path, streamOver(REVIEW_WRITE_BODY_MAX_BYTES)), 'chunked')
    }
    expect(await commentRowCount(f)).toBe(0)
    const run = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.reviewRunId)))[0]!
    expect(run.status).toBe('awaiting_review')
  })

  test('a body just under the limit still reaches the handler', async () => {
    f = await buildFixture('single')
    const padding = 'p'.repeat(REVIEW_WRITE_BODY_MAX_BYTES - 200)
    const { status, json } = await postJson(f, commentsPath(f), {
      quote: 'partially_refunded',
      commentText: padding.slice(0, REVIEW_COMMENT_TEXT_MAX_CHARS),
      // Unknown keys are ignored by the schema; they only inflate the byte size.
      padding: padding.slice(REVIEW_COMMENT_TEXT_MAX_CHARS),
    })
    expect(status).toBe(201)
    expect(json.warnings).toEqual([])
  })
})
