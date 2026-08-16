import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { strToU8, zipSync } from 'fflate'

import type { MockNpmPackage, MockPackageFile, MockPythonPackage } from '../types'

export function npmTarball(pkg: MockNpmPackage): Buffer {
  const packageJson = {
    name: pkg.name,
    version: pkg.version,
    description: 'system mock package',
    main: 'index.js',
    ...pkg.packageJson,
  }
  const files: MockPackageFile[] = [
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'index.js', content: "module.exports = { source: 'system-mock' }\n" },
    ...(pkg.files ?? []),
  ]
  const chunks = files.map((file) => tarEntry(`package/${file.path}`, file.content, file.mode))
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

export function pythonWheel(pkg: MockPythonPackage): { filename: string; body: Buffer } {
  const distribution = pkg.name.replace(/[-.]+/g, '_')
  const moduleName = pkg.module ?? distribution.toLowerCase()
  const distInfo = `${distribution}-${pkg.version}.dist-info`
  const filename = `${distribution}-${pkg.version}-py3-none-any.whl`
  const entries: Record<string, Uint8Array> = {
    [`${moduleName}/__init__.py`]: strToU8("SOURCE = 'system-mock'\n"),
    [`${distInfo}/METADATA`]: strToU8(
      `Metadata-Version: 2.1\nName: ${pkg.name}\nVersion: ${pkg.version}\nSummary: system mock package\n\n`,
    ),
    [`${distInfo}/WHEEL`]: strToU8(
      'Wheel-Version: 1.0\nGenerator: agent-workflow-system-mocks\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    ),
    [`${distInfo}/top_level.txt`]: strToU8(`${moduleName}\n`),
  }
  for (const file of pkg.files ?? []) entries[file.path] = strToU8(file.content)
  const recordPaths = [...Object.keys(entries), `${distInfo}/RECORD`]
  entries[`${distInfo}/RECORD`] = strToU8(recordPaths.map((path) => `${path},,`).join('\n'))
  return { filename, body: Buffer.from(zipSync(entries, { level: 6 })) }
}

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function tarEntry(path: string, content: string, mode = 0o644): Buffer {
  const body = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  writeTarString(header, 0, 100, path)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, body.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')
  writeTarString(header, 265, 32, 'system-mock')
  writeTarString(header, 297, 32, 'system-mock')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  const encodedChecksum = checksum.toString(8).padStart(6, '0')
  header.write(encodedChecksum, 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function writeTarString(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value.slice(0, length), offset, length, 'utf8')
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0'
  target.write(encoded, offset, length, 'ascii')
}
