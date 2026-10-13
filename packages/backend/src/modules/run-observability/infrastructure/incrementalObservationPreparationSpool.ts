import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { IncrementalObservationWork } from '../ports/incrementalObservationProjection'
import type {
  QualifiedObservationContribution,
  QualifiedObservationPrepared,
} from '../ports/incrementalObservationQualified'

/** Only qualified numeric/display facts leave the original snapshot. Persistent
 * staging starts after its reservation has been released, including poolMax=1. */
export function incrementalObservationPreparationSpool(signal: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-observation-qualification-'))
  const path = join(directory, 'qualified.ndjson')
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  const hash = createHash('sha256')
  let count = 0n,
    closed = false,
    sealed: { rows: string; digest: string } | null = null
  return {
    append(_work: IncrementalObservationWork, rows: readonly QualifiedObservationContribution[]) {
      if (closed || sealed) throw new Error('Qualified spool is closed')
      for (const row of rows) {
        signal.throwIfAborted()
        const line = JSON.stringify(row) + '\n'
        const bytes = Buffer.from(line)
        let offset = 0
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
        hash.update(line)
        count++
      }
    },
    seal(
      work: IncrementalObservationWork,
      identity: Omit<QualifiedObservationPrepared, 'rows' | 'digest' | 'preparationToken'>,
      components: readonly string[],
    ) {
      if (closed || sealed) throw new Error('Qualified spool is closed')
      closeSync(fd)
      closed = true
      sealed = { rows: String(count), digest: hash.digest('hex') }
      return { work, identity, components }
    },
    async *rows() {
      if (!sealed) throw new Error('Qualified spool EOF is missing')
      const digest = createHash('sha256')
      let observed = 0n
      const stream = createReadStream(path, { encoding: 'utf8', signal })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          signal.throwIfAborted()
          digest.update(line + '\n')
          observed++
          yield JSON.parse(line) as QualifiedObservationContribution
        }
        if (String(observed) !== sealed.rows || digest.digest('hex') !== sealed.digest)
          throw new Error('Qualified spool count or digest changed')
      } finally {
        lines.close()
        stream.destroy()
      }
    },
    close() {
      if (!closed) closeSync(fd)
      closed = true
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
