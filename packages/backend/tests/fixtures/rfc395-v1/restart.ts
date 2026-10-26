// Separate-process watermark probe; invoked only by the T18 regression test.
import { loadSupportedSourceManifest } from '@/platform/persistence/migration/supportedSources'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
const reader = openEpoch1SqliteSource({
  path: process.argv[2]!,
  operationRoot: process.argv[3]!,
  manifest: await loadSupportedSourceManifest(),
})
try {
  console.log(JSON.stringify({ watermark: (await reader.preflight()).watermark }))
} finally {
  await reader.close()
}
