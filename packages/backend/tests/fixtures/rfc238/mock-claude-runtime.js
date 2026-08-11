#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const mcpConfigPath = flag('--mcp-config')
const newSessionId = flag('--session-id')
const resumedSessionId = flag('--resume')
if (
  mcpConfigPath === undefined ||
  (newSessionId === undefined) === (resumedSessionId === undefined)
) {
  throw new Error('mock-claude-invalid-session-arguments')
}
const sessionId = newSessionId ?? resumedSessionId
const prompt = await readStdin()
const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
const entries = Object.entries(config.mcpServers ?? {})
if (entries.length !== 1) throw new Error('mock-claude-expected-exactly-one-mcp')
const [runtimeKey, server] = entries[0]
if (server.type !== 'http' || typeof server.url !== 'string') {
  throw new Error('mock-claude-expected-remote-mcp')
}

const configRoot = process.env.CLAUDE_CONFIG_DIR
if (configRoot === undefined || configRoot === '') {
  throw new Error('mock-claude-config-dir-missing')
}
mkdirSync(configRoot, { recursive: true })
const statePath = join(configRoot, `mock-session-${sessionId}.json`)
let history = []
try {
  history = JSON.parse(readFileSync(statePath, 'utf8'))
} catch {
  if (resumedSessionId !== undefined) throw new Error('mock-claude-resume-state-missing')
}

let rpcId = 0
async function rpc(method, params) {
  rpcId += 1
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(server.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method,
      params,
    }),
  })
  if (!response.ok) throw new Error(`mock-mcp-http-${response.status}`)
  const body = await response.json()
  if (body.error !== undefined) throw new Error(`mock-mcp-rpc-${method}`)
  return body.result
}

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'rfc238-mock-claude', version: '1' },
})
const listed = await rpc('tools/list', {})
if (
  !Array.isArray(listed.tools) ||
  listed.tools.length !== 1 ||
  listed.tools[0]?.name !== 'stateful_increment'
) {
  throw new Error('mock-claude-unexpected-tool-surface')
}
const called = await rpc('tools/call', {
  name: 'stateful_increment',
  arguments: {
    prompt,
    previousTurnCount: history.length,
  },
})
const toolText = called.content?.[0]?.text
if (typeof toolText !== 'string') throw new Error('mock-claude-tool-result-missing')
const toolValue = JSON.parse(toolText)
history.push({ prompt, counter: toolValue.counter })
writeFileSync(statePath, JSON.stringify(history), { mode: 0o600 })

const toolUseId = `tool-${history.length}`
const messageId = `assistant-${history.length}`
const events = [
  {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    // RFC-280 T6: the playground now VERIFIES the startup report (fail-closed
    // on "cannot observe"), so the mock must report its mounted MCP connected
    // exactly like a real claude init does.
    // Third-round P2-1: AW_MOCK_MCP_STATUS lets a test report the mounted MCP as
    // NOT connected, exercising the real verification → settleTurn →
    // mcp-test-mcp-unusable integration path (previously only the pure verdict
    // function was covered).
    tools: [`mcp__${runtimeKey}__stateful_increment`],
    mcp_servers: [{ name: runtimeKey, status: process.env.AW_MOCK_MCP_STATUS ?? 'connected' }],
  },
  {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: messageId,
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: `mcp__${runtimeKey}__stateful_increment`,
          input: { prompt, previousTurnCount: history.length - 1 },
        },
      ],
    },
  },
  {
    type: 'user',
    session_id: sessionId,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: toolText,
        },
      ],
    },
  },
  {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: messageId,
      content: [
        {
          type: 'text',
          text: `counter=${toolValue.counter}; prior_turns=${history.length - 1}`,
        },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: sessionId,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
]
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
