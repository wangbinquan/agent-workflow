import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** RFC-398 §7.6: deterministic fault/barrier hooks are enabled ONLY by this test-only env var.
 * A release marker is durable across SIGKILL/restart. No test configuration means no I/O.
 */
export async function autoUpgradeTestCheckpoint(point: string): Promise<void> {
  const root = process.env.AGENT_WORKFLOW_TEST_EPOCH_UPGRADE
  if (!root) return
  mkdirSync(root, { recursive: true })
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ point, pid: process.pid, parent: process.ppid }) + '\n',
  )
  const settings = join(root, 'barriers.json')
  const barriers = existsSync(settings)
    ? (JSON.parse(readFileSync(settings, 'utf8')) as string[])
    : []
  if (!barriers.includes(point) && !barriers.includes(`${point}@${process.pid}`)) return
  writeFileSync(join(root, `${point}.${process.pid}.reached`), String(process.ppid))
  while (!existsSync(join(root, `${point}.release`))) await Bun.sleep(25)
}
export function autoUpgradeTestFailure(name: string): boolean {
  const root = process.env.AGENT_WORKFLOW_TEST_EPOCH_UPGRADE
  return !!root && existsSync(join(root, name))
}
