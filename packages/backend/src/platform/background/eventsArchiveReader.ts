import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ArchivedNodeRunEvent {
  readonly id: number
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

function appendLine(line: string, since: number, limit: number, out: ArchivedNodeRunEvent[]): void {
  if (line === '' || out.length >= limit) return
  try {
    const value: unknown = JSON.parse(line)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const id = Reflect.get(value, 'id')
    const ts = Reflect.get(value, 'ts')
    const kind = Reflect.get(value, 'kind')
    const payload = Reflect.get(value, 'payload')
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= since ||
      typeof ts !== 'number' ||
      typeof kind !== 'string' ||
      typeof payload !== 'string'
    ) {
      return
    }
    const sessionId = Reflect.get(value, 'sessionId')
    const parentSessionId = Reflect.get(value, 'parentSessionId')
    out.push({
      id,
      ts,
      kind,
      payload,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
    })
  } catch {
    // One corrupt archive line must not hide later valid events.
  }
}

/** Provider-neutral filesystem projection for the append-only event archive. */
export async function readArchivedEvents(
  logsDir: string,
  taskId: string,
  nodeRunId: string,
  since: number,
  limit: number,
): Promise<readonly ArchivedNodeRunEvent[]> {
  const file = join(logsDir, taskId, `${nodeRunId}.jsonl`)
  if (!existsSync(file)) return []
  const out: ArchivedNodeRunEvent[] = []
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of Bun.file(file).stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      appendLine(line, since, limit, out)
      if (out.length >= limit) return out
      newline = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending !== '' && out.length < limit) appendLine(pending, since, limit, out)
  return out
}
