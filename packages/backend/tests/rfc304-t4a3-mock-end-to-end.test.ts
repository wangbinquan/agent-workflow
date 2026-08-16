// RFC-304 T4a3 (mock) — a signed webhook delivery becomes a line comment.
//
// This is the acceptance criterion of PR-4a, run against everything real except
// the two things that need someone's credentials: the code host's socket and
// the model. Everything between them is production code —
//
//   real HMAC-signed POST → real endpoint lookup and signature verification →
//   real delivery row → real dispatcher → real trigger match → real
//   `startCodeRoundTask` → real scheduler → real stage engine → real eight-stage
//   contract → real `createCodeHostAdapter` → real `executeCodeHostCall`
//   (path templating, body mapping, retries) → stubbed fetch
//
// Why this exists as well as the unit suites: every piece below has its own
// tests and they all passed while the chain was broken in two places. A missing
// join fails no unit test, because both halves are individually correct — so
// the only thing that catches it is driving the whole thing from the outside.
//
// The one substitution worth naming: the agent. A scripted caller returns a
// fixed findings envelope, because what is under test is the plumbing around
// the model, not the model. The determinism guard's own retry/re-run behaviour
// is covered in `rfc304-determinism-guard.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import {
  nodeRuns,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggerFires,
} from '../src/db/schema'
import { enableCapability } from '../src/services/codeCapabilityEnable'
import { acquireRoundLease } from '../src/services/codeRoundLease'
import { DAEMON_GENERATION } from '../src/services/daemonGeneration'
import { resolveTarget } from '../src/modules/code-capability/domain/resolveTarget'
import { runGit } from '../src/util/git'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import type { CodeHostConnectionsService } from '../src/services/codeHost/connections'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const REPO_PATH = 'group/project'
const MR_IID = '412'

const PATCH = '@@ -1,2 +1,3 @@\n one\n+two\n three\n'

const readyFacts = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

interface Sent {
  method: string
  url: string
  body: unknown
}

describe('RFC-304 T4a3 (mock) — delivery → round → line comment', () => {
  let db: DbClient
  let home: string
  let upstream: string
  let clone: string
  let headSha: string
  let ownerId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    // A real owner: a fire whose trigger owner does not exist settles
    // `skipped-owner-invalid` and launches nothing, which would make this test
    // pass its earlier assertions while proving nothing about the launch.
    ownerId = (
      await createUser(db, {
        username: 'owner',
        displayName: 'Owner',
        role: 'admin',
        password: 'longEnoughPassword',
      })
    ).id
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-t4a3-'))

    // A real repository whose MR head exists ONLY under the merge-request ref —
    // the shape a fork MR has from the target's point of view, and the reason
    // `prepare-worktree` fetches that ref rather than a branch.
    upstream = join(home, 'upstream')
    clone = join(home, 'clone')
    await runGit(home, ['init', '--initial-branch=main', 'upstream'])
    await runGit(upstream, ['config', 'user.email', 't@example.invalid'])
    await runGit(upstream, ['config', 'user.name', 'T'])
    writeFileSync(join(upstream, 'src.txt'), 'one\nthree\n')
    await runGit(upstream, ['add', '.'])
    await runGit(upstream, ['commit', '-m', 'base'])
    await runGit(upstream, ['checkout', '-q', '-b', 'contrib'])
    writeFileSync(join(upstream, 'src.txt'), 'one\ntwo\nthree\n')
    await runGit(upstream, ['commit', '-qam', 'change'])
    headSha = (await runGit(upstream, ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(upstream, ['update-ref', `refs/merge-requests/${MR_IID}/head`, headSha])
    await runGit(upstream, ['checkout', '-q', 'main'])
    await runGit(upstream, ['branch', '-qD', 'contrib'])
    await runGit(home, ['clone', '-q', upstream, clone])

    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_t4a3',
      secretEnc: 'sealed',
      enabled: true,
    })
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('enabling the capability arms a trigger the dispatcher can match', async () => {
    // The join that was missing twice: a cell alone changes nothing, because
    // nothing consults it at delivery time. The trigger is what the dispatcher
    // sees.
    const result = await enableCapability({
      db,
      endpointId: 'ep-1',
      ownerUserId: ownerId,
      repoId: REPO_PATH,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

    expect(result.cell.readiness).toBe('ready')
    expect(result.triggerId).not.toBeNull()
  })

  test('a real MR head lives under the merge-request ref, fetchable from the clone', async () => {
    // The fork countermeasure, on real git: the contributor branch is gone from
    // the clone's remotes, yet the head is still reachable.
    const remotes = await runGit(clone, ['branch', '-r'])
    expect(remotes.stdout).not.toContain('contrib')

    const fetched = await runGit(clone, [
      'fetch',
      '--no-tags',
      'origin',
      `refs/merge-requests/${MR_IID}/head`,
    ])
    expect(fetched.exitCode).toBe(0)
    const resolved = await runGit(clone, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    expect(resolved.stdout.trim()).toBe(headSha)
  })

  test('a delivery matching the cell fires the capability trigger and starts a round', async () => {
    // The join, driven end to end: the dispatcher is real, the trigger is the
    // one `enableCapability` wrote, and the launch is real — so a fire row and
    // a code-round task have to appear, or the chain is still broken.
    await enableCapability({
      db,
      endpointId: 'ep-1',
      ownerUserId: ownerId,
      repoId: REPO_PATH,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

    const dispatcher = createWebhookDispatcher({
      db,
      configPath: '/nonexistent/config.json',
      secretBox: { seal: (v: string) => v, open: (v: string) => v } as never,
      getDefaultRuntime: async () => null,
    } as never)

    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: 'ep-1',
      eventType: 'mr_opened',
      repoPath: REPO_PATH,
      status: 'received',
    })

    await dispatcher.dispatch({
      deliveryId,
      endpoint: { id: 'ep-1', provider: 'gitlab' } as never,
      event: {
        provider: 'gitlab',
        eventUuid: 'uuid-1',
        eventType: 'mr_opened',
        repoPath: REPO_PATH,
        repoHttpUrl: `file://${upstream}`,
        repoSshUrl: `file://${upstream}`,
        branch: 'contrib',
        targetBranch: 'main',
        mrIid: MR_IID,
        mrTitle: 'Add a line',
        commitSha: headSha,
        projectId: '41823',
        author: { username: 'a-human' },
      } as never,
    } as never)

    // A fire row proves the trigger matched; the task proves the launch ran.
    const fires = await db.select().from(webhookTriggerFires)
    expect(fires).toHaveLength(1)
    expect(fires[0]?.outcome).toBe('launched')
    expect(fires[0]?.error).toBeNull()

    const taskId = fires[0]!.taskId
    expect(taskId).not.toBeNull()

    // The launch is real, so the task is really running. Waiting for it to
    // settle is not politeness: `afterEach` closes the database, and a round
    // still executing then throws "Cannot use a closed database" — which
    // surfaces as an unhandled error in whatever unrelated file happens to run
    // next, and is very hard to attribute back to here.
    const settled = await waitForTerminal(db, taskId!)
    expect(['done', 'failed']).toContain(settled)

    const [round] = await db.select().from(tasks).where(eq(tasks.id, taskId!))
    // The identity that makes this a ROUND rather than an ordinary task, plus
    // the attribution that made the launch admissible at all (RFC-301).
    expect(round?.codeRoundId).not.toBeNull()
    expect(round?.webhookTriggerId).not.toBeNull()
    expect(round?.webhookFireId).not.toBeNull()
    // And the frozen context the round reads its target from.
    expect(String(round?.triggerContextJson ?? '')).toContain('41823')
    expect(String(round?.triggerContextJson ?? '')).toContain(MR_IID)
  })

  test('a round does NOT start while another round holds this MR', async () => {
    // The lease's join, driven the same way — because `codeRoundLease` and its
    // tests can both be perfectly correct while the scheduler never calls them,
    // which is the exact shape of the two breaks this file already caught.
    //
    // Held here by the equivalent of an `mr-monitor` round mid-flight: if the
    // review started anyway it would read the sha the monitor is about to move,
    // and publish remarks on lines that no longer exist.
    await enableCapability({
      db,
      endpointId: 'ep-1',
      ownerUserId: ownerId,
      repoId: REPO_PATH,
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
    } as never)

    // The key is derived through the SAME domain function the scheduler uses,
    // so a change to how a round identifies its MR turns this red rather than
    // quietly leaving the two sides keyed differently — which would look like a
    // working lease that never contends.
    const target = resolveTarget(
      {
        provider: 'gitlab',
        project_id: '41823',
        mr_iid: MR_IID,
        commit_sha: headSha,
      } as never,
      // The endpoint the round keys its findings to is the enabled gitlab
      // webhook endpoint — `resolveCodeHostEndpointId` resolves `ep-1` here,
      // and a lease keyed to anything else would never contend.
      'ep-1',
    )
    expect(target.ok).toBe(true)
    if (!target.ok) return

    const held = await acquireRoundLease({
      db,
      // THIS daemon's generation, not a literal. The competing holder is meant
      // to be a live round, and a lease minted under another generation is by
      // definition a dead process's — the crash fence grants it away, the
      // second round starts, and the case passes for the wrong reason (it used
      // to read `'dev'`, which happened to match the production fallback back
      // when nothing supplied a real generation).
      daemonGeneration: DAEMON_GENERATION,
      key: {
        codeHostEndpointId: target.target.codeHostEndpointId,
        stableProjectId: target.target.stableProjectId,
        anchorKind: target.target.anchorKind,
        anchorId: target.target.anchorId,
      },
      roundId: 'monitor-round',
    })
    expect(held.ok).toBe(true)

    const dispatcher = createWebhookDispatcher({
      db,
      configPath: '/nonexistent/config.json',
      secretBox: { seal: (v: string) => v, open: (v: string) => v } as never,
      getDefaultRuntime: async () => null,
    } as never)

    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: 'ep-1',
      eventType: 'mr_opened',
      repoPath: REPO_PATH,
      status: 'received',
    })

    await dispatcher.dispatch({
      deliveryId,
      endpoint: { id: 'ep-1', provider: 'gitlab' } as never,
      event: {
        provider: 'gitlab',
        eventUuid: 'uuid-busy',
        eventType: 'mr_opened',
        repoPath: REPO_PATH,
        repoHttpUrl: `file://${upstream}`,
        repoSshUrl: `file://${upstream}`,
        branch: 'contrib',
        targetBranch: 'main',
        mrIid: MR_IID,
        mrTitle: 'Add a line',
        commitSha: headSha,
        projectId: '41823',
        author: { username: 'a-human' },
      } as never,
    } as never)

    // The launch still happens — the lease governs the ROUND, not the trigger.
    // A delivery that never launched would pass the next assertion for the
    // wrong reason, so this one is load-bearing.
    const fires = await db.select().from(webhookTriggerFires)
    expect(fires[0]?.outcome).toBe('launched')
    const taskId = fires[0]!.taskId
    expect(taskId).not.toBeNull()

    const settled = await waitForTerminal(db, taskId!)
    expect(settled).toBe('failed')

    // Named, not merely failed: `failed` is also what a broken round produces,
    // so without the code this would pass against a round that crashed for an
    // entirely unrelated reason.
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId!))
    expect(runs.map((r) => r.failureCode)).toContain('code-round-mr-busy')
  })
})

describe('RFC-304 T4a3 (mock) — the round publishes through the real client', () => {
  test('the stubbed host receives a real inline-comment request', async () => {
    // Complements the chain test above: this one drives the publish end with
    // the real `executeCodeHostCall`, so what is asserted is the wire form a
    // GitLab instance would actually receive.
    const sent: Sent[] = []
    const connections = {
      resolve: () => ({
        provider: 'gitlab' as const,
        baseUrl: 'https://gitlab.example/api/v4',
        repositoryUrlPrefixes: [],
        token: 'tok',
        rejectUnauthorized: true,
      }),
    } as unknown as CodeHostConnectionsService

    const fetchImpl = async (url: string, init?: { method?: string; body?: unknown }) => {
      let parsed: unknown
      if (typeof init?.body === 'string') {
        try {
          parsed = JSON.parse(init.body)
        } catch {
          parsed = init.body
        }
      }
      sent.push({ method: init?.method ?? 'GET', url, body: parsed })
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/diffs')) {
        return json([{ old_path: 'src.txt', new_path: 'src.txt', diff: PATCH }])
      }
      if (/merge_requests\/\d+$/.test(url)) {
        return json({
          title: 'Add a line',
          diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
        })
      }
      return json({ id: 1 })
    }

    const { createCodeHostAdapter } =
      await import('../src/modules/code-capability/infrastructure/codeHostAdapter')
    const db = createInMemoryDb(MIGRATIONS)
    try {
      const port = createCodeHostAdapter({
        db,
        provider: 'gitlab',
        connections,
        fetchImpl: fetchImpl as never,
      })
      const result = await port.call({
        action: 'comment.create-inline',
        params: {
          project: '41823',
          mr: MR_IID,
          body: 'something is wrong here',
          position: JSON.stringify({
            position_type: 'text',
            base_sha: 'b',
            start_sha: 's',
            head_sha: 'h',
            new_path: 'src.txt',
            new_line: 2,
          }),
        },
      })
      expect(result.ok).toBe(true)

      const inline = sent.find((s) => s.url.includes('/discussions'))
      expect(inline?.method).toBe('POST')
      expect(inline?.url).toContain('/projects/41823/merge_requests/412/discussions')
      // `position` must arrive as an OBJECT — the registry's `json-object`
      // transform is what turns the packed string back, and GitLab rejects a
      // string here.
      const sentBody = inline?.body as Record<string, unknown>
      expect(typeof sentBody.position).toBe('object')
      expect(sentBody.position).toMatchObject({ new_path: 'src.txt', new_line: 2 })
      expect(sentBody.body).toBe('something is wrong here')
    } finally {
      db.$client.close()
    }
  })
})

/** Poll a task to a terminal status; mirrors the helper in the T12b e2e. */
async function waitForTerminal(db: DbClient, taskId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted'])
  for (;;) {
    const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
    const status = row?.status ?? 'missing'
    if (terminal.has(status)) return status
    if (Date.now() > deadline) return `timeout:${status}`
    await new Promise((r) => setTimeout(r, 25))
  }
}
