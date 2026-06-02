// RFC-077 — locks in the BFS / per-session SELECT semantics extracted from
// sessionCapture.ts (RFC-027), distillSessionCapture.ts (RFC-043) and
// subagentLiveCapture.ts (RFC-048) into the single `walkOpencodeSessions`
// core. Any divergence asserted here would silently break one of the three
// capture owners (worker post-run, distiller post-run, live poll), since all
// three now delegate their traversal to this function. See
// design/RFC-077-capture-layer-unification/design.md §7.2.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  walkOpencodeSessions,
  type OpencodeSessionRow,
  type WalkedSession,
} from '../src/services/opencodeSessionWalk'

interface BuildOpts {
  sessions: Array<{ id: string; parent_id: string | null; agent: string | null }>
  messages: Array<{ id: string; session_id: string; time_created: number; data: string }>
  parts: Array<{
    id: string
    message_id: string
    session_id: string
    time_created: number
    data: string
  }>
}

/** Build a throwaway opencode-shaped SQLite and return an open readonly handle. */
function openOpencodeDb(opts: BuildOpts): Database {
  const dir = mkdtempSync(join(tmpdir(), 'rfc077-walk-'))
  const dbPath = join(dir, 'opencode.db')
  const w = new Database(dbPath, { create: true })
  w.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT)')
  w.run(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  w.run(
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  for (const s of opts.sessions) {
    w.run('INSERT INTO session (id, parent_id, agent) VALUES (?, ?, ?)', [
      s.id,
      s.parent_id,
      s.agent,
    ])
  }
  for (const m of opts.messages) {
    w.run('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)', [
      m.id,
      m.session_id,
      m.time_created,
      m.data,
    ])
  }
  for (const p of opts.parts) {
    w.run(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      [p.id, p.message_id, p.session_id, p.time_created, p.data],
    )
  }
  w.close()
  return new Database(dbPath, { readonly: true })
}

function walkedIds(db: Database, root: string, includeRoot: boolean): string[] {
  return [...walkOpencodeSessions(db, root, { includeRoot })].map((w) => w.session.id)
}

const NESTED: BuildOpts = {
  // root → A → B ; root → D  (B is a grandchild via A)
  sessions: [
    { id: 'root', parent_id: null, agent: 'r' },
    { id: 'A', parent_id: 'root', agent: 'a' },
    { id: 'B', parent_id: 'A', agent: 'b' },
    { id: 'D', parent_id: 'root', agent: 'd' },
  ],
  messages: [
    { id: 'mRoot', session_id: 'root', time_created: 1, data: '{}' },
    { id: 'mA', session_id: 'A', time_created: 10, data: '{}' },
    { id: 'mB', session_id: 'B', time_created: 20, data: '{}' },
    { id: 'mD', session_id: 'D', time_created: 30, data: '{}' },
  ],
  parts: [
    {
      id: 'pRoot',
      message_id: 'mRoot',
      session_id: 'root',
      time_created: 1,
      data: '{"type":"text","text":"root"}',
    },
    {
      id: 'pA',
      message_id: 'mA',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"a"}',
    },
    {
      id: 'pB',
      message_id: 'mB',
      session_id: 'B',
      time_created: 20,
      data: '{"type":"text","text":"b"}',
    },
    {
      id: 'pD',
      message_id: 'mD',
      session_id: 'D',
      time_created: 30,
      data: '{"type":"text","text":"d"}',
    },
  ],
}

describe('walkOpencodeSessions', () => {
  test('includeRoot:false yields only descendants, in BFS order (worker / live paths)', () => {
    const db = openOpencodeDb(NESTED)
    try {
      // BFS from root: level-1 children (A, D) before grandchild (B).
      expect(walkedIds(db, 'root', false)).toEqual(['A', 'D', 'B'])
    } finally {
      db.close()
    }
  })

  test('includeRoot:true seeds the root first, then BFS descendants (distiller path)', () => {
    const db = openOpencodeDb(NESTED)
    try {
      expect(walkedIds(db, 'root', true)).toEqual(['root', 'A', 'D', 'B'])
    } finally {
      db.close()
    }
  })

  test('each walked session carries its message+part rows ordered by time_created,id', () => {
    const db = openOpencodeDb({
      sessions: [
        { id: 'root', parent_id: null, agent: 'r' },
        { id: 'A', parent_id: 'root', agent: 'a' },
      ],
      messages: [{ id: 'mA', session_id: 'A', time_created: 10, data: '{}' }],
      // Deliberately inserted out of order; walk must return them sorted by
      // (time_created, id) to match the original per-owner SELECT ORDER BY.
      parts: [
        {
          id: 'p2',
          message_id: 'mA',
          session_id: 'A',
          time_created: 20,
          data: '{"type":"text","text":"second"}',
        },
        {
          id: 'p1',
          message_id: 'mA',
          session_id: 'A',
          time_created: 10,
          data: '{"type":"text","text":"first"}',
        },
        {
          id: 'p1b',
          message_id: 'mA',
          session_id: 'A',
          time_created: 10,
          data: '{"type":"text","text":"tie"}',
        },
      ],
    })
    try {
      const walked = [...walkOpencodeSessions(db, 'root', { includeRoot: false })]
      expect(walked).toHaveLength(1)
      const a = walked[0] as WalkedSession
      expect(a.session.id).toBe('A')
      expect(a.messages.map((m) => m.id)).toEqual(['mA'])
      // (10,p1) < (10,p1b) [id tiebreak] < (20,p2)
      expect(a.parts.map((p) => p.id)).toEqual(['p1', 'p1b', 'p2'])
    } finally {
      db.close()
    }
  })

  test('cycle in parent_id (root → A → root) is bounded by the visited set', () => {
    const db = openOpencodeDb({
      sessions: [
        { id: 'root', parent_id: 'A', agent: 'r' },
        { id: 'A', parent_id: 'root', agent: 'a' },
      ],
      messages: [],
      parts: [],
    })
    try {
      // Must terminate; root excluded (includeRoot:false), A visited once.
      expect(walkedIds(db, 'root', false)).toEqual(['A'])
    } finally {
      db.close()
    }
  })

  test('includeRoot:true with the root session row absent does not seed a phantom root', () => {
    // Mirrors RFC-043's `rootRow !== null` guard: the root id has children
    // but no `session` row of its own. Seed is skipped; descendants still walk.
    const db = openOpencodeDb({
      sessions: [{ id: 'A', parent_id: 'ghostRoot', agent: 'a' }],
      messages: [],
      parts: [],
    })
    try {
      expect(walkedIds(db, 'ghostRoot', true)).toEqual(['A'])
    } finally {
      db.close()
    }
  })

  test('sessions with no messages/parts are still yielded (empty arrays)', () => {
    const db = openOpencodeDb({
      sessions: [
        { id: 'root', parent_id: null, agent: 'r' },
        { id: 'A', parent_id: 'root', agent: 'a' },
      ],
      messages: [],
      parts: [],
    })
    try {
      const walked = [...walkOpencodeSessions(db, 'root', { includeRoot: false })]
      expect(walked.map((w) => w.session.id)).toEqual(['A'])
      expect(walked[0]!.messages).toEqual([])
      expect(walked[0]!.parts).toEqual([])
    } finally {
      db.close()
    }
  })

  test('does not write to the opencode DB (readonly traversal)', () => {
    const db = openOpencodeDb(NESTED)
    try {
      // A readonly handle would throw on write; consuming the generator
      // must not attempt any write.
      const rows: OpencodeSessionRow[] = [
        ...walkOpencodeSessions(db, 'root', { includeRoot: true }),
      ].map((w) => w.session)
      expect(rows.length).toBe(4)
    } finally {
      db.close()
    }
  })
})
