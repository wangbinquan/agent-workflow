#!/usr/bin/env bun

export {}

if (process.argv[2] === 'mcp-stdio') await import('./mcp/stdio')
else await import('./scip/cli')
