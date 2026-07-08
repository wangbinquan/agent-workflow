// RFC-030 — MCP interface probe service.
//
// Public API:
//   probeMcp(mcp, opts?) → ProbeResult
//
// Behaviour:
//   - Throws ValidationError('mcp-disabled') *before* opening anything if
//     mcp.enabled === false. The route layer maps this to HTTP 422.
//   - Otherwise opens a transport (stdio for type='local', streamable-http
//     with SSE fallback for type='remote'), runs the SDK handshake, then
//     fans out listTools / listResources / listResourceTemplates / listPrompts
//     in parallel. Each list call uses mcp.config.timeoutMs ?? 30_000.
//     Overall ceiling is 60s (HARD_TOTAL_TIMEOUT_MS); on hit we abort and
//     return errorCode='timeout'. The transport is always closed in finally.
//   - Per-list failures while initialize succeeded → status='ok',
//     errorCode='partial', errorDetail.partialFailures=[{method, message}]
//     and the affected list is null. The server is reachable; it just
//     doesn't implement that method, which is normal.
//   - Whole-probe failures → status='error', all list fields null, errorCode
//     mapped per design §6 (connect-failed / handshake-failed / auth-required
//     / timeout / internal-error).
//   - stderr (stdio) and HTTP body excerpts go through redactSensitiveString
//     before they land in errorDetail.
//
// In-flight dedup: a module-level Map keyed by mcp.name ensures concurrent
// POST /api/mcps/:name/probe calls share the same in-flight Promise; tests
// observe this by spying that the injected openClient factory is called only
// once. Cleared in finally.
//
// Dependency injection: `opts.openClient` lets unit tests substitute a fake
// client without spawning real subprocesses or making HTTP calls. The real
// SDK-backed openClient lives in this file (`defaultOpenClient`) and is the
// only path that exercises the SDK; integration tests in
// `tests/mcp-probe-*-integration.test.ts` cover it end-to-end with a real
// in-process MCP server fixture.

import type {
  Mcp,
  McpProbeErrorCodeT,
  McpPromptInfo,
  McpResourceInfo,
  McpResourceTemplateInfo,
  McpToolInfo,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { redactSensitiveString } from '@/util/redact'
import { isWindows } from '@/util/platform'

const log = createLogger('mcpProbe')

const HARD_TOTAL_TIMEOUT_MS = 60_000
const DEFAULT_LIST_TIMEOUT_MS = 30_000
const STDERR_CAPTURE_BYTES = 4096

/** What the probe captures from one MCP server. */
export interface ProbeResult {
  status: 'ok' | 'error'
  latencyMs: number
  handshakeMs: number | null
  serverInfo: { name: string; version?: string } | null
  protocolVersion: string | null
  capabilities: Record<string, unknown> | null
  tools: McpToolInfo[] | null
  resources: McpResourceInfo[] | null
  resourceTemplates: McpResourceTemplateInfo[] | null
  prompts: McpPromptInfo[] | null
  errorCode: McpProbeErrorCodeT | null
  errorMessage: string | null
  errorDetail: Record<string, unknown> | null
  startedAt: number
  finishedAt: number
}

/** A client abstraction the orchestrator can drive; real impl wraps the SDK. */
export interface ProbedMcpClient {
  serverInfo: { name: string; version?: string } | null
  protocolVersion: string | null
  capabilities: Record<string, unknown> | null
  listTools(signal: AbortSignal, timeoutMs: number): Promise<McpToolInfo[]>
  listResources(signal: AbortSignal, timeoutMs: number): Promise<McpResourceInfo[]>
  listResourceTemplates(signal: AbortSignal, timeoutMs: number): Promise<McpResourceTemplateInfo[]>
  listPrompts(signal: AbortSignal, timeoutMs: number): Promise<McpPromptInfo[]>
  /** Snapshot of stderr (stdio) or HTTP body excerpt (remote). Empty if N/A. */
  capturedStderr(): string
  close(): Promise<void>
}

export interface OpenClientResult {
  client: ProbedMcpClient
  handshakeMs: number
}

export type OpenClientFn = (
  mcp: Mcp,
  signal: AbortSignal,
  handshakeTimeoutMs: number,
) => Promise<OpenClientResult>

export interface ProbeOptions {
  /** Override the client factory for testing. */
  openClient?: OpenClientFn
  /** Override the clock for testing. */
  now?: () => number
  /** Override the total hard timeout (ms). Defaults to 60_000. */
  totalTimeoutMs?: number
}

// Module-level dedup map. Key = mcp.name; value = the in-flight probe Promise.
// Tests reach into this via `__inflightSize()` for whitebox assertions.
const inflight = new Map<string, Promise<ProbeResult>>()

/** Test-only: returns how many probes are currently in flight. */
export function __inflightSize(): number {
  return inflight.size
}

/**
 * Probe one MCP server.
 *
 * Throws:
 *   - ValidationError('mcp-disabled') if mcp.enabled === false (before any I/O)
 *   - Never throws for transport / handshake / list errors — those are
 *     captured into the returned ProbeResult.
 */
export async function probeMcp(mcp: Mcp, opts: ProbeOptions = {}): Promise<ProbeResult> {
  if (!mcp.enabled) {
    // Pre-flight guard. Routes layer maps this to 422 and does not persist.
    throw new ValidationError(
      'mcp-disabled',
      `mcp '${mcp.name}' is disabled; enable it before probing`,
    )
  }

  const existing = inflight.get(mcp.name)
  if (existing !== undefined) {
    return existing
  }
  const p = runProbe(mcp, opts).finally(() => {
    inflight.delete(mcp.name)
  })
  inflight.set(mcp.name, p)
  return p
}

async function runProbe(mcp: Mcp, opts: ProbeOptions): Promise<ProbeResult> {
  const now = opts.now ?? Date.now
  const openClient = opts.openClient ?? defaultOpenClient
  const totalTimeoutMs = opts.totalTimeoutMs ?? HARD_TOTAL_TIMEOUT_MS
  const listTimeoutMs = mcp.config.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS

  const startedAt = now()
  const ac = new AbortController()
  const hardTimer = setTimeout(() => ac.abort(new Error('probe-total-timeout')), totalTimeoutMs)
  // Don't keep the process alive just for the abort timer.
  ;(hardTimer as unknown as { unref?: () => void }).unref?.()

  let client: ProbedMcpClient | null = null
  let handshakeMs: number | null = null

  try {
    const opened = await openClient(mcp, ac.signal, listTimeoutMs)
    client = opened.client
    handshakeMs = opened.handshakeMs

    const partialFailures: Array<{ method: string; message: string }> = []
    // Race allSettled against an abort promise so the orchestrator returns
    // promptly when the hard ceiling fires (otherwise a stuck list call could
    // pend forever, holding allSettled open even after abort).
    const allSettled = Promise.allSettled([
      client.listTools(ac.signal, listTimeoutMs),
      client.listResources(ac.signal, listTimeoutMs),
      client.listResourceTemplates(ac.signal, listTimeoutMs),
      client.listPrompts(ac.signal, listTimeoutMs),
    ])
    const abortP = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new Error('probe-total-timeout'))
      if (ac.signal.aborted) onAbort()
      else ac.signal.addEventListener('abort', onAbort, { once: true })
    })
    const [toolsR, resourcesR, templatesR, promptsR] = (await Promise.race([
      allSettled,
      abortP,
    ])) as [
      PromiseSettledResult<McpToolInfo[]>,
      PromiseSettledResult<McpResourceInfo[]>,
      PromiseSettledResult<McpResourceTemplateInfo[]>,
      PromiseSettledResult<McpPromptInfo[]>,
    ]

    const tools = unwrapList(toolsR, 'tools/list', partialFailures)
    const resources = unwrapList(resourcesR, 'resources/list', partialFailures)
    const resourceTemplates = unwrapList(templatesR, 'resources/templates/list', partialFailures)
    const prompts = unwrapList(promptsR, 'prompts/list', partialFailures)

    const finishedAt = now()
    const latencyMs = Math.max(0, finishedAt - startedAt)

    if (partialFailures.length > 0) {
      return {
        status: 'ok',
        latencyMs,
        handshakeMs,
        serverInfo: client.serverInfo,
        protocolVersion: client.protocolVersion,
        capabilities: client.capabilities,
        tools,
        resources,
        resourceTemplates,
        prompts,
        errorCode: 'partial',
        errorMessage: `partial inventory: ${partialFailures.map((f) => f.method).join(', ')}`,
        errorDetail: { partialFailures },
        startedAt,
        finishedAt,
      }
    }

    return {
      status: 'ok',
      latencyMs,
      handshakeMs,
      serverInfo: client.serverInfo,
      protocolVersion: client.protocolVersion,
      capabilities: client.capabilities,
      tools,
      resources,
      resourceTemplates,
      prompts,
      errorCode: null,
      errorMessage: null,
      errorDetail: null,
      startedAt,
      finishedAt,
    }
  } catch (err) {
    const finishedAt = now()
    const latencyMs = Math.max(0, finishedAt - startedAt)
    const code = classifyProbeError(err, ac.signal.aborted)
    const message = err instanceof Error ? err.message : String(err)
    const stderr = client?.capturedStderr() ?? ''
    const detail: Record<string, unknown> = {}
    if (stderr.trim().length > 0) {
      detail.stderr = redactSensitiveString(tail(stderr, STDERR_CAPTURE_BYTES))
    }
    const httpStatus = extractHttpStatus(err)
    if (httpStatus !== null) detail.httpStatus = httpStatus
    log.warn('probe failed', {
      mcp: mcp.name,
      code,
      message: redactSensitiveString(message),
    })
    return {
      status: 'error',
      latencyMs,
      handshakeMs,
      serverInfo: client?.serverInfo ?? null,
      protocolVersion: client?.protocolVersion ?? null,
      capabilities: client?.capabilities ?? null,
      tools: null,
      resources: null,
      resourceTemplates: null,
      prompts: null,
      errorCode: code,
      errorMessage: redactSensitiveString(message),
      errorDetail: Object.keys(detail).length > 0 ? detail : null,
      startedAt,
      finishedAt,
    }
  } finally {
    clearTimeout(hardTimer)
    if (client !== null) {
      try {
        await client.close()
      } catch (closeErr) {
        log.debug('probe transport close error (ignored)', {
          mcp: mcp.name,
          message: closeErr instanceof Error ? closeErr.message : String(closeErr),
        })
      }
    }
  }
}

function unwrapList<T>(
  r: PromiseSettledResult<T[]>,
  method: string,
  partials: Array<{ method: string; message: string }>,
): T[] | null {
  if (r.status === 'fulfilled') return r.value
  const message = r.reason instanceof Error ? r.reason.message : String(r.reason)
  partials.push({ method, message: redactSensitiveString(message) })
  return null
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(s.length - max)
}

/**
 * Map a thrown error from openClient / list calls to a normalized error code.
 * Order matters — auth checks run before timeout / connect because
 * UnauthorizedError can also surface during transport.connect.
 */
export function classifyProbeError(err: unknown, abortedByTimeout: boolean): McpProbeErrorCodeT {
  if (abortedByTimeout) return 'timeout'

  if (err !== null && typeof err === 'object') {
    const e = err as { name?: string; code?: string; message?: string; status?: number }
    const name = String(e.name ?? '')
    const message = String(e.message ?? '')

    // SDK's UnauthorizedError — matched by constructor name to avoid hard
    // dependency on a specific export path at this layer.
    if (name === 'UnauthorizedError' || name.includes('Unauthorized')) return 'auth-required'

    // HTTP 401/403 from streamable / SSE transports surface either with
    // .status on the error or with "401"/"403" embedded in the message.
    if (e.status === 401 || e.status === 403) return 'auth-required'
    if (/\b40[13]\b/.test(message) && /unauth|forbidden|auth/i.test(message)) {
      return 'auth-required'
    }

    // Initialize errors surface as Error with "protocol", "initialize", "server's"
    // ("Server's protocol version is not supported") wording from the SDK.
    if (/initialize|protocol version|sent invalid initialize/i.test(message)) {
      return 'handshake-failed'
    }

    // Connect-side failures: spawn ENOENT / EACCES, fetch network errors.
    if (
      e.code === 'ENOENT' ||
      e.code === 'EACCES' ||
      /ENOENT|EACCES|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/.test(message)
    ) {
      return 'connect-failed'
    }

    // Generic AbortError that wasn't our hard-timeout (e.g. transport-internal abort).
    if (name === 'AbortError') return 'timeout'
  }

  return 'internal-error'
}

function extractHttpStatus(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null
  const s = (err as { status?: unknown }).status
  if (typeof s === 'number' && Number.isInteger(s) && s >= 100 && s < 600) return s
  const msg = (err as { message?: unknown }).message
  if (typeof msg === 'string') {
    const m = msg.match(/\b(\d{3})\b/)
    if (m !== null) {
      const v = Number(m[1])
      if (v >= 100 && v < 600) return v
    }
  }
  return null
}

// -----------------------------------------------------------------------------
// Default real-SDK client factory. Production path. Unit tests inject a fake;
// integration tests (T7) exercise this with a real fixture server.
// -----------------------------------------------------------------------------

/**
 * Minimal environment passed to stdio MCP children — never inherit daemon creds.
 *
 * RFC-windows PR-4 T19: Windows stdio children (npx / uvx `.cmd` shims, node
 * scripts) need more than PATH/HOME/LANG — Windows has no HOME (it's
 * USERPROFILE), and the PATHEXT / SystemRoot / ComSpec keys are required for
 * `.cmd` shim resolution + sub-process spawning. The POSIX-only set would
 * leave a Windows MCP child unable to find its own shim or resolve HOME. The
 * extra keys are absent from a POSIX `process.env` so they're no-ops there
 * (byte-for-byte unchanged); on Windows they're inherited.
 */
const MINIMAL_INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  // Windows-specific (no-op on POSIX — absent from process.env there):
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
  'TMP',
  'TEMP',
]

/** Build the env map for a stdio child: minimal inherited + mcp.config.env. */
export function buildStdioEnv(
  configEnv: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of MINIMAL_INHERITED_ENV_KEYS) {
    const v = source[k]
    if (typeof v === 'string') out[k] = v
  }
  // RFC-windows PR-4 T19: Windows has no HOME env var (it's USERPROFILE). MCP
  // servers / node tools that read HOME (e.g. for ~/.config) would break
  // without it; inject HOME=USERPROFILE when HOME is absent. No-op on POSIX
  // (HOME is always in the inherited set there) and when the daemon's own env
  // already sets HOME (explicit configEnv HOME still wins below).
  if (isWindows() && out.HOME === undefined) {
    const up = source.USERPROFILE
    if (typeof up === 'string' && up.length > 0) out.HOME = up
  }
  if (configEnv !== undefined) {
    for (const [k, v] of Object.entries(configEnv)) {
      out[k] = v
    }
  }
  return out
}

export const defaultOpenClient: OpenClientFn = async (mcp, signal, handshakeTimeoutMs) => {
  const startedAt = Date.now()

  // Lazy import keeps SDK out of the cold-start path of routes that don't probe.
  const [{ Client }, stdioMod, httpMod, sseMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ])

  const PKG_NAME = 'agent-workflow-probe'
  const PKG_VERSION = '0.0.0'
  const client = new Client({ name: PKG_NAME, version: PKG_VERSION })

  // Build the transport(s) — for remote, try Streamable HTTP first then fall
  // back to SSE (mirrors opencode mcp/index.ts:332/795 ordering).
  type AnyTransport =
    | InstanceType<(typeof stdioMod)['StdioClientTransport']>
    | InstanceType<(typeof httpMod)['StreamableHTTPClientTransport']>
    | InstanceType<(typeof sseMod)['SSEClientTransport']>

  let stderrBuf = ''
  function pushStderr(s: string): void {
    stderrBuf = stderrBuf + s
    if (stderrBuf.length > STDERR_CAPTURE_BYTES * 4) {
      stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAPTURE_BYTES * 2)
    }
  }

  let activeTransport: AnyTransport | null = null
  const wireAbort = (): void => {
    if (activeTransport !== null) {
      // Best-effort: ignore close errors here, finally in runProbe re-tries.
      activeTransport.close().catch(() => {})
    }
  }
  signal.addEventListener('abort', wireAbort, { once: true })

  async function connectWithTimeout(transport: AnyTransport): Promise<void> {
    activeTransport = transport
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`initialize timed out after ${handshakeTimeoutMs}ms`)),
        handshakeTimeoutMs,
      )
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      await Promise.race([client.connect(transport), timeoutP])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  try {
    if (mcp.type === 'local') {
      const [cmd, ...args] = mcp.config.command
      if (cmd === undefined) throw new Error('mcp.config.command is empty')
      const env = buildStdioEnv(mcp.config.env)
      const transport = new stdioMod.StdioClientTransport({
        command: cmd,
        args,
        cwd: process.cwd(),
        env,
        stderr: 'pipe',
      })
      // The SDK attaches a Readable on transport.stderr once spawned.
      transport.stderr?.on('data', (chunk: Buffer) => {
        pushStderr(chunk.toString())
      })
      await connectWithTimeout(transport)
    } else {
      // Remote: streamable-http first, SSE fallback on 4xx/5xx (transport-level).
      const url = new URL(mcp.config.url)
      const headers = mcp.config.headers
      let connected = false
      let lastErr: unknown = null
      for (const TransportCtor of [
        httpMod.StreamableHTTPClientTransport,
        sseMod.SSEClientTransport,
      ] as const) {
        try {
          const transport = new TransportCtor(url, {
            requestInit: headers !== undefined ? { headers } : undefined,
          })
          await connectWithTimeout(transport)
          connected = true
          break
        } catch (err) {
          lastErr = err
          // If the failure is auth, don't fall back to SSE — same outcome.
          if (
            err instanceof Error &&
            (err.name === 'UnauthorizedError' || err.name.includes('Unauthorized'))
          ) {
            throw err
          }
          // continue to fallback
        }
      }
      if (!connected) {
        throw lastErr ?? new Error('all transports failed')
      }
    }

    const handshakeMs = Date.now() - startedAt
    const serverVersion = client.getServerVersion()
    const capabilities = client.getServerCapabilities()
    const protoCandidate =
      activeTransport !== null && 'protocolVersion' in activeTransport
        ? (activeTransport as { protocolVersion?: string }).protocolVersion
        : undefined

    const probed: ProbedMcpClient = {
      serverInfo:
        serverVersion !== undefined
          ? { name: serverVersion.name, version: serverVersion.version }
          : null,
      protocolVersion: protoCandidate ?? null,
      capabilities: capabilities !== undefined ? (capabilities as Record<string, unknown>) : null,
      async listTools(_sig, timeoutMs) {
        const r = await client.listTools(undefined, { timeout: timeoutMs })
        return r.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
      },
      async listResources(_sig, timeoutMs) {
        const r = await client.listResources(undefined, { timeout: timeoutMs })
        return r.resources.map((x) => ({
          uri: x.uri,
          name: x.name,
          description: x.description,
          mimeType: x.mimeType,
        }))
      },
      async listResourceTemplates(_sig, timeoutMs) {
        const r = await client.listResourceTemplates(undefined, { timeout: timeoutMs })
        return r.resourceTemplates.map((x) => ({
          uriTemplate: x.uriTemplate,
          name: x.name,
          description: x.description,
          mimeType: x.mimeType,
        }))
      },
      async listPrompts(_sig, timeoutMs) {
        const r = await client.listPrompts(undefined, { timeout: timeoutMs })
        return r.prompts.map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments?.map((a) => ({
            name: a.name,
            description: a.description,
            required: a.required,
          })),
        }))
      },
      capturedStderr() {
        return stderrBuf
      },
      async close() {
        signal.removeEventListener('abort', wireAbort)
        try {
          await client.close()
        } catch {
          // ignore — best-effort
        }
        try {
          if (activeTransport !== null) {
            await (activeTransport as { close: () => Promise<void> }).close()
          }
        } catch {
          // ignore
        }
      },
    }
    return { client: probed, handshakeMs }
  } catch (err) {
    // Make sure we don't leak a partially-opened transport.
    signal.removeEventListener('abort', wireAbort)
    try {
      if (activeTransport !== null) {
        await (activeTransport as { close: () => Promise<void> }).close()
      }
    } catch {
      // ignore
    }
    throw err
  }
}
