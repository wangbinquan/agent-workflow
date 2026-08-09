// RFC-247 D9 / AC-12 / AC-38 — locks what a token may read.
//
// "Reads are always on" makes tokens usable and makes the read path the only
// thing standing between a token and every secret its owner can see. Two
// separate properties are locked here:
//
//   · token-channel masking of the managed-resource secret fields
//   · an ALL-CHANNEL fix for `tasks.repo_url`, which was leaking credentials to
//     everyone — session included — long before tokens existed
//
// The second is deliberately not conditioned on the actor: it closes an
// existing leak rather than adding a token-only gate, and writing the test that
// way is what keeps a future refactor from "restoring" the plaintext for
// sessions on the grounds that only tokens needed it.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRIVILEGED_LENS_TRANSPARENT, redactGitUrl } from '@agent-workflow/shared'
import type { ActorSource } from '@/auth/actor'
import {
  REDACTED,
  redactErrorText,
  redactEventPayload,
  redactMcpRecord,
  redactRepoUrl,
  redactStdout,
  serializePluginFor,
  serializeTaskFor,
  serializeWorkflowFor,
  serializeWorkflowReceiptFor,
  shouldRedactFor,
  type WorkflowReadLens,
} from '@/services/tokenRedaction'

/**
 * RFC-270 改判：三个定义 serializer 的第二参从 `ActorSource` 变成了双轴的
 * `WorkflowReadLens`（通道轴 + 权限轴）。本文件锁的是**通道轴**，所以这里一律
 * 用透明的权限镜头 —— 断言语义与改判前逐字相同，只是显式说明「这一轴不参与」。
 * 权限轴由 `rfc270-privileged-node-read-lens.test.ts` 单独覆盖。
 */
function channelLens(source: ActorSource): WorkflowReadLens {
  return { source, privileged: PRIVILEGED_LENS_TRANSPARENT }
}

describe('RFC-247 — redaction applies to the token channel only', () => {
  test('pat is redacted; session and daemon are untouched', () => {
    expect(shouldRedactFor('pat')).toBe(true)
    // A human who can already open the MCP editor gains nothing from having the
    // same bytes hidden; changing that would be a UX regression dressed up as
    // security.
    expect(shouldRedactFor('session')).toBe(false)
    expect(shouldRedactFor('daemon')).toBe(false)
  })
})

describe('RFC-247 AC-12 — MCP secret fields are masked, keys survive', () => {
  const record = {
    id: 'm1',
    name: 'ctx7',
    config: {
      type: 'local',
      command: ['npx', 'ctx7'],
      env: { API_KEY: 'sk-live-abc', OTHER: 'plain' },
      timeoutMs: 5000,
    },
  }

  test('env values are masked but the key names remain', () => {
    const out = redactMcpRecord(record) as typeof record
    // Key names must survive: an operator needs to see WHICH variables a server
    // wants configured, and the generated docs list them.
    expect(Object.keys(out.config.env)).toEqual(['API_KEY', 'OTHER'])
    expect(out.config.env.API_KEY).toBe(REDACTED)
    expect(out.config.env.OTHER).toBe(REDACTED)
  })

  test('non-secret config fields are left alone', () => {
    const out = redactMcpRecord(record) as typeof record
    expect(out.config.command).toEqual(['npx', 'ctx7'])
    expect(out.config.timeoutMs).toBe(5000)
    expect(out.name).toBe('ctx7')
  })

  test('remote headers are masked — Authorization lives there', () => {
    const remote = {
      id: 'm2',
      config: { type: 'remote', url: 'https://x/mcp', headers: { Authorization: 'Bearer s3cret' } },
    }
    const out = redactMcpRecord(remote) as typeof remote
    expect(Object.keys(out.config.headers)).toEqual(['Authorization'])
    expect(out.config.headers.Authorization).toBe(REDACTED)
  })

  test('oauth.clientSecret is masked, clientId is not', () => {
    const oauthed = {
      id: 'm3',
      config: {
        type: 'remote',
        url: 'https://x/mcp',
        oauth: { clientId: 'public-id', clientSecret: 'sh-secret', scope: 'read' },
      },
    }
    const out = redactMcpRecord(oauthed) as typeof oauthed
    expect(out.config.oauth.clientSecret).toBe(REDACTED)
    expect(out.config.oauth.clientId).toBe('public-id')
    expect(out.config.oauth.scope).toBe('read')
  })

  test('the input object is not mutated — callers may still hold the real one', () => {
    const before = JSON.stringify(record)
    redactMcpRecord(record)
    expect(JSON.stringify(record)).toBe(before)
  })

  test('a record without config, or a non-object, passes through unharmed', () => {
    expect(redactMcpRecord({ id: 'x' })).toEqual({ id: 'x' })
    expect(redactMcpRecord(null)).toBe(null)
    expect(redactMcpRecord('nope')).toBe('nope')
  })
})

describe('RFC-247 AC-38 — repo URL credentials never reach the wire', () => {
  test('userinfo credentials are stripped', () => {
    // StartTaskSchema only rejects credentials in the QUERY STRING, so this
    // exact shape is accepted at launch, stored, and previously handed straight
    // back by every task read.
    const dirty = 'https://someone:ghp_realtokenvalue@github.com/acme/repo.git'
    const out = redactRepoUrl(dirty)
    expect(out).not.toContain('ghp_realtokenvalue')
    expect(out).toBe(redactGitUrl(dirty))
  })

  test('a clean URL is preserved so the UI still shows something useful', () => {
    const clean = 'https://github.com/acme/repo.git'
    expect(redactRepoUrl(clean)).toBe(redactGitUrl(clean))
    expect(redactRepoUrl(clean)).toContain('github.com/acme/repo')
  })

  test('null and empty stay null-ish rather than becoming a string', () => {
    expect(redactRepoUrl(null)).toBe(null)
    expect(redactRepoUrl(undefined)).toBe(null)
    expect(redactRepoUrl('')).toBe(null)
  })
})

describe('RFC-247 AC-39 — free-form output is best-effort redacted', () => {
  test('stdout goes through the same helper the plugin installer uses', () => {
    const noisy = 'cloning https://u:ghp_abcdefghijklmno@github.com/x/y.git ...'
    expect(redactStdout(noisy)).not.toContain('ghp_abcdefghijklmno')
  })

  test('error text is redacted — opencode puts it in the model context', () => {
    // mcp/catalog.ts concatenates a failed tool call's text content and throws
    // it, so an unredacted message does not merely get logged: it lands in the
    // model's conversation and travels with it.
    const err = 'failed to reach https://u:ghp_abcdefghijklmno@host/repo.git'
    expect(redactErrorText(err)).not.toContain('ghp_abcdefghijklmno')
  })
})

// -----------------------------------------------------------------------------
// AC-39 — WIRING, not just the rule.
//
// This RFC shipped two redactors that were defined, unit-tested, and called by
// nobody (`redactMcpRecord`, then `redactStdout`). A unit test proves the
// FUNCTION works; it says nothing about whether any outlet uses it. These are
// the source-level assertions that the outlets exist — cheap, and they are what
// would have caught both.
// -----------------------------------------------------------------------------

describe('RFC-247 — every redactor has an outlet', () => {
  const SRC = resolve(import.meta.dir, '..', 'src')

  function read(rel: string): string {
    return readFileSync(resolve(SRC, rel), 'utf8')
  }

  test('redactStdout is applied on the node-run stdout route (AC-39)', () => {
    const tasks = read('routes/tasks.ts')
    expect(tasks).toContain('redactStdout(text)')
    expect(tasks).toContain('shouldRedactFor(actor.source)')
  })

  test('redactMcpRecord is applied through serializeMcpFor on every mcps read (AC-12)', () => {
    const mcps = read('routes/mcps.ts')
    // Five serialization points; each must go through the single outlet.
    const uses = mcps.split('serializeMcpFor(').length - 1
    expect(uses).toBeGreaterThanOrEqual(5)
    expect(read('services/tokenRedaction.ts')).toContain('return shouldRedactFor(source)')
  })

  test('redactRepoUrl reaches rowToTask (AC-38)', () => {
    // AC-38 is explicitly ALL channels, not token-only: a repo URL with an
    // embedded credential has no reader who benefits from seeing it.
    const task = read('services/task.ts')
    expect(task.split('redactGitUrl(row.repoUrl)').length - 1).toBeGreaterThanOrEqual(4)
  })

  test('no redactor in tokenRedaction.ts is left with zero callers', () => {
    // The generalized form of the two misses. Every exported redactor must be
    // referenced somewhere OUTSIDE its own module.
    const moduleSource = read('services/tokenRedaction.ts')
    // `<T>` sits between the name and `(` on the generic ones, so the pattern
    // has to allow it — without that this test silently checks a subset, which
    // is the same class of miss it exists to catch.
    const exported = [
      ...moduleSource.matchAll(/export function (redact\w+|serialize\w+)(?:<[^>]*>)?\(/g),
    ].map((m) => m[1])
    expect(exported.length).toBeGreaterThanOrEqual(5)

    const callers = walkSrc(SRC).filter((f) => !f.endsWith(join('services', 'tokenRedaction.ts')))
    const haystack = callers.map((f) => readFileSync(f, 'utf8')).join('\n')
    const unwired = exported.filter((name) => !haystack.includes(`${name}(`))
    expect(unwired).toEqual([])
  })
})

function walkSrc(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walkSrc(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

// -----------------------------------------------------------------------------
// Impl-gate: the same bytes have MORE THAN ONE door.
//
// Node output reaches a caller three ways — the stdout route, the events route,
// and the WS replay. Redacting one of them is not a partial fix, it is no fix:
// a caller who wants the unmasked bytes simply uses another door, without even
// having to know the first one was guarded.
// -----------------------------------------------------------------------------

describe('RFC-247 impl-gate — redaction covers every door onto node output', () => {
  const SRC = resolve(import.meta.dir, '..', 'src')
  const SECRET = 'sk-live-must-not-escape'

  test('a string payload is masked for a token and left alone for a session', () => {
    const raw = `token=${SECRET} and https://u:${SECRET}@example.com/x`
    expect(String(redactEventPayload(raw, 'pat'))).not.toContain(SECRET)
    expect(redactEventPayload(raw, 'session')).toBe(raw)
    expect(redactEventPayload(raw, 'daemon')).toBe(raw)
  })

  test('KNOWN GAP: a prefixed env-var name is NOT masked', () => {
    // `SENSITIVE_KV_RE` is `\b(token|api_key|…)\b`, and `_` is a word
    // character, so `\bapi_key\b` does not match inside `OPENAI_API_KEY`.
    // Asserted deliberately rather than left as a surprise: `util/redact.ts`
    // says in its own header that it is "not a security boundary", and node
    // output echoing `FOO_API_KEY=…` is exactly the shape it misses.
    //
    // NOT widened here on purpose — that regex is shared with RFC-030's MCP
    // probe persistence and the daemon logs, so loosening the word boundary is
    // a decision for those owners, not a side effect of this RFC. Recorded in
    // docs/audit-backlog.md.
    const raw = `OPENAI_API_KEY=${SECRET}`
    expect(String(redactEventPayload(raw, 'pat'))).toContain(SECRET)
  })

  test('a STRUCTURED payload is masked at its leaves, not just at the top level', () => {
    // The reason this re-serializes rather than naming fields: an event payload
    // is agent output with no fixed shape, so a field allowlist would mask the
    // leaves someone thought of and miss the rest.
    const payload = { tool: 'bash', nested: { deep: [`token=${SECRET}`] } }
    const masked = JSON.stringify(redactEventPayload(payload, 'pat'))
    expect(masked).not.toContain(SECRET)
    // Structure survives — this is redaction, not deletion.
    expect(masked).toContain('bash')
    expect(masked).toContain('nested')
  })

  test('an unserializable payload is returned as-is rather than thrown away', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(redactEventPayload(circular, 'pat')).toBe(circular)
  })

  test('a plugin spec with an embedded git credential is masked for tokens', () => {
    // PluginSpecSchema documents this exact case ("git URLs with embedded
    // tokens"), so any PAT could read the credential of every visible plugin.
    const row = { id: 'p1', name: 'x', spec: 'git+https://user:ghp_secret@github.com/o/r.git' }
    const masked = serializePluginFor(row, 'pat')
    expect(JSON.stringify(masked)).not.toContain('ghp_secret')
    expect(masked.name).toBe('x')
    expect(serializePluginFor(row, 'session')).toBe(row)
  })

  test('all three node-output doors call a redactor', () => {
    const tasks = readFileSync(resolve(SRC, 'routes/tasks.ts'), 'utf8')
    const wsRegistry = readFileSync(resolve(SRC, 'ws/registry.ts'), 'utf8')
    // stdout route + events route + WS replay.
    expect(tasks).toContain('redactStdout(text)')
    expect(tasks).toContain('redactEventPayload(e.payload')
    expect(wsRegistry).toContain('redactEventPayload(payload, ws.data.actor.source)')
  })

  test('every plugin serialization point goes through the outlet', () => {
    const plugins = readFileSync(resolve(SRC, 'routes/plugins.ts'), 'utf8')
    expect(plugins.split('serializePluginFor(').length - 1).toBeGreaterThanOrEqual(5)
  })
})

// RFC-253 T28 — workflow definitions became credential carriers when script
// nodes landed: their env maps hold API keys. Token channel masks values via
// the SHARED walker; sessions keep plaintext (the editor round-trip depends on
// it, and a PAT cannot write the mask back — script saves need scripts:author,
// which never enters the token face).
describe('RFC-253 T28 — script env masked on the workflow token channel', () => {
  const record = {
    id: 'w1',
    name: 'etl',
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'context' },
        {
          id: 's1',
          kind: 'script',
          language: 'python',
          script: 'print(1)',
          env: { API_TOKEN: 'sk-live-scriptenv', LOG_LEVEL: 'debug' },
        },
      ],
      edges: [],
    },
    version: 3,
  }

  test('pat: values collapse to REDACTED, keys and body survive', () => {
    const out = serializeWorkflowFor(record, channelLens('pat')) as typeof record
    const script = out.definition.nodes[1] as { env: Record<string, string>; script: string }
    expect(script.env).toEqual({ API_TOKEN: REDACTED, LOG_LEVEL: REDACTED })
    expect(script.script).toBe('print(1)')
    expect(out.definition.nodes[0]).toBe(record.definition.nodes[0])
    expect(out.version).toBe(3)
    // the input record is never mutated
    expect((record.definition.nodes[1] as { env: Record<string, string> }).env.API_TOKEN).toBe(
      'sk-live-scriptenv',
    )
  })

  test('session and daemon get the SAME reference — byte-for-byte passthrough', () => {
    expect(serializeWorkflowFor(record, channelLens('session'))).toBe(record)
    expect(serializeWorkflowFor(record, channelLens('daemon'))).toBe(record)
  })

  test('a workflow without script env comes back as the same reference', () => {
    const plain = { id: 'w2', definition: { nodes: [{ id: 'a', kind: 'agent-single' }] } }
    expect(serializeWorkflowFor(plain, channelLens('pat'))).toBe(plain)
  })

  // A SAVE answers with a receipt, not a record: the definition sits at
  // `snapshot.definition`. The record projection reads `record.definition`,
  // finds undefined, hits the same-reference short circuit and returns the
  // receipt untouched — a call site that reads as wired and does nothing.
  // That was not a leak (a receipt snapshot is the caller's own submitted
  // bytes, workflow.ts:345), which is why only a TYPE can catch it: there is
  // no wrong output to assert on. These lock the shape split.
  describe('save receipts carry the definition one level down', () => {
    const receipt = {
      clientMutationId: 'm1',
      requestedBaseVersion: 2,
      revision: { workflowId: 'w1', version: 3 },
      snapshot: { name: 'etl', description: '', definition: record.definition },
      outcome: 'committed' as const,
    }

    test('pat: the receipt snapshot is masked', () => {
      const out = serializeWorkflowReceiptFor(receipt, channelLens('pat'))
      const script = (out.snapshot.definition as typeof record.definition).nodes[1] as {
        env: Record<string, string>
      }
      expect(script.env).toEqual({ API_TOKEN: REDACTED, LOG_LEVEL: REDACTED })
      // sibling receipt fields survive; the input is not mutated
      expect(out.revision).toEqual({ workflowId: 'w1', version: 3 })
      expect(out.outcome).toBe('committed')
      expect(out.snapshot.name).toBe('etl')
      expect(
        (receipt.snapshot.definition.nodes[1] as { env: Record<string, string> }).env.API_TOKEN,
      ).toBe('sk-live-scriptenv')
    })

    test('session gets the same reference; a script-free receipt is untouched', () => {
      expect(serializeWorkflowReceiptFor(receipt, channelLens('session'))).toBe(receipt)
      const plain = { snapshot: { definition: { nodes: [{ id: 'a', kind: 'agent-single' }] } } }
      expect(serializeWorkflowReceiptFor(plain, channelLens('pat'))).toBe(plain)
    })

    test('the record projection REFUSES a receipt at compile time', () => {
      // The regression was a silent no-op, so the guard has to be the type
      // system rather than a runtime assertion. If someone widens
      // serializeWorkflowFor's constraint back to `<T>`, this directive stops
      // being needed and typecheck fails with "unused @ts-expect-error" —
      // the mutation test is built into the lock.
      // @ts-expect-error — a receipt has no top-level `definition`
      serializeWorkflowFor(receipt, channelLens('pat'))
      expect(true).toBe(true)
    })
  })

  // Launching a task FREEZES the definition into `workflowSnapshot`, so the
  // same env values live on in every task response — and outlive the workflow
  // (the snapshot still answers after the source is edited or deleted).
  // `GET /api/tasks/:id` is tokenAccess:'allow', so this was the widest of the
  // outlets and the one both review passes rated highest.
  describe('task snapshots carry the frozen definition', () => {
    const task = {
      id: 't1',
      name: 'carrier-run',
      workflowId: 'w1',
      workflowSnapshot: record.definition,
      status: 'done',
    } as unknown as Parameters<typeof serializeTaskFor>[0]

    test('pat: the frozen snapshot is masked; session keeps the same reference', () => {
      const out = serializeTaskFor(task, channelLens('pat'))
      const snap = out.workflowSnapshot as typeof record.definition
      expect((snap.nodes[1] as { env: Record<string, string> }).env).toEqual({
        API_TOKEN: REDACTED,
        LOG_LEVEL: REDACTED,
      })
      expect((out as unknown as { status: string }).status).toBe('done')
      expect(serializeTaskFor(task, channelLens('session'))).toBe(task)
    })

    test('a task whose snapshot has no script env is the same reference', () => {
      const plain = { workflowSnapshot: { nodes: [{ id: 'a', kind: 'agent-single' }] } } as never
      expect(serializeTaskFor(plain, channelLens('pat'))).toBe(plain)
    })

    test('serializeTaskFor is wired on every Task-returning outlet', () => {
      const routes = readFileSync(resolve(import.meta.dir, '..', 'src', 'routes/tasks.ts'), 'utf8')
      // get + create(multipart) + create + cancel + resume + retry + sync.
      // The repair endpoints deliberately do NOT appear: their responses carry
      // no definition, and the `T extends Task` constraint rejected them at
      // compile time when this wiring was first attempted.
      expect(routes.split('serializeTaskFor(').length - 1).toBeGreaterThanOrEqual(7)
    })
  })

  test('both workflow projections are wired on every outlet', () => {
    const routes = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes/workflows.ts'),
      'utf8',
    )
    // RFC-271 C1/C2 显式改判：6 → 4、2 → 1。YAML 导出与导入两条端点下线，随之少掉
    // 三个出口（export 的 record、import 的 created record 与 overwritten receipt）。
    // **守卫的意图一字未改**：每一个把工作流交出去的出口都必须过投影，少一个就是
    // 一条未脱敏的通道。数字下调是因为出口真的少了，不是因为放宽了要求。
    // records: list + detail + create + copy
    expect(routes.split('serializeWorkflowFor(').length - 1).toBeGreaterThanOrEqual(4)
    // receipts: update (PUT)
    expect(routes.split('serializeWorkflowReceiptFor(').length - 1).toBeGreaterThanOrEqual(1)
  })
})
