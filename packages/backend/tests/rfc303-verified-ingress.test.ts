// RFC-303 verified-ingress integration: delivery acceptance, exact-body fact
// dedupe, stream revision, and control intent must commit as one SQLite fact.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CodeHostEvent } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { SqliteVerifiedWebhookDeliveryStore } from '@/modules/integration/infrastructure/sqliteVerifiedWebhookDeliveryStore'

const MIGRATION = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0157_rfc303_mr_terminal_control.sql'),
  'utf8',
)

const opened: Database[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function fixture(): { raw: Database; db: DbClient } {
  const raw = new Database(':memory:')
  opened.push(raw)
  raw.exec(`
    CREATE TABLE webhook_triggers (id text PRIMARY KEY NOT NULL);
    CREATE TABLE tasks (id text PRIMARY KEY NOT NULL);
    CREATE TABLE webhook_deliveries (
      id text PRIMARY KEY NOT NULL,
      endpoint_id text NOT NULL,
      event_uuid text,
      attempt_count integer NOT NULL DEFAULT 1,
      gitlab_event_header text,
      object_kind text,
      event_type text,
      repo_path text,
      stream_hint text,
      status text NOT NULL,
      status_reason text,
      replayed_from_delivery_id text,
      received_at integer NOT NULL DEFAULT (unixepoch() * 1000),
      body_json text
    );
    CREATE UNIQUE INDEX idx_webhook_deliveries_dedupe
      ON webhook_deliveries(endpoint_id,event_uuid)
      WHERE event_uuid IS NOT NULL AND status NOT IN ('rejected','failed');
    CREATE INDEX idx_webhook_deliveries_endpoint_time ON webhook_deliveries(endpoint_id,received_at);
    CREATE INDEX idx_webhook_deliveries_received_at ON webhook_deliveries(received_at);
    CREATE INDEX idx_webhook_deliveries_status_time ON webhook_deliveries(status,received_at);
    CREATE INDEX idx_webhook_deliveries_event_time ON webhook_deliveries(event_type,received_at);
    CREATE INDEX idx_webhook_deliveries_repo_time ON webhook_deliveries(repo_path,received_at);
    CREATE INDEX idx_webhook_deliveries_body_retention
      ON webhook_deliveries(received_at) WHERE body_json IS NOT NULL;
  `)
  for (const statement of MIGRATION.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') raw.exec(statement)
  }
  return { raw, db: drizzle(raw) as unknown as DbClient }
}

function event(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: null,
    eventType: 'mr_closed',
    repoPath: 'group/repo',
    repoHttpUrl: 'https://example.test/group/repo.git',
    repoSshUrl: 'git@example.test:group/repo.git',
    projectId: '77',
    mrIid: '9',
    author: {},
    raw: {},
    ...overrides,
  }
}

function accept(
  store: SqliteVerifiedWebhookDeliveryStore,
  evt: CodeHostEvent,
  body: string,
  replay?: { rootDeliveryId: string; terminalRootRevision: number | null },
) {
  return store.accept({
    endpointId: 'endpoint-1',
    event: evt,
    rawBodyBytes: new TextEncoder().encode(body),
    rawBodyText: body,
    eventHeader: 'Merge Request Hook',
    objectKind: 'merge_request',
    ...(replay === undefined ? {} : { replay }),
  })
}

describe('RFC-303 verified ingress', () => {
  test('close atomically creates delivery + revision + effect; exact retry only bumps attempt', () => {
    const { raw, db } = fixture()
    const store = new SqliteVerifiedWebhookDeliveryStore(db)
    const first = accept(store, event(), '{"object_kind":"merge_request","state":"closed"}')
    expect(first.kind).toBe('inserted')
    if (first.kind !== 'inserted') throw new Error('expected insert')
    expect(first.controlAccepted).toBe(true)
    expect(first.streamRevision).toBe(1)

    expect(
      raw.query('SELECT state,revision,last_terminal_revision FROM webhook_mr_stream_states').get(),
    ).toEqual({ state: 'closed', revision: 1, last_terminal_revision: 1 })
    expect(
      raw
        .query('SELECT delivery_id,kind,status,revision FROM webhook_mr_control_effects WHERE id=?')
        .get(first.effectId),
    ).toEqual({
      delivery_id: first.deliveryId,
      kind: 'fence-closed',
      status: 'pending',
      revision: 1,
    })

    const duplicate = accept(store, event(), '{"object_kind":"merge_request","state":"closed"}')
    expect(duplicate).toEqual({
      kind: 'duplicate',
      deliveryId: first.deliveryId,
      attemptCount: 2,
      effectId: first.effectId,
    })
    expect(raw.query('SELECT count(*) AS n FROM webhook_deliveries').get()).toEqual({ n: 1 })
    expect(raw.query('SELECT revision FROM webhook_mr_stream_states').get()).toEqual({
      revision: 1,
    })
  })

  test('body-byte mutation is a distinct fact; reopen clears closed and merge becomes absorbing', () => {
    const { raw, db } = fixture()
    const store = new SqliteVerifiedWebhookDeliveryStore(db)
    accept(store, event(), '{"state":"closed"}')
    const reopened = accept(store, event({ eventType: 'mr_opened' }), '{"state":"opened"}')
    expect(reopened).toEqual(expect.objectContaining({ kind: 'inserted', streamRevision: 2 }))
    expect(raw.query('SELECT state,revision FROM webhook_mr_stream_states').get()).toEqual({
      state: 'open',
      revision: 2,
    })
    expect(
      raw
        .query('SELECT kind FROM webhook_mr_control_effects ORDER BY revision')
        .all()
        .map((row) => (row as { kind: string }).kind),
    ).toEqual(['fence-closed', 'clear-closed'])

    accept(store, event({ eventType: 'mr_merged' }), '{"state":"merged"}')
    accept(store, event({ eventType: 'mr_opened' }), '{"state":"opened","late":true}')
    expect(raw.query('SELECT state,revision FROM webhook_mr_stream_states').get()).toEqual({
      state: 'merged',
      revision: 4,
    })
  })

  test('terminal replay reuses the root revision/effect while nonterminal replay advances', () => {
    const { raw, db } = fixture()
    const store = new SqliteVerifiedWebhookDeliveryStore(db)
    const root = accept(store, event(), '{"state":"closed"}')
    if (root.kind !== 'inserted') throw new Error('expected insert')

    const replay = accept(store, event(), '{"state":"closed"}', {
      rootDeliveryId: root.deliveryId,
      terminalRootRevision: 1,
    })
    expect(replay).toEqual(
      expect.objectContaining({
        kind: 'inserted',
        effectId: root.effectId,
        streamRevision: 1,
      }),
    )
    expect(raw.query('SELECT revision FROM webhook_mr_stream_states').get()).toEqual({
      revision: 1,
    })
    expect(raw.query('SELECT count(*) AS n FROM webhook_mr_control_effects').get()).toEqual({
      n: 1,
    })

    const nonterminalReplay = accept(
      store,
      event({ eventType: 'mr_updated' }),
      '{"state":"updated"}',
      { rootDeliveryId: root.deliveryId, terminalRootRevision: null },
    )
    expect(nonterminalReplay).toEqual(
      expect.objectContaining({ kind: 'inserted', streamRevision: 2, effectId: null }),
    )
  })

  test('non-MR no-UUID deliveries retain legacy non-deduped behavior', () => {
    const { raw, db } = fixture()
    const store = new SqliteVerifiedWebhookDeliveryStore(db)
    const push = event({
      eventType: 'push',
      projectId: '77',
      mrIid: undefined,
      branch: 'main',
    })
    expect(accept(store, push, '{"push":true}').kind).toBe('inserted')
    expect(accept(store, push, '{"push":true}').kind).toBe('inserted')
    expect(raw.query('SELECT count(*) AS n FROM webhook_deliveries').get()).toEqual({ n: 2 })
    expect(raw.query('SELECT count(*) AS n FROM webhook_mr_stream_states').get()).toEqual({ n: 0 })
  })
})
