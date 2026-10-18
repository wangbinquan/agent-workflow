// RFC-376 T7: read a committed snapshot and emit an on-demand report, never a projection.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  buildArchitectureReport,
  readReportSource,
  renderGateBaselines,
  renderReportStatus,
  stableJson,
} from '../packages/backend/tests/architecture/architectureReport'

export interface ReportOptions {
  readonly sourceRef: string
  readonly out: string
  readonly status?: string
  readonly gates: boolean
}
export function parseReportOptions(args: readonly string[]): ReportOptions {
  let sourceRef = 'HEAD',
    out = '.architecture-report/',
    status: string | undefined,
    gates = false
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`)
    seen.add(flag)
    if (flag === '--gates') {
      gates = true
      continue
    }
    if (!['--source-ref', '--out', '--status'].includes(flag))
      throw new Error(`unknown option: ${flag}`)
    const value = args[++index]
    if (value === undefined || value.startsWith('--') || value.trim() === '')
      throw new Error(`missing value for ${flag}`)
    if (flag === '--source-ref') sourceRef = value
    else if (flag === '--out') out = value
    else status = value
  }
  return { sourceRef, out, ...(status === undefined ? {} : { status }), gates }
}
export function reportOutputPaths(
  repoRoot: string,
  options: ReportOptions,
): { report: string; status: string } {
  const out = resolve(repoRoot, options.out)
  const paths = {
    report: resolve(out, 'report.json'),
    status:
      options.status === undefined ? resolve(out, 'status.md') : resolve(repoRoot, options.status),
  }
  for (const path of Object.values(paths)) {
    const rel = relative(repoRoot, path).replaceAll('\\', '/')
    if (
      !isAbsolute(rel) &&
      (/^architecture(?:\/|$)/.test(rel) ||
        /^design\/RFC-294-backend-layered-target-architecture(?:\/|$)/.test(rel))
    )
      throw new Error(
        'architecture reports cannot overwrite the architecture projection or RFC-294 documents',
      )
  }
  if (paths.report === paths.status) throw new Error('report and status paths must differ')
  return paths
}
export function runArchitectureReport(repoRoot: string, args: readonly string[]): void {
  const options = parseReportOptions(args),
    paths = reportOutputPaths(repoRoot, options)
  const report = buildArchitectureReport(readReportSource(repoRoot, options.sourceRef))
  for (const path of Object.values(paths)) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(paths.report, stableJson(report))
  writeFileSync(paths.status, renderReportStatus(report))
  if (options.gates) process.stdout.write(renderGateBaselines(report))
  process.stderr.write(
    `Architecture report generated at ${new Date().toISOString()} from ${report.sourceSha}\n${paths.report}\n${paths.status}\n`,
  )
}
if (import.meta.main) {
  try {
    runArchitectureReport(resolve(import.meta.dir, '..'), process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
