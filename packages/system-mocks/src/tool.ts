#!/usr/bin/env bun

export {}

const command = process.argv[2]

if (command === 'mcp-stdio') await import('./mcp/stdio')
else if (
  command === '--submit-approval' ||
  command === '--lookup-approval' ||
  command === '--observe-approval'
) {
  await import('./development/approval-adapter-cli')
} else if (
  command === '--collect-pipeline' ||
  command === '--trigger-pipeline' ||
  command === '--rerun-pipeline'
) {
  await import('./development/pipeline-adapter-cli')
} else await import('./scip/cli')
