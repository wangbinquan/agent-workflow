// RFC-294 review 2026-08-30 —— 从 committed architecture/*.json 渲染 status.md。
//
// `bun run architecture:status` 只重渲染投影，不扫描源码；`architecture:write` 会在
// 重新生成 canonical manifests 之后自动调用同一渲染器。`--check` 只比对不写入。

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ARCHITECTURE_STATUS_PATH,
  readArchitectureStatusInputs,
  renderArchitectureStatus,
} from '../packages/backend/tests/architecture/rfc294Status'

const REPO_ROOT = resolve(import.meta.dir, '..')
const check = process.argv.includes('--check')
const target = resolve(REPO_ROOT, ARCHITECTURE_STATUS_PATH)
const rendered = renderArchitectureStatus(readArchitectureStatusInputs(REPO_ROOT))

if (check) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    current = ''
  }
  if (current !== rendered) {
    process.stderr.write(
      `${ARCHITECTURE_STATUS_PATH} 与 committed 账本不一致：运行 bun run architecture:status\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${ARCHITECTURE_STATUS_PATH} 与 committed 账本一致\n`)
  process.exit(0)
}

writeFileSync(target, rendered)
process.stdout.write(`${ARCHITECTURE_STATUS_PATH} written\n`)
