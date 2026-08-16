#!/usr/bin/env bun

import { startSystemMockSuite } from './suite'

const suite = await startSystemMockSuite()
process.stdout.write(`${JSON.stringify({ endpoints: suite.endpoints, env: suite.env }, null, 2)}\n`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await suite.close()
  process.exit(0)
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
await new Promise<void>(() => {})
