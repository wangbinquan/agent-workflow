import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import type { MockFaultRule } from '../types'

export const MOCK_BODY_LIMIT_BYTES = 4 * 1024 * 1024

export async function readRequestBody(
  request: IncomingMessage,
  maxBytes = MOCK_BODY_LIMIT_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) throw new Error(`mock request body exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

export function headerRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  const sensitive = new Set([
    'authorization',
    'proxy-authorization',
    'private-token',
    'x-gitlab-token',
    'cookie',
    'set-cookie',
  ])
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const normalizedName = name.toLowerCase()
    out[normalizedName] = sensitive.has(normalizedName)
      ? '[redacted]'
      : Array.isArray(value)
        ? value.join(', ')
        : value
  }
  return out
}

export function queryRecord(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries())
}

export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
  response.end(body)
}

export function writeText(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType = 'text/plain; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
  response.end(body)
}

export function parseJsonBody<T>(body: Buffer): T {
  return JSON.parse(body.toString('utf8')) as T
}

export async function applyFault(
  response: ServerResponse,
  socket: Socket,
  fault: MockFaultRule | null,
): Promise<boolean> {
  if (fault === null) return false
  if ((fault.delayMs ?? 0) > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, fault.delayMs))
  }
  if (fault.disconnect === true) {
    socket.destroy()
    return true
  }
  const status = fault.status ?? 503
  const body = fault.body ?? `system mock fault: ${status}`
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    ...(fault.stallBody === true ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    ...fault.headers,
  }
  response.writeHead(status, headers)
  if (fault.stallBody === true) {
    response.write(body)
  } else {
    response.end(body)
  }
  return true
}

export function safeCloseServerResponse(response: ServerResponse): void {
  if (!response.writableEnded) response.end()
}
