// P-5-02: backup service + CLI.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createBackup } from '../src/services/backup'
import { createWorkflow } from '../src/services/workflow'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-backup-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function listTarMembers(tarPath: string): Promise<string[]> {
  const proc = Bun.spawn(['tar', '-tzf', tarPath], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

async function extractTar(tarPath: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  const proc = Bun.spawn(['tar', '-xzf', tarPath, '-C', dest], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`tar -xzf failed with ${code}: ${await new Response(proc.stderr).text()}`)
  }
}

describe('createBackup', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('produces tarball under backups/ with the expected layout', async () => {
    // Seed: 2 workflows + a config.json + a skill file.
    await createWorkflow(h.db, {
      name: 'wf-a',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })
    await createWorkflow(h.db, {
      name: 'wf-b',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })
    writeFileSync(join(h.appHome, 'config.json'), '{"opencodePath": "x"}', 'utf-8')
    mkdirSync(join(h.appHome, 'skills', 'demo'), { recursive: true })
    writeFileSync(
      join(h.appHome, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\n---\nbody',
      'utf-8',
    )

    const r = await createBackup({ db: h.db, appHome: h.appHome })
    expect(r.path.startsWith(join(h.appHome, 'backups', 'agent-workflow-'))).toBe(true)
    expect(r.path.endsWith('.tar.gz')).toBe(true)
    expect(existsSync(r.path)).toBe(true)
    expect(r.sizeBytes).toBeGreaterThan(0)
    expect(r.contents.workflows).toBe(2)
    expect(r.contents.skills).toBe(1)
    expect(r.contents.config).toBe(true)
    expect(r.contents.db).toBe(true)

    const members = await listTarMembers(r.path)
    expect(members.some((m) => m === './db.sqlite' || m === 'db.sqlite')).toBe(true)
    expect(members.some((m) => m.endsWith('config.json'))).toBe(true)
    expect(members.some((m) => m.includes('skills/demo/SKILL.md'))).toBe(true)
    expect(members.filter((m) => m.endsWith('.yaml')).length).toBe(2)
  })

  test('excludes worktrees, runs, logs, token', async () => {
    mkdirSync(join(h.appHome, 'worktrees', 'r1'), { recursive: true })
    writeFileSync(join(h.appHome, 'worktrees', 'r1', 'README'), 'x', 'utf-8')
    mkdirSync(join(h.appHome, 'runs', 't1'), { recursive: true })
    writeFileSync(join(h.appHome, 'runs', 't1', '.opencode-cfg'), 'x', 'utf-8')
    mkdirSync(join(h.appHome, 'logs'), { recursive: true })
    writeFileSync(join(h.appHome, 'logs', 'daemon.log'), 'x', 'utf-8')
    writeFileSync(join(h.appHome, 'token'), 'secret', 'utf-8')

    const r = await createBackup({ db: h.db, appHome: h.appHome })
    const members = await listTarMembers(r.path)
    expect(members.some((m) => m.includes('worktrees'))).toBe(false)
    expect(members.some((m) => m.includes('runs/'))).toBe(false)
    expect(members.some((m) => m.includes('logs/'))).toBe(false)
    expect(members.some((m) => m.endsWith('/token') || m === 'token' || m === './token')).toBe(
      false,
    )
  })

  // RFC-204's whole at-rest encryption argument rests on one sentence in a
  // comment (services/repoCredentials.ts:8): the backup carries the sealed DB
  // but NOT `secret.key`, so a leaked tarball cannot be unsealed. Nothing
  // asserted it. The tarball is safe today only because createBackup happens to
  // be whitelist-shaped — an implementation detail, not a locked contract. One
  // "let's also include the rest of appHome" change would put the key and the
  // ciphertext in the same archive, and every existing test would stay green.
  // See design/test-guard-audit-2026-07-21 gap B6-data-5 / 逃逸机制⑧.
  test('never ships the at-rest encryption key, and carries no plaintext credential', async () => {
    const secret = 'SECRET-KEY-MUST-NOT-BE-BACKED-UP'
    const plaintextToken = 'ghp-PLAINTEXT-CREDENTIAL-MUST-NOT-APPEAR'
    writeFileSync(join(h.appHome, 'secret.key'), secret, 'utf-8')
    // A sibling that a future "back up everything under appHome" change would
    // sweep in alongside the key.
    mkdirSync(join(h.appHome, 'credentials'), { recursive: true })
    writeFileSync(join(h.appHome, 'credentials', 'repo.json'), plaintextToken, 'utf-8')

    const r = await createBackup({ db: h.db, appHome: h.appHome })

    const members = await listTarMembers(r.path)
    expect(members.some((m) => m.endsWith('secret.key'))).toBe(false)
    expect(members.some((m) => m.includes('credentials'))).toBe(false)

    // Content half: prove the member-name assertions above are not vacuous by
    // scanning what the archive actually carries — a key renamed to something
    // innocuous, or inlined into config.json, would still fail here. Scan the
    // DECOMPRESSED bytes: a gzip stream essentially never contains the literal
    // plaintext, so grepping the .tar.gz itself would be a guard with no teeth.
    const unpacked = join(h.appHome, 'unpacked-secret-scan')
    await extractTar(r.path, unpacked)
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return scan(path)
        const bytes = readFileSync(path)
        const hits: string[] = []
        if (bytes.includes(Buffer.from(secret, 'utf-8'))) hits.push(`${path}: secret.key material`)
        if (bytes.includes(Buffer.from(plaintextToken, 'utf-8'))) {
          hits.push(`${path}: plaintext credential`)
        }
        return hits
      })
    expect(scan(unpacked)).toEqual([])
  })

  test('db dump is a valid sqlite file with the schema applied', async () => {
    await createWorkflow(h.db, {
      name: 'rt',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })
    const r = await createBackup({ db: h.db, appHome: h.appHome })
    const extracted = join(h.appHome, 'extracted')
    await extractTar(r.path, extracted)
    const dbPath = join(extracted, 'db.sqlite')
    expect(existsSync(dbPath)).toBe(true)
    const sqlite = new Database(dbPath)
    const row = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'")
      .get()
    expect(row).not.toBeNull()
    const wfRow = sqlite.query('SELECT count(*) AS n FROM workflows').get() as { n: number }
    expect(wfRow.n).toBe(1)
    sqlite.close()
  })

  test('first-run state without config.json or skills still produces a tarball', async () => {
    const r = await createBackup({ db: h.db, appHome: h.appHome })
    expect(r.contents.config).toBe(false)
    expect(r.contents.skills).toBe(0)
    expect(r.contents.workflows).toBe(0)
    expect(r.contents.db).toBe(true)
    const members = await listTarMembers(r.path)
    expect(members.some((m) => m === './db.sqlite' || m === 'db.sqlite')).toBe(true)
  })

  test('staging directory is removed after backup completes', async () => {
    await createBackup({ db: h.db, appHome: h.appHome })
    const entries = readdirSync(join(h.appHome, 'backups'))
    const stale = entries.filter((e) => e.startsWith('.staging-'))
    expect(stale.length).toBe(0)
  })

  test('workflow YAML uses each list-captured row without an N+1 by-id reread', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'backup.ts'),
      'utf8',
    )
    expect(source).toContain('stringifyWorkflowYaml(wf)')
    expect(source).not.toContain('exportWorkflowYaml(opts.db, wf.id)')
  })
})

describe('POST /api/backup', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('writes a backup and returns the path / size', async () => {
    // Need appHome wired via env: the route delegates to createBackup which
    // resolves Paths.root from $AGENT_WORKFLOW_HOME.
    const prev = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = h.appHome
    try {
      const app = createApp({
        token: 'tok',
        configPath: join(h.appHome, 'config.json'),
        opencodeVersion: '1.14.25',
        dbVersion: 1,
        db: h.db,
      })
      const res = await app.fetch(
        new Request('http://localhost/api/backup', {
          method: 'POST',
          headers: { Authorization: 'Bearer tok' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        path: string
        sizeBytes: number
        contents: { db: boolean }
      }
      expect(body.path).toContain(h.appHome)
      expect(body.sizeBytes).toBeGreaterThan(0)
      expect(body.contents.db).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prev
    }
  })
})
