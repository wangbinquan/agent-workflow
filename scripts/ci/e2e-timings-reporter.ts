import { readFileSync, writeFileSync } from 'node:fs'
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import {
  assertE2ERuntimeSelection,
  parseE2EShardPlan,
  selectedE2ETests,
  type DiscoveredE2ETest,
  type E2EShardPlan,
} from './e2e-shards'

/** Controller-side windows include beforeAll/afterAll, unlike summed test durations. */
export class E2ETimingCollector {
  private readonly expected = new Map<string, DiscoveredE2ETest>()
  private readonly ended = new Set<string>()
  private readonly results = new Map<string, { status: string; retry: number }[]>()
  private readonly windows = new Map<
    string,
    { start: number; end: number; clean: boolean; attempts: number }
  >()

  constructor(tests: DiscoveredE2ETest[]) {
    for (const test of tests) this.expected.set(test.id, test)
  }
  begin(id: string, now: number): void {
    const test = this.expected.get(id)
    if (!test) throw new Error(`Unexpected measured test: ${id}`)
    const window = this.windows.get(test.file)
    if (window) window.start = Math.min(window.start, now)
    else this.windows.set(test.file, { start: now, end: now, clean: true, attempts: 0 })
  }
  end(id: string, status: string, retry: number, now: number): void {
    const test = this.expected.get(id)
    if (!test) throw new Error(`Unexpected measured test: ${id}`)
    const window = this.windows.get(test.file)
    if (!window) throw new Error(`Missing test-begin event: ${id}`)
    window.end = Math.max(window.end, now)
    window.attempts++
    window.clean &&= retry === 0 && (status === test.expectedStatus || status === 'skipped')
    this.ended.add(id)
    const results = this.results.get(id) ?? []
    results.push({ status, retry })
    this.results.set(id, results)
  }
  snapshot(): {
    complete: boolean
    tests: (DiscoveredE2ETest & { results: { status: string; retry: number }[] })[]
    files: Record<
      string,
      { durationMs: number; complete: boolean; clean: boolean; attempts: number; runnable: boolean }
    >
  } {
    const files = Object.fromEntries(
      [...new Set([...this.expected.values()].map((test) => test.file))].sort().map((file) => {
        const tests = [...this.expected.values()].filter((test) => test.file === file)
        const window = this.windows.get(file)
        return [
          file,
          {
            durationMs: window ? Math.max(1, Math.ceil(window.end - window.start)) : 0,
            complete: tests.every((test) => this.ended.has(test.id)),
            clean: window?.clean ?? false,
            attempts: window?.attempts ?? 0,
            runnable: tests.some((test) => test.expectedStatus !== 'skipped'),
          },
        ]
      }),
    )
    return {
      complete: this.ended.size === this.expected.size,
      tests: [...this.expected.values()].map((test) => ({
        ...test,
        results: this.results.get(test.id) ?? [],
      })),
      files,
    }
  }
}

export default class E2ETimingsReporter implements Reporter {
  private readonly plan: E2EShardPlan
  private readonly collector: E2ETimingCollector
  private selectionError: string | undefined

  constructor(options: { planPath: string }) {
    this.plan = parseE2EShardPlan(JSON.parse(readFileSync(options.planPath, 'utf8')))
    this.collector = new E2ETimingCollector(selectedE2ETests(this.plan))
  }
  onBegin(config: FullConfig, suite: Suite): void {
    try {
      assertE2ERuntimeSelection(
        this.plan,
        suite.allTests().map((test) => test.id),
        config,
      )
    } catch (error) {
      // Playwright catches reporter callback exceptions. Explicitly return a
      // failed result in onEnd so a missing/duplicate selection cannot go green.
      this.selectionError = error instanceof Error ? error.message : String(error)
      console.error(`E2E shard selection: ${this.selectionError}`)
    }
  }
  onTestBegin(test: TestCase): void {
    if (!this.selectionError) this.collector.begin(test.id, performance.now())
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.selectionError)
      this.collector.end(test.id, result.status, result.retry, performance.now())
  }
  async onEnd(result: FullResult): Promise<{ status: 'failed' } | void> {
    const output = process.env.AW_E2E_TIMINGS_OUTPUT
    if (output && !this.selectionError) {
      const snapshot = this.collector.snapshot()
      try {
        writeFileSync(
          output,
          `${JSON.stringify(
            {
              version: 1,
              measurement: 'first-test-begin-to-last-test-end-per-spec',
              limitations:
                'Includes spec hooks and retry gaps; excludes module discovery, worker startup and shared global setup/teardown. Concurrent worker load remains part of observed wall-clock.',
              sourceSha: this.plan.sourceSha,
              runId: process.env.GITHUB_RUN_ID ?? null,
              runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
              platform: this.plan.platform,
              shard: this.plan.shard,
              discoveryDigest: this.plan.discoveryDigest,
              status: result.status,
              complete: result.status === 'passed' && snapshot.complete,
              tests: snapshot.tests,
              files: snapshot.files,
            },
            null,
            2,
          )}\n`,
        )
      } catch (error) {
        // Auxiliary timing evidence must never change a successful test result.
        console.warn(`Could not write optional E2E timing evidence: ${String(error)}`)
      }
    }
    if (this.selectionError) return { status: 'failed' }
  }
  printsToStdio(): boolean {
    return false
  }
}
