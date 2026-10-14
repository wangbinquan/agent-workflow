// RFC-371 v2 §4: each RuntimeDriver meters its own stdout protocol into one
// replaceable per-model snapshot.
//  - OpenCode: root step_finish parts are de-duplicated by part id; a `task`
//    tool (delegated sub-agent) makes the stream view partial; after the process
//    drained one bounded read of the native store (root tree, steps created since
//    the invocation started) replaces it, but only when that store has recorded
//    every root step the stream saw.
//  - Claude Code: split assistant events keep the largest usage per message; the
//    result's modelUsage replaces the stream view unless the session was resumed
//    or the result is an error_during_execution all-zero report.
// Windows (CI 38601555253): the store path follows the child's own home
// (`USERPROFILE` first) with win32 separators; fixture stores are closed and
// their directories removed through fixtures/tempDir (an open SQLite file
// cannot be deleted there), and bulk fixture rows share one transaction.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeUsageMeter } from '@/services/runtime/opencode/usage'
import {
  OPENCODE_TREE_MAX_SESSIONS,
  opencodeUsageDatabasePath,
  readOpencodeTreeUsage,
} from '@/services/runtime/opencode/nativeUsage'
import { usageMeter as claudeUsageMeter } from '@/services/runtime/claudeCode/usage'
import { getRuntimeDriver } from '@/services/runtime'
import { removeTempDirSync } from './fixtures/tempDir'

const dirs: string[] = []
const stores: Database[] = []
afterEach(() => {
  for (const db of stores.splice(0)) db.close()
  for (const dir of dirs.splice(0)) removeTempDirSync(dir)
})

const step = (session: string, id: string, input: number, output: number, reasoning = 0) => ({
  type: 'step_finish',
  sessionID: session,
  part: { id, tokens: { input, output, reasoning, cache: { read: 1, write: 2 } } },
})

/** A minimal OpenCode store: only the columns the summary reads. */
function nativeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc371-native-'))
  dirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  stores.push(db)
  // A fixture needs no durability; per-row journal files and syncs are slow on Windows.
  db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;')
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  let n = 0
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?, ?)').run(id, parent)
  const finished = (
    sessionId: string,
    at: number,
    model: { provider: string; model: string },
    tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  ) => {
    const message = `msg-${++n}`
    db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      message,
      sessionId,
      at,
      JSON.stringify({ role: 'assistant', providerID: model.provider, modelID: model.model }),
    )
    db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
      `part-${n}`,
      message,
      sessionId,
      at,
      JSON.stringify({
        type: 'step-finish',
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: { read: tokens.read, write: tokens.write },
        },
      }),
    )
    // A non-step part never counts.
    db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
      `text-${n}`,
      message,
      sessionId,
      at,
      JSON.stringify({ type: 'text', text: 'content is never read' }),
    )
  }
  return { path, db, session, finished }
}

describe('RFC-371 v2 OpenCode stream meter', () => {
  test('root steps are de-duplicated by id and reasoning joins output once', () => {
    const meter = createOpencodeUsageMeter({ resumed: false, configuredModel: 'p/m' })
    expect(meter.observe(step('root', 'a', 100, 10, 5))).toBe(true)
    expect(meter.observe(step('root', 'a', 100, 10, 5))).toBe(false)
    expect(meter.observe({ type: 'text', sessionID: 'root', part: { text: 'x' } })).toBe(false)
    expect(meter.observe(step('root', 'b', 1, 1))).toBe(true)
    expect(meter.snapshot()).toEqual({
      state: 'complete',
      models: [{ model: 'p/m', input: 101, cacheRead: 2, cacheWrite: 4, output: 16, reasoning: 5 }],
    })
  })

  test('a delegated sub-agent makes the stream view partial; no configured model is unattributed', () => {
    const meter = createOpencodeUsageMeter({ resumed: false, configuredModel: null })
    meter.observe(step('root', 'a', 3, 4))
    expect(meter.observe({ type: 'tool_use', sessionID: 'root', part: { tool: 'bash' } })).toBe(
      false,
    )
    expect(meter.observe({ type: 'tool_use', sessionID: 'root', part: { tool: 'task' } })).toBe(
      true,
    )
    expect(meter.observe({ type: 'tool_use', sessionID: 'root', part: { tool: 'task' } })).toBe(
      false,
    )
    expect(meter.snapshot()).toMatchObject({ state: 'partial', models: [{ model: '', input: 3 }] })
  })

  test('without a native store the stream snapshot stays final', () => {
    for (const env of [{ OPENCODE_DB: ':memory:' }, {}]) {
      const meter = createOpencodeUsageMeter({ resumed: false, configuredModel: null, env })
      meter.observe(step('root', 'a', 3, 4))
      expect(meter.finish?.()).toBeNull()
    }
  })
})

describe('RFC-371 v2 OpenCode native summary', () => {
  test('the database path follows OPENCODE_DB and the XDG data directory', () => {
    const linux = (env: Record<string, string>) => opencodeUsageDatabasePath(env, 'linux')
    expect(linux({ OPENCODE_DB: ':memory:', HOME: '/home/u' })).toBeNull()
    expect(linux({ OPENCODE_DB: '/abs/x.db' })).toBe('/abs/x.db')
    expect(linux({ XDG_DATA_HOME: '/data', HOME: '/home/u' })).toBe('/data/opencode/opencode.db')
    expect(linux({ HOME: '/home/u', OPENCODE_DB: 'other.db' })).toBe(
      '/home/u/.local/share/opencode/other.db',
    )
    // USERPROFILE is a Windows variable; POSIX children resolve their home from HOME.
    expect(linux({ USERPROFILE: '/home/u' })).toBeNull()
    expect(linux({ HOME: 'relative' })).toBeNull()
    expect(linux({ XDG_DATA_HOME: 'relative', HOME: '/home/u' })).toBeNull()
  })

  test('a Windows child resolves its store from USERPROFILE with win32 paths', () => {
    const windows = (env: Record<string, string>) => opencodeUsageDatabasePath(env, 'win32')
    expect(windows({ USERPROFILE: 'C:\\Users\\u', HOME: 'C:\\other' })).toBe(
      'C:\\Users\\u\\.local\\share\\opencode\\opencode.db',
    )
    expect(windows({ HOME: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\.local\\share\\opencode\\opencode.db',
    )
    expect(windows({ XDG_DATA_HOME: 'D:\\xdg', USERPROFILE: 'C:\\Users\\u' })).toBe(
      'D:\\xdg\\opencode\\opencode.db',
    )
    expect(windows({ OPENCODE_DB: 'D:\\stores\\x.db' })).toBe('D:\\stores\\x.db')
    expect(windows({ USERPROFILE: 'relative' })).toBeNull()
    expect(windows({})).toBeNull()
  })

  test('the root tree since the invocation started is summed per actual model', () => {
    const store = nativeStore()
    const sonnet = { provider: 'anthropic', model: 'sonnet' }
    const haiku = { provider: 'anthropic', model: 'haiku' }
    const tokens = (input: number, output: number, reasoning = 0) => ({
      input,
      output,
      reasoning,
      read: 10,
      write: 1,
    })
    store.session('root')
    store.session('child', 'root')
    store.session('grandchild', 'child')
    store.session('sibling-root')
    store.session('foreign-child', 'sibling-root')
    // Before this invocation (a resumed session's earlier run): excluded.
    store.finished('root', 900, sonnet, tokens(1000, 1000))
    store.finished('root', 1000, sonnet, tokens(100, 20, 5))
    store.finished('child', 1100, haiku, tokens(40, 4))
    store.finished('grandchild', 1200, haiku, tokens(2, 1))
    store.finished('foreign-child', 1300, haiku, tokens(9999, 9999))
    expect(readOpencodeTreeUsage(store.path, ['root'], 1000)).toEqual({
      rootSteps: 1,
      models: [
        {
          model: 'anthropic/haiku',
          input: 42,
          cacheRead: 20,
          cacheWrite: 2,
          output: 5,
          reasoning: 0,
        },
        {
          model: 'anthropic/sonnet',
          input: 100,
          cacheRead: 10,
          cacheWrite: 1,
          output: 25,
          reasoning: 5,
        },
      ],
    })
    const meter = createOpencodeUsageMeter({
      resumed: true,
      configuredModel: null,
      env: { OPENCODE_DB: store.path },
      now: () => 1000,
    })
    meter.observe(step('root', 'stream-step', 100, 20, 5))
    meter.observe({ type: 'tool_use', sessionID: 'root', part: { tool: 'task' } })
    expect(meter.finish?.()).toEqual({
      state: 'complete',
      models: [
        {
          model: 'anthropic/haiku',
          input: 42,
          cacheRead: 20,
          cacheWrite: 2,
          output: 5,
          reasoning: 0,
        },
        {
          model: 'anthropic/sonnet',
          input: 100,
          cacheRead: 10,
          cacheWrite: 1,
          output: 25,
          reasoning: 5,
        },
      ],
    })
  })

  test('a store missing root steps the stream saw is not this invocation’s store', () => {
    const store = nativeStore()
    store.session('root')
    const meter = createOpencodeUsageMeter({
      resumed: false,
      configuredModel: null,
      env: { OPENCODE_DB: store.path },
      now: () => 0,
    })
    meter.observe(step('root', 'only-in-stream', 5, 5))
    expect(meter.finish?.()).toBeNull()
    expect(meter.snapshot().models[0]).toMatchObject({ input: 5 })
  })

  test('an unreadable store or an oversized tree yields no summary', () => {
    expect(readOpencodeTreeUsage('/nonexistent/opencode.db', ['root'], 0)).toBeNull()
    expect(readOpencodeTreeUsage('/nonexistent/opencode.db', [], 0)).toBeNull()
    const store = nativeStore()
    store.session('root')
    store.db.transaction(() => {
      for (let i = 0; i < OPENCODE_TREE_MAX_SESSIONS; i++) store.session(`child-${i}`, 'root')
    })()
    expect(readOpencodeTreeUsage(store.path, ['root'], 0)).toBeNull()
  })
})

describe('RFC-371 v2 Claude Code meter', () => {
  const assistant = (id: string, model: string, usage: Record<string, number>, extra = {}) => ({
    type: 'assistant',
    message: { id, model, usage },
    ...extra,
  })

  test('split assistant events keep the largest value per message and stay partial', () => {
    const meter = claudeUsageMeter({ resumed: false, configuredModel: null })
    expect(meter.observe(assistant('m1', 'sonnet', { input_tokens: 10, output_tokens: 1 }))).toBe(
      true,
    )
    expect(meter.observe(assistant('m1', 'sonnet', { input_tokens: 10, output_tokens: 1 }))).toBe(
      false,
    )
    expect(meter.observe(assistant('m1', 'sonnet', { input_tokens: 10, output_tokens: 7 }))).toBe(
      true,
    )
    meter.observe(
      assistant(
        's1',
        'haiku',
        { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 },
        { parent_tool_use_id: 'tool-1' },
      ),
    )
    expect(meter.snapshot()).toEqual({
      state: 'partial',
      models: [
        { model: 'haiku', input: 3, cacheRead: 4, cacheWrite: 5, output: 0, reasoning: 0 },
        { model: 'sonnet', input: 10, cacheRead: 0, cacheWrite: 0, output: 7, reasoning: 0 },
      ],
    })
  })

  test('the result modelUsage replaces the stream view with complete per-model totals', () => {
    const meter = claudeUsageMeter({ resumed: false, configuredModel: null })
    meter.observe(assistant('m1', 'sonnet', { input_tokens: 10, output_tokens: 1 }))
    expect(
      meter.observe({
        type: 'result',
        subtype: 'success',
        modelUsage: {
          sonnet: {
            inputTokens: 12,
            outputTokens: 30,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
          },
          haiku: { inputTokens: 5, outputTokens: 6 },
        },
      }),
    ).toBe(true)
    // Late frames never reopen a complete snapshot.
    expect(meter.observe(assistant('m2', 'sonnet', { input_tokens: 999 }))).toBe(false)
    expect(meter.snapshot()).toEqual({
      state: 'complete',
      models: [
        { model: 'haiku', input: 5, cacheRead: 0, cacheWrite: 0, output: 6, reasoning: 0 },
        { model: 'sonnet', input: 12, cacheRead: 2, cacheWrite: 1, output: 30, reasoning: 0 },
      ],
    })
  })

  test('a resumed session or an all-zero failed result never replaces known usage', () => {
    const resumed = claudeUsageMeter({ resumed: true, configuredModel: null })
    resumed.observe(assistant('m1', 'sonnet', { input_tokens: 10 }))
    expect(
      resumed.observe({
        type: 'result',
        modelUsage: { sonnet: { inputTokens: 5000, outputTokens: 900 } },
      }),
    ).toBe(false)
    expect(resumed.snapshot()).toMatchObject({ state: 'partial', models: [{ input: 10 }] })

    const failed = claudeUsageMeter({ resumed: false, configuredModel: null })
    failed.observe(assistant('m1', 'sonnet', { input_tokens: 10 }))
    expect(
      failed.observe({
        type: 'result',
        subtype: 'error_during_execution',
        modelUsage: { sonnet: { inputTokens: 0, outputTokens: 0 } },
      }),
    ).toBe(false)
    expect(failed.snapshot()).toMatchObject({ state: 'partial', models: [{ input: 10 }] })
  })

  test('both registered drivers expose their own meter', () => {
    expect(getRuntimeDriver('opencode').usageMeter).toBeDefined()
    expect(getRuntimeDriver('claude-code').usageMeter).toBeDefined()
    const meter = getRuntimeDriver('claude-code').usageMeter!({
      resumed: false,
      configuredModel: null,
    })
    expect(meter.snapshot()).toEqual({ state: 'partial', models: [] })
  })
})
