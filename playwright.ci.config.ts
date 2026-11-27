// RFC-611 / RFC-627: native discovery has already selected the tier/project.
// Only the complete-file assignment (and optional per-platform worker cap via
// AW_E2E_WORKERS) changes; hooks, retries, timeouts and file-local order stay.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import {
  exactE2EMatch,
  parseConfiguredE2EWorkers,
  parseE2EShardPlan,
} from './scripts/ci/e2e-shards'

const planPath = process.env.AW_E2E_SHARD_PLAN
if (!planPath) throw new Error('AW_E2E_SHARD_PLAN must name a native-discovery shard plan')
const plan = parseE2EShardPlan(JSON.parse(readFileSync(planPath, 'utf8')))
// The repository's Playwright loader transpiles configs to CommonJS. Avoid
// import.meta here, which makes Node infer ESM after that transformation.
const repoRoot = __dirname
if (plan.sourceSha && process.env.GITHUB_SHA && plan.sourceSha !== process.env.GITHUB_SHA)
  throw new Error('E2E plan was generated for a different source SHA')
const existingReporters = base.reporter
if (!Array.isArray(existingReporters)) throw new Error('Expected the base Playwright reporter list')
const workersOverride = parseConfiguredE2EWorkers(process.env.AW_E2E_WORKERS)

export default defineConfig(base, {
  ...(workersOverride !== undefined ? { workers: workersOverride } : {}),
  testMatch: plan.assignments[plan.shard.current - 1]!.map((file) =>
    exactE2EMatch(resolve(repoRoot, file)),
  ),
  reporter: [...existingReporters, ['./scripts/ci/e2e-timings-reporter.ts', { planPath }]],
})
