import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Called under the operation lock after publishing its new current plan.
 * References include the current/pending plan and every retained approval.
 * Old plans without a path are matched by their content manifest digest.
 * Best effort: the plan is already saved, so an unreadable manifest is kept
 * and a failed delete is left for the next plan instead of failing this one.
 */
export function pruneEpochPlanContent(
  root: string,
  references: readonly { path?: string; digest: string }[],
): void {
  const paths = new Set(references.flatMap((reference) => (reference.path ? [reference.path] : [])))
  const digests = new Set(
    references.filter((reference) => !reference.path).map((reference) => reference.digest),
  )
  const runs = join(root, 'runs')
  if (!existsSync(runs)) return
  for (const run of readdirSync(runs, { withFileTypes: true })) {
    if (!run.isDirectory()) continue
    const directory = join(runs, run.name, 'plan-content')
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(directory, entry.name)
      if (paths.has(relative(root, file).replaceAll('\\', '/'))) continue
      if (digests.size) {
        let digest: unknown
        try {
          digest = (JSON.parse(readFileSync(file, 'utf8')) as { digest?: unknown }).digest
        } catch {
          continue
        }
        if (typeof digest === 'string' && digests.has(digest)) continue
      }
      try {
        unlinkSync(file)
      } catch {
        // Left for the next plan's cleanup.
      }
    }
  }
}
