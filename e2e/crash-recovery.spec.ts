// RFC-054 W1-3 — crash-recovery e2e: SIGKILL daemon mid-task, restart against
// the same home, watch lifecycle invariants flip the orphan task to
// `interrupted`, then resume via the UI and observe it complete.
//
// LOCKS: the "daemon-restart" recovery user骨牌 (orphans.ts boot reap +
// resumeTask scheduler kick + frontend Resume button wiring). Three angles:
//
//   1. SIGKILL → restart → interrupted → click Resume → done
//      (the headline crash recovery loop — what users experience after an
//       unexpected daemon death.)
//
//   2. SIGTERM → restart → task ends `canceled` (NOT resumable via Resume)
//      (graceful shutdown is a distinct contract — the scheduler's abort
//       handler marks the task `canceled`, which `resumeTask` deliberately
//       does not accept. Users relaunch instead of resuming. Catches future
//       refactors that accidentally collapse the canceled/interrupted
//       distinction.)
//
//   3. Two SIGKILLs in a row → final resume → done
//      (resume is idempotent across multiple interrupt cycles. Catches
//       "resume only works once" regressions.)
//
// Each case rebuilds a fresh repo + workflow under its own AGENT_WORKFLOW_HOME
// so they are independent. The slow opencode stub (`stub-opencode-slow.sh`)
// is driven by env var `STUB_OPENCODE_SLEEP_MS`: on the first daemon we set
// it high so the task is in `running` when we kill; on the resume daemon we
// set it 0 so the task completes promptly.

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
const SLOW_STUB = resolve(here, 'fixtures', 'stub-opencode-slow.sh')

// Crash-recovery loop touches the database multiple times across daemon
// restarts; default 90s timeout is enough but bump locally if the e2e box
// is slow.
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

interface RepoFixture {
  repoDir: string
  cleanup: () => void
}

function makeFixtureRepo(): RepoFixture {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-crash-'))
  writeFileSync(join(repoDir, 'README.md'), '# crash-recovery fixture repo\n', 'utf-8')
  initGitRepo(repoDir)
  return {
    repoDir,
    cleanup: () => {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

interface SeededFixture {
  agentName: string
  workflowId: string
}

async function seedAgentAndWorkflow(daemon: DaemonHandle): Promise<SeededFixture> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'crash-recovery-stub'
  const aRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'crash-recovery e2e stub',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!aRes.ok) throw new Error(`seed agent: ${aRes.status}`)
  const agent = (await aRes.json()) as { id: string }

  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'crash-recovery-wf',
      description: 'crash-recovery e2e',
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e2',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seed workflow: ${wfRes.status}`)
  const wf = (await wfRes.json()) as { id: string }
  return { agentName, workflowId: wf.id }
}

async function launchTask(
  daemon: DaemonHandle,
  workflowId: string,
  repoPath: string,
  name = 'crash-recovery-task',
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflowId,
      name,
      inputs: { topic: 'crash-test' },
      repoUrl: pathToFileURL(repoPath).href,
      ref: 'main',
    }),
  })
  if (!res.ok) {
    throw new Error(`launchTask: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { id: string }
  return body.id
}

async function getTaskStatus(daemon: DaemonHandle, taskId: string): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  if (!res.ok) throw new Error(`getTaskStatus ${taskId}: ${res.status}`)
  const body = (await res.json()) as { status: string }
  return body.status
}

async function waitForStatus(
  daemon: DaemonHandle,
  taskId: string,
  predicate: (status: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await getTaskStatus(daemon, taskId)
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`waitForStatus(${label}) timed out after ${timeoutMs}ms; last=${last}`)
}

const TERMINAL = new Set(['done', 'failed', 'canceled', 'interrupted', 'exhausted'])

async function pollUntilTerminal(
  daemon: DaemonHandle,
  taskId: string,
  timeoutMs: number,
): Promise<string> {
  return waitForStatus(daemon, taskId, (s) => TERMINAL.has(s), timeoutMs, 'terminal')
}

async function primeAuthLocalStorage(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test('SIGKILL daemon mid-task → restart → task=interrupted → click Resume → done', async ({
  page,
}) => {
  const repo = makeFixtureRepo()

  // Daemon A: slow stub so the task is still running when we kill.
  const daemonA = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '15000' },
  })
  const home = daemonA.home

  try {
    const fixtures = await seedAgentAndWorkflow(daemonA)
    const taskId = await launchTask(daemonA, fixtures.workflowId, repo.repoDir)

    // Wait until the task is actually in 'running' (scheduler dispatched +
    // runner spawned its child + the stub started sleeping).
    await waitForStatus(daemonA, taskId, (s) => s === 'running', 10_000, 'A-running')

    // Hard kill — exercises orphans.reapOrphanRuns on next boot.
    await daemonA.killChild('SIGKILL')

    // Daemon B: same home, slow stub but with 0ms sleep so the resumed task
    // completes promptly.
    const daemonB = await startDaemon({
      home,
      stubOpencode: SLOW_STUB,
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
    })

    try {
      // Boot-time reap must have flipped the orphan.
      const afterRestart = await getTaskStatus(daemonB, taskId)
      expect(afterRestart).toBe('interrupted')

      // UI surfaces the interrupted state on the task detail page.
      await primeAuthLocalStorage(page, daemonB)
      await page.goto(`${daemonB.baseUrl}/tasks/${taskId}`)
      await expect(page.locator('.status-chip', { hasText: /interrupted/i }).first()).toBeVisible({
        timeout: 15_000,
      })

      // Click Resume task — the button comes from i18n 'tasks.resumeButton'
      // = 'Resume task' under en-US.
      await page.getByRole('button', { name: /resume task/i }).click()

      // Task reaches done.
      const final = await pollUntilTerminal(daemonB, taskId, 30_000)
      expect(final).toBe('done')

      // Cross-check via UI — the status chip flips to 'done'.
      await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible({
        timeout: 15_000,
      })
    } finally {
      await daemonB.stop()
    }
  } finally {
    // Both daemons share the home; second stop kept it (keepHome=true), so
    // the spec explicitly drops it now.
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    repo.cleanup()
  }
})

test('SIGTERM (graceful) → task ends interrupted and remains resumable', async () => {
  const repo = makeFixtureRepo()

  const daemonA = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '15000' },
  })
  const home = daemonA.home

  try {
    const fixtures = await seedAgentAndWorkflow(daemonA)
    const taskId = await launchTask(daemonA, fixtures.workflowId, repo.repoDir)
    await waitForStatus(daemonA, taskId, (s) => s === 'running', 10_000, 'A-running-sigterm')

    // SIGTERM walks the graceful-shutdown path: cli/start.ts aborts
    // in-flight runners (their AbortControllers SIGTERM the opencode child).
    // RFC-202 records this as daemon-restart/interrupted, not a user cancel,
    // so the existing task remains resumable after the daemon returns.
    // 35s SIGKILL fallback gives the 30s graceful budget headroom.
    await daemonA.killChild('SIGTERM', 35_000)

    // LOCKS: a daemon-owned shutdown must not masquerade as a user cancel.
    // The harness disables boot auto-resume, so exercise the explicit resume
    // endpoint and prove the original task can still reach done.
    const daemonB = await startDaemon({
      home,
      stubOpencode: SLOW_STUB,
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
    })
    try {
      const afterRestart = await getTaskStatus(daemonB, taskId)
      expect(afterRestart).toBe('interrupted')

      const resumeRes = await fetch(`${daemonB.baseUrl}/api/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemonB.token}` },
      })
      expect(resumeRes.ok).toBe(true)
      const resumed = await pollUntilTerminal(daemonB, taskId, 30_000)
      expect(resumed).toBe('done')

      // Sanity: we can still launch a NEW task on the same workflow + repo
      // (graceful shutdown didn't poison the daemon's runtime).
      const newTaskId = await launchTask(daemonB, fixtures.workflowId, repo.repoDir, 'relaunch')
      const final = await pollUntilTerminal(daemonB, newTaskId, 30_000)
      expect(final).toBe('done')
    } finally {
      await daemonB.stop()
    }
  } finally {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    repo.cleanup()
  }
})

test('multiple SIGKILL → restart cycles, final resume reaches done (idempotent)', async ({
  page,
}) => {
  const repo = makeFixtureRepo()

  // Cycle 1: launch + kill A.
  const daemonA = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '15000' },
  })
  const home = daemonA.home

  try {
    const fixtures = await seedAgentAndWorkflow(daemonA)
    const taskId = await launchTask(daemonA, fixtures.workflowId, repo.repoDir)
    await waitForStatus(daemonA, taskId, (s) => s === 'running', 10_000, 'A-running-cycle1')
    await daemonA.killChild('SIGKILL')

    // Cycle 2: same slow stub so the resumed task ALSO ends up running, then
    // we kill again.
    const daemonB = await startDaemon({
      home,
      stubOpencode: SLOW_STUB,
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '15000' },
    })
    expect(await getTaskStatus(daemonB, taskId)).toBe('interrupted')

    // Resume via REST (UI variant covered in case 1).
    const r1 = await fetch(`${daemonB.baseUrl}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemonB.token}` },
    })
    expect(r1.ok).toBe(true)
    await waitForStatus(daemonB, taskId, (s) => s === 'running', 10_000, 'B-running-cycle2')
    await daemonB.killChild('SIGKILL')

    // Cycle 3: fast stub so the final resume actually completes.
    const daemonC = await startDaemon({
      home,
      stubOpencode: SLOW_STUB,
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
    })

    try {
      expect(await getTaskStatus(daemonC, taskId)).toBe('interrupted')

      await primeAuthLocalStorage(page, daemonC)
      await page.goto(`${daemonC.baseUrl}/tasks/${taskId}`)
      await expect(page.locator('.status-chip', { hasText: /interrupted/i }).first()).toBeVisible({
        timeout: 15_000,
      })

      await page.getByRole('button', { name: /resume task/i }).click()
      const final = await pollUntilTerminal(daemonC, taskId, 30_000)
      expect(final).toBe('done')
    } finally {
      await daemonC.stop()
    }
  } finally {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    repo.cleanup()
  }
})
