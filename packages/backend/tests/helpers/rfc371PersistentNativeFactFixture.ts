// Real original OpenCode/WAL pages, shared by the persistent-page provider and Worker gates.
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoricalNativeUsageQuery } from '@/modules/runtime-management/composition/historicalNativeUsage'
import { createOpencodeNativeVersionObserver } from '@/modules/runtime-management/infrastructure/opencodeNativeVersionObserver'
import { openHistoricalOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import type {
  HistoricalNativeObservationPage,
  HistoricalNativeObservationReader,
} from '@agent-workflow/shared'
import type { HistoricalNativeFactReader } from '@/modules/run-observability/ports/historicalNativeFacts'
import { COMPLETE_NOW } from './rfc371CompleteTaskFixture'

export function persistentNativeFixture(options: { steps?: number; depth?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aw-persistent-native-facts-')),
    path = join(home, 'original-opencode.db'),
    writer = new Database(path)
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id,id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,id);`)
  const session = (id: string, parent: string | null = null) =>
    writer.run('INSERT INTO session VALUES (?,?,?)', [id, parent, COMPLETE_NOW])
  const part = (
    id: string,
    owner: string,
    value: unknown,
    model: string | null = 'actual-model',
    at: number | null = COMPLETE_NOW + 1,
  ) => {
    const message = 'message-' + id
    writer.run('INSERT INTO message VALUES (?,?,?)', [
      message,
      owner,
      JSON.stringify(
        model === null
          ? { role: 'assistant' }
          : { role: 'assistant', providerID: 'actual-provider', modelID: model },
      ),
    ])
    writer.run('INSERT INTO part VALUES (?,?,?,?,?)', [
      id,
      owner,
      message,
      at,
      JSON.stringify(value),
    ])
  }
  writer.transaction(() => {
    session('root')
    session('empty')
    writer.run('UPDATE session SET time_created=NULL WHERE id=?', ['empty'])
    for (let n = 0; n < (options.depth ?? 4); n++)
      session('child-' + n, n === 0 ? 'root' : 'child-' + (n - 1))
    session('unrelated')
    for (let n = 0; n < (options.steps ?? 23); n++)
      part('step-' + String(n).padStart(5, '0'), n % 2 ? 'child-0' : 'root', {
        type: 'step-finish',
        tokens: {
          input: String(n + 1),
          output: 5,
          reasoning: 2,
          cache: { read: 11, write: 13 },
        },
        text: 'ORIGINAL_CONVERSATION_BODY_MUST_NOT_BE_CACHED',
      })
    for (let n = 0; n < 41; n++)
      part('text-' + n, 'root', { type: 'text', text: 'ORIGINAL_TOOL_BODY_MUST_NOT_BE_CACHED' })
    part('unfinished', 'root', { type: 'step-start' })
    part('zero', 'root', {
      type: 'step-finish',
      tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    })
    part(
      'no-model-or-time',
      'root',
      {
        type: 'step-finish',
        tokens: { input: '9007199254740997', output: 1, cache: { read: 2, write: 3 } },
      },
      null,
      null,
    )
    part('outside', 'unrelated', {
      type: 'step-finish',
      tokens: { input: '999999999999999999', output: 1, cache: { read: 2, write: 3 } },
    })
  })()
  const observer = createOpencodeNativeVersionObserver(path)
  // This uses the original composition and reader; pageRows is an I/O batch, never a total cap.
  const original = createHistoricalNativeUsageQuery({ OPENCODE_DB: path })
  const query = {
    generation: original.generation,
    async open(selection: Parameters<typeof original.open>[0]) {
      const selected = await original.open(selection)
      if (!selected) return null
      const identity = selected.identity
      selected.close()
      return openHistoricalOpencodeUsagePass(path, identity, { pageRows: 3 })
    },
  }
  let closed = false
  return {
    home,
    path,
    writer,
    observer,
    query,
    part,
    session,
    selection: (rootSessionId = 'root') => ({
      rootSessionId,
      referenceId: JSON.stringify(['historical-native-root', rootSessionId]),
    }),
    async close() {
      if (closed) return
      closed = true
      await observer.close()
      writer.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Every original page is acknowledged through real EOF; callers compare the full documents. */
export async function consumeNativeFactReader(
  reader: HistoricalNativeFactReader | HistoricalNativeObservationReader,
) {
  const pages: HistoricalNativeObservationPage[] = []
  let cursor: string | null = reader.initialCursor
  try {
    while (cursor !== null) {
      const page = await reader.next(cursor)
      pages.push(page)
      await reader.acknowledge(page.ordinal, page.payloadDigest)
      cursor = page.nextCursor
    }
    return pages
  } finally {
    await reader.close()
  }
}
