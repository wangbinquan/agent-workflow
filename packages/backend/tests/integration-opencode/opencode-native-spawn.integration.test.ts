// RFC-windows PR-3 T11 — verify the daemon's ACTUAL spawn model works on Windows.
//
// 为什么这条测试存在：PR-3 策略 D（原生 opencode，不用 WSL）的核心假设是
// 现有 `runtime/opencode/` driver（`buildOpencodeSpawn` + `buildInlineConfig`）
// 在 Windows 上直接可用。裸 `opencode run` 已实测跑通（2026-07-08），但 daemon
// 的 spawn 路径多了三样：① `OPENCODE_CONFIG_CONTENT` inline agent 定义 +
// `--agent <name>` flag（而非默认 agent）② `OPENCODE_CONFIG_DIR` per-run 目录
// ③ `PWD = worktree`。这条测试用 daemon 的真实构造器（非手搓 argv）组装
// spawn plan，在 Windows 上跑一条真实 agent 任务，断言 stdout JSON 事件流
// （`step_start`/`text`/`step_finish`）完整到达 pump + agent 输出正确。
//
// 与 `opencode-live.integration.test.ts` 的区别：那个用手搓 argv + 默认 agent；
// 本测试用 `buildOpencodeSpawn` + `buildInlineConfig`（inline agent + `--agent`
// flag），覆盖 daemon 的真实 spawn 路径。两者互补。
//
// Gating：与 live 套件同档——需 `RUN_OPENCODE_INTEGRATION=1` + 可用 auth
// （ANTHROPIC/OPENAI key 或 ~/.config/opencode/auth.json 或 OPENCODE_AUTH_CONTENT），
// 否则 skip（避免 normal `bun test` 产生 LLM 费用 / flakiness）。

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { Agent } from '@agent-workflow/shared'
import { buildInlineConfig } from '@/services/runner'
import { buildOpencodeSpawn } from '@/services/runtime/opencode/spawn'
import { materializeInventoryPlugin } from '@/opencode-plugin'
import { toFileUrl } from '@/util/platform'

const RUN_INTEGRATION = process.env.RUN_OPENCODE_INTEGRATION === '1'

function detectAuthAvailable(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return true
  if (process.env.OPENCODE_AUTH_CONTENT) return true
  // RFC-windows: opencode also accepts provider config in ~/.config/opencode/opencode.json
  // (e.g. aliyun-bailian with an inline apiKey) — treat that as auth-available too.
  try {
    if (existsSync(join(homedir(), '.config', 'opencode', 'opencode.json'))) return true
    if (existsSync(join(homedir(), '.config', 'opencode', 'auth.json'))) return true
  } catch {
    /* ignore */
  }
  return false
}

const AUTH_AVAILABLE = detectAuthAvailable()
const SKIP = !RUN_INTEGRATION || !AUTH_AVAILABLE

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode'

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'aw-pr3-native',
    description: 'RFC-windows PR-3 native Windows spawn verification',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You are a test agent. Reply with exactly the single word: pong. Then stop.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function ensureGitRepo(): string {
  // opencode --format json requires cwd to be a non-empty git repo (same
  // constraint the daemon enforces via per-task worktrees).
  const dir = mkdtempSync(join(tmpdir(), 'aw-pr3-native-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'it@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'it'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# pr3 fixture\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

interface RunResult {
  exitCode: number
  events: Array<Record<string, unknown>>
  stdoutLines: string[]
  stderrTail: string
  runDir: string
  inventoryOutPath?: string
}

async function runViaDaemonSpawnPlan(
  opts: { timeoutMs?: number; withInventoryPlugin?: boolean } = {},
): Promise<RunResult> {
  const worktreePath = ensureGitRepo()
  const runDir = mkdtempSync(join(tmpdir(), 'aw-pr3-run-'))
  const agent = makeAgent()
  // buildInlineConfig produces the inline agent map the daemon injects as
  // OPENCODE_CONFIG_CONTENT. Empty params Map = no per-agent runtime overrides
  // (same as a default-config agent).
  const inlineConfig = buildInlineConfig(agent, new Map(), [], [], [])
  let inventoryOutPath: string | undefined
  if (opts.withInventoryPlugin) {
    // RFC-windows PR-3 T12: verify the inventory dump plugin (.mjs + file:// +
    // OPENCODE_AW_INVENTORY_OUT) loads on Windows. Mirrors runner.ts:549-552.
    const pluginPath = await materializeInventoryPlugin(runDir)
    inlineConfig.plugin = [toFileUrl(pluginPath)]
    inventoryOutPath = join(runDir, 'inventory.json')
  }
  const inlineConfigSerialized = JSON.stringify(inlineConfig)

  // The daemon's real spawn plan builder.
  const plan = buildOpencodeSpawn({
    opencodeCmd: [OPENCODE_BIN],
    agentName: agent.name,
    prompt: 'Reply now.',
    worktreePath,
    runDir,
    inlineConfigSerialized,
    inventoryOutPath,
  })

  const timeoutMs = opts.timeoutMs ?? 90_000
  return new Promise<RunResult>((resolveP, rejectP) => {
    const child = Bun.spawn({
      cmd: plan.cmd,
      cwd: worktreePath,
      env: plan.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    let stdoutBuf = ''
    const stdoutLines: string[] = []
    const events: Array<Record<string, unknown>> = []
    let stderrBuf = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      rejectP(
        new Error(`opencode timed out after ${timeoutMs}ms; stderr=${stderrBuf.slice(0, 300)}`),
      )
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    const stdoutReader = child.stdout.getReader()
    const stderrReader = child.stderr.getReader()
    const decoder = new TextDecoder()
    ;(async () => {
      while (true) {
        const { value, done } = await stdoutReader.read()
        if (done) break
        stdoutBuf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          // RFC-windows PR-3 T11: strip trailing \r — opencode.cmd shim on Windows
          // may emit CRLF line endings; JSON.parse tolerates no trailing whitespace
          // but a stray \r must not survive into the parsed event.
          const line = stdoutBuf.slice(0, nl).replace(/\r$/, '').trimEnd()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (line.length === 0) continue
          stdoutLines.push(line)
          try {
            events.push(JSON.parse(line) as Record<string, unknown>)
          } catch {
            // Non-JSON banners tolerated — we only care about parseable events.
          }
        }
      }
    })().catch(() => {})
    ;(async () => {
      while (true) {
        const { value, done } = await stderrReader.read()
        if (done) break
        stderrBuf += decoder.decode(value, { stream: true })
      }
    })().catch(() => {})

    child.exited.then((code) => {
      clearTimeout(timer)
      if (stdoutBuf.trim().length > 0) {
        stdoutLines.push(stdoutBuf.trim())
        try {
          events.push(JSON.parse(stdoutBuf.trim()) as Record<string, unknown>)
        } catch {
          /* ignore */
        }
      }
      resolveP({
        exitCode: code ?? -1,
        events,
        stdoutLines,
        stderrTail: stderrBuf.slice(-1000),
        runDir,
        inventoryOutPath,
      })
    })
  })
}

describe.skipIf(SKIP)('RFC-windows PR-3 — daemon spawn plan on native opencode', () => {
  test('buildOpencodeSpawn + inline agent + --agent → stdout JSON event stream', async () => {
    const r = await runViaDaemonSpawnPlan()
    // opencode ran the inline-defined agent and produced parseable JSON events.
    expect(r.events.length).toBeGreaterThan(0)
    const types = r.events.map((e) => e.type as string)
    expect(types).toContain('step_start')
    expect(types).toContain('step_finish')
    // The agent's reply ("pong") arrives in a text event.
    const textEvents = r.events.filter((e) => e.type === 'text')
    expect(textEvents.length).toBeGreaterThan(0)
    const replied = textEvents.some((e) => {
      const part = e.part as { text?: string } | undefined
      return typeof part?.text === 'string' && part.text.toLowerCase().includes('pong')
    })
    expect(replied).toBe(true)
  }, 120_000)

  test('exit code 0 (clean run)', async () => {
    const r = await runViaDaemonSpawnPlan()
    expect(r.exitCode).toBe(0)
  }, 120_000)

  test('inventory dump plugin (.mjs + file:// + OPENCODE_AW_INVENTORY_OUT) loads on Windows', async () => {
    // RFC-windows PR-3 T12: the inventory plugin is materialized into runDir +
    // injected as a file:// spec (PR-2's toFileUrl). Verify opencode loads it
    // on Windows + writes the inventory snapshot to OPENCODE_AW_INVENTORY_OUT.
    const r = await runViaDaemonSpawnPlan({ withInventoryPlugin: true })
    expect(r.exitCode).toBe(0)
    expect(r.inventoryOutPath).toBeDefined()
    expect(existsSync(r.inventoryOutPath!)).toBe(true)
    // The dump plugin writes a JSON snapshot; parse it to confirm it's valid
    // (not a partial / error write).
    const snapshot = JSON.parse(readFileSync(r.inventoryOutPath!, 'utf-8')) as Record<
      string,
      unknown
    >
    // The snapshot shape is opaque to PR-3; we only assert it's a JSON object
    // the plugin produced (non-empty), proving the plugin loaded + ran.
    expect(Object.keys(snapshot).length).toBeGreaterThan(0)
  }, 120_000)
})
