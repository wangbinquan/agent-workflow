// RFC-626 §3.5: what the environment check of an automatic upgrade reads from the machine.
// Everything here only reads. The check runs before the session records its intent, and a
// refusal must leave no session record, no operation directory and no allocation file behind.
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { inventoryHomePath } from '@/platform/content/inventory/resolvers'
import { errorText } from '@/platform/persistence/migration/errorText'
import { availableDiskBytes } from '@/platform/persistence/migration/freeze/diskBudget'
import type { ContentRootSpec } from '@/platform/persistence/migration/run/types'
import type { AutoUpgradeEnvironmentPort } from '../../application/ports/epochSwitch'
import type { HomeConfigObservation } from '../../domain/epochSwitch/environmentPrecheck'

/**
 * The bytes of the home `config.json`, its absence, or why it could not be read — the three
 * outcomes the runtime-configuration rule distinguishes when it reads the same file for the
 * conversion (see `checkHomeConfig`).
 */
export function readHomeConfigFile(path: string): HomeConfigObservation {
  try {
    return { bytes: readFileSync(path) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null }
    return { error: errorText(error) }
  }
}

/** The directories the content inventory lists (`captureContentManifest`). */
const CONTENT_DIRECTORIES = ['skills', 'runs', 'logs', 'evidence'] as const
/** First-level entries walked per directory, evenly spaced over the sorted names. */
const SAMPLED_ENTRIES = 16
/** Directory entries read at most for one sampled entry. */
const WALK_BUDGET = 20_000

function entriesOf(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    // Absent or unreadable: the inventory itself reports that, with the path.
    return []
  }
}

/** Files below `directory`, reading at most `budget` directory entries. */
function countFiles(directory: string, budget: number): number {
  let files = 0
  let left = budget
  const pending = [directory]
  while (pending.length && left > 0) {
    const current = pending.pop()!
    for (const entry of entriesOf(current)) {
      if (left-- <= 0) break
      if (entry.isDirectory()) pending.push(join(current, entry.name))
      else if (entry.isFile()) files += 1
    }
  }
  return files
}

/**
 * How many files the content inventory will list, without walking them all: for each content
 * directory the files directly in it, plus the average of a few sampled sub-directories
 * multiplied by their number. One task writes one directory under `runs/`, so the first level
 * is as long as the task list while the whole tree can hold hundreds of thousands of files;
 * walking it took 36 s on the reference installation, and the check this serves has to answer
 * in seconds. The number only sizes the inventory's manifest in the disk estimate, where the
 * 10% margin covers what a sample misses.
 */
export function estimateContentFiles(root: ContentRootSpec): number {
  let total = 0
  for (const name of CONTENT_DIRECTORIES) {
    const directory = inventoryHomePath(root, name)
    const entries = entriesOf(directory)
    total += entries.filter((entry) => entry.isFile()).length
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    if (!directories.length) continue
    const step = Math.max(1, Math.floor(directories.length / SAMPLED_ENTRIES))
    let sampled = 0
    let sampledFiles = 0
    for (let index = 0; index < directories.length && sampled < SAMPLED_ENTRIES; index += step) {
      sampledFiles += countFiles(join(directory, directories[index]!), WALK_BUDGET)
      sampled += 1
    }
    total += Math.ceil((sampledFiles / sampled) * directories.length)
  }
  return total
}

export function createAutoUpgradeEnvironment(): AutoUpgradeEnvironmentPort {
  return {
    async availableBytes(operationRoot) {
      try {
        // Measures the nearest existing parent; the operation directory is not created.
        return availableDiskBytes(operationRoot)
      } catch {
        return null
      }
    },
    async contentFiles(root) {
      return estimateContentFiles(root)
    },
    // `artifactHardLinks` is not probed: publishing a write-once file of the journal is itself
    // a hard link (`writeEpochFile`), so an operation directory that cannot link cannot hold
    // an operation at all, and finding out would mean writing a file during a read-only check.
  }
}
