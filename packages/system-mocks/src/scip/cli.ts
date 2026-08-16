#!/usr/bin/env bun

import { readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import protobuf from 'protobufjs'

const SCIP_PROTO = `
syntax = "proto3";
package scip;
message Index { repeated Document documents = 2; }
message Document { string relative_path = 1; repeated Occurrence occurrences = 2; string language = 4; }
message Occurrence { repeated int32 range = 1; string symbol = 2; int32 symbol_roles = 3; }
`

const indexType = protobuf.parse(SCIP_PROTO).root.lookupType('scip.Index')
const args = process.argv.slice(2)
const mode = process.env.AW_SYSTEM_MOCK_SCIP_MODE ?? 'ok'

if (args.includes('--version') || args.includes('-version') || args[0] === 'version') {
  process.stdout.write('system-mock-scip 1.0.0\n')
  process.exit(0)
}
if (mode === 'crash') {
  process.stderr.write('system mock SCIP: crash mode requested\n')
  process.exit(2)
}
if (mode === 'hang') await new Promise(() => {})

const output = outputPath(args)
if (output === null) {
  process.stderr.write('system mock SCIP: missing --output or --index-output\n')
  process.exit(2)
}
if (mode === 'no-output') process.exit(0)
if (mode === 'garbage') {
  await writeFile(output, 'not-a-scip-index')
  process.exit(0)
}

const cwd = process.cwd()
const paths = await sourceFiles(cwd)
const documents = paths.map((path) => ({
  relativePath: path,
  language: languageFor(path),
  occurrences: [
    {
      range: [0, 0, 1],
      symbol: `scip system-mock ${languageFor(path)} . \`${path}\`/file.`,
      symbolRoles: 1,
    },
  ],
}))
const bytes = indexType
  .encode(
    indexType.fromObject({
      documents:
        documents.length > 0
          ? documents
          : [
              {
                relativePath: 'system-mock.txt',
                language: 'text',
                occurrences: [
                  {
                    range: [0, 0, 1],
                    symbol: 'scip system-mock text . `system-mock.txt`/file.',
                    symbolRoles: 1,
                  },
                ],
              },
            ],
    }),
  )
  .finish()
await writeFile(output, bytes)

function outputPath(argv: string[]): string | null {
  for (const flag of ['--output', '--index-output']) {
    const index = argv.indexOf(flag)
    if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1]!
  }
  return null
}

async function sourceFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const queue = [root]
  while (queue.length > 0 && output.length < 1000) {
    const directory = queue.shift()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && languageFor(entry.name) !== 'text') {
        output.push(relative(root, absolute).split('\\').join('/'))
      }
    }
  }
  return output.sort()
}

function languageFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension))
    return 'typescript'
  if (['.py', '.pyi'].includes(extension)) return 'python'
  if (extension === '.go') return 'go'
  if (extension === '.rs') return 'rust'
  if (['.cpp', '.cc', '.cxx', '.hpp', '.h'].includes(extension)) return 'cpp'
  if (['.java', '.scala'].includes(extension)) return 'java'
  return 'text'
}
