// RFC-224 T29 — official v1.18.3, no-LLM execution-identity preflight.
//
// This test deliberately stops at root-session creation. It proves the real
// binary's config/provider/agent/skill/session shapes against the exact
// production comparators without posting a message or spending provider
// tokens. Unlike the legacy live-LLM cases, it therefore runs whenever the
// integration workflow is enabled, even when repository secrets are absent.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCreateSessionRequest,
  validateSessionIdentity,
} from '@/services/runtime/opencode/directApiSchemas'
import { OpencodeDirectClient } from '@/services/runtime/opencode/directClient'
import { verifyExecutionIdentity } from '@/services/runtime/opencode/executionIdentity'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  prepareHermeticOpencodeLayout,
  removeHermeticOpencodeLayout,
} from '@/services/runtime/opencode/hermetic'
import {
  materializeFffCapabilityProbe,
  runFffCapabilityProbe,
} from '@/services/runtime/opencode/fffCapability'
import { withOfficialOpencodeSnapshot } from '@/services/runtime/opencode/officialBuilds'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'
import { requireRootOwnedBwrap } from '@/services/runtime/opencode/sealedSubprocess'
import {
  verifyPinnedSkillInventory,
  verifySelectedProviderInventory,
} from '@/services/runtime/opencode/verifiedLauncher'

const RUN_INTEGRATION = process.env.RUN_OPENCODE_INTEGRATION === '1'
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode'
const PINNED_MODEL = Object.freeze({ providerID: 'openai', modelID: 'gpt-5' })
const LISTEN_LINE = /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/

interface RunningServer {
  child: ReturnType<typeof Bun.spawn>
  port: Promise<number>
  stdoutDone: Promise<void>
  stderrDone: Promise<void>
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function startServer(
  binaryPath: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): RunningServer {
  const child = Bun.spawn({
    cmd: [binaryPath, 'serve', '--hostname', '127.0.0.1', '--port', '0', '--no-mdns'],
    cwd,
    env: { ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  let resolvePort!: (port: number) => void
  let rejectPort!: (error: Error) => void
  let settled = false
  const port = new Promise<number>((resolve, reject) => {
    resolvePort = resolve
    rejectPort = reject
  })
  const stdoutDone = (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline).replace(/\r$/, '')
          buffered = buffered.slice(newline + 1)
          const match = LISTEN_LINE.exec(line)
          if (settled || match === null) {
            throw new Error('unexpected official OpenCode listen output')
          }
          settled = true
          resolvePort(Number(match[1]))
        }
      }
      buffered += decoder.decode()
      if (buffered !== '' || !settled) {
        throw new Error('official OpenCode exited before a complete listen line')
      }
    } catch (error) {
      if (!settled) {
        settled = true
        rejectPort(error instanceof Error ? error : new Error('listen monitor failed'))
      }
      throw error
    } finally {
      reader.releaseLock()
    }
  })()
  void stdoutDone.catch(() => {})
  const stderrDone = (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader()
    try {
      while (!(await reader.read()).done) {
        // The no-LLM preflight has no diagnostic contract on server stderr;
        // drain it so the child cannot block on a full pipe.
      }
    } finally {
      reader.releaseLock()
    }
  })()
  void stderrDone.catch(() => {})
  return { child, port, stdoutDone, stderrDone }
}

async function stopServer(server: RunningServer): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-server.child.pid, signal)
    } catch {
      server.child.kill(signal)
    }
  }
  signalGroup('SIGTERM')
  const exited = await Promise.race([
    server.child.exited.then(() => true),
    boundedDelay(2_000).then(() => false),
  ])
  if (!exited) {
    signalGroup('SIGKILL')
    await Promise.race([server.child.exited, boundedDelay(2_000)])
  }
  await Promise.allSettled([server.stdoutDone, server.stderrDone])
}

describe.skipIf(!RUN_INTEGRATION)('RFC-224 official no-LLM execution identity', () => {
  test('attests config, provider, agent, skill, and root-session contracts on one instance', async () => {
    const canonicalTmp = await realpath(tmpdir())
    const root = await mkdtemp(join(canonicalTmp, 'aw-rfc224-official-preflight-'))
    const worktree = join(root, 'worktree')
    const storeRoot = join(root, 'store')
    await mkdir(worktree, { recursive: true, mode: 0o700 })
    await writeFile(join(worktree, 'README.md'), '# official no-LLM preflight\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'rfc224@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'RFC-224'], { cwd: worktree })
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'init fixture'], { cwd: worktree })

    const layout = await prepareHermeticOpencodeLayout(storeRoot)
    const fffProbeRoot = join(root, 'fff-probe')
    const controlledConfig = buildControlledOpencodeConfig({
      name: 'aw-rfc224-official',
      prompt: 'RFC-224 no-LLM identity preflight',
      description: 'RFC-224 no-LLM identity preflight',
      model: `${PINNED_MODEL.providerID}/${PINNED_MODEL.modelID}`,
      options: {},
      userPermission: {},
      toolOutputPattern: join(layout.xdgData, 'opencode', 'tool-output', '*'),
      shellPath: '/bin/false',
      allowShell: false,
      mcp: {},
    })
    const auth = buildStrictProviderAuth(PINNED_MODEL.providerID, {
      OPENAI_API_KEY: 'rfc224-local-schema-only-key',
    })
    const username = 'aw-rfc224-preflight'
    const password = 'aw-rfc224-preflight-password'
    const serverEnv = buildHermeticServerEnv({
      layout,
      providerID: PINNED_MODEL.providerID,
      auth,
      config: controlledConfig,
      username,
      password,
      sourceEnv: {},
    })
    serverEnv.PWD = worktree

    try {
      await withOfficialOpencodeSnapshot([OPENCODE_BIN], async (binaryPath) => {
        if (process.platform === 'linux') {
          const bwrapPath = await requireRootOwnedBwrap()
          const capability = await materializeFffCapabilityProbe({
            probeRoot: fffProbeRoot,
            bwrapPath,
          })
          await runFffCapabilityProbe({
            binaryPath,
            runRoot: root,
            probe: capability.probe,
            timeoutMs: 10_000,
          })
        }
        const server = startServer(binaryPath, worktree, serverEnv)
        try {
          const port = await Promise.race([
            server.port,
            boundedDelay(10_000).then(() => {
              throw new Error('official OpenCode listen timeout')
            }),
          ])
          const client = new OpencodeDirectClient({
            origin: `http://127.0.0.1:${port}`,
            directory: worktree,
            username,
            password,
            budgets: { maxJsonBytes: 4 * 1024 * 1024, requestTimeoutMs: 10_000 },
          })

          const effectiveConfig = await client.getConfig()
          const providers = await client.getConfigProviders()
          const agents = await client.getAgents()
          const skills = await client.getSkills()
          const secondAgents = await client.getAgents()
          const proof = verifyExecutionIdentity({
            expectedInlineConfig: controlledConfig,
            effectiveConfig,
            agents,
            secondAgents,
            selectedAgentName: 'aw-rfc224-official',
            permissionHome: layout.home,
          })
          expect(proof.controlledAgentNames).toEqual(['aw-rfc224-official'])
          verifySelectedProviderInventory(providers, PINNED_MODEL)
          verifyPinnedSkillInventory(skills)

          const title = 'agent-workflow:rfc224:official-no-llm-preflight'
          const created = await client.createSession(
            buildCreateSessionRequest({
              title,
              agent: 'aw-rfc224-official',
              model: PINNED_MODEL,
            }),
          )
          const session = validateSessionIdentity(
            created,
            {
              directory: worktree,
              path: '',
              title,
              agent: 'aw-rfc224-official',
              model: PINNED_MODEL,
              version: '1.18.3',
            },
            'create-response',
          )
          expect(session.projectID).not.toBe('global')
          expect(session.parentID).toBeUndefined()
          expect(session.workspaceID).toBeUndefined()
          expect(session.share).toBeUndefined()
          expect(session.revert).toBeUndefined()
          expect(session.metadata).toBeUndefined()
        } finally {
          await stopServer(server)
        }
      })
    } finally {
      await removeSealedTree(fffProbeRoot).catch(() => undefined)
      await removeHermeticOpencodeLayout(storeRoot).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
