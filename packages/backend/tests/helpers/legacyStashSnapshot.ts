// RFC-395 II-a A2: seed historical stash objects for surviving resume/review/GC behavior.
import { runGit } from '@/util/git'
import type { Logger } from '@/util/log'

export async function legacyStashSnapshotFixture(
  path: string,
  options?: { pinRef?: string; log?: Logger },
): Promise<string> {
  const snapshot = await runGit(path, ['stash', 'create'])
  if (snapshot.exitCode !== 0) throw new Error(snapshot.stderr)
  const sha = snapshot.stdout.trim()
  if (sha !== '' && options?.pinRef !== undefined) {
    const pin = await runGit(path, ['update-ref', options.pinRef, sha])
    if (pin.exitCode !== 0) throw new Error(pin.stderr)
  }
  return sha
}
