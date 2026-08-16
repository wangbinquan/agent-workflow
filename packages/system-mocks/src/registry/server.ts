import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeJson, writeText } from '../core/http'
import type { MockNpmPackage, MockPythonPackage } from '../types'
import { npmTarball, pythonWheel, sha256Hex } from './artifacts'

interface StoredNpm extends MockNpmPackage {
  tarball: Buffer
}

interface StoredPython extends MockPythonPackage {
  filename: string
  wheel: Buffer
}

export class PackageRegistryMock {
  readonly #npm = new Map<string, Map<string, StoredNpm>>()
  readonly #pypi = new Map<string, Map<string, StoredPython>>()
  readonly #baseUrl: () => string

  constructor(baseUrl: () => string) {
    this.#baseUrl = baseUrl
    this.reset()
  }

  reset(): void {
    this.#npm.clear()
    this.#pypi.clear()
    this.seedNpm({ name: 'system-mock-package', version: '1.0.0' })
    this.seedPython({ name: 'system-mock-python', version: '1.0.0' })
  }

  seedNpm(pkg: MockNpmPackage): void {
    const versions = this.#npm.get(pkg.name) ?? new Map<string, StoredNpm>()
    versions.set(pkg.version, { ...structuredClone(pkg), tarball: npmTarball(pkg) })
    this.#npm.set(pkg.name, versions)
  }

  seedPython(pkg: MockPythonPackage): void {
    const name = normalizePythonName(pkg.name)
    const versions = this.#pypi.get(name) ?? new Map<string, StoredPython>()
    const wheel = pythonWheel(pkg)
    versions.set(pkg.version, {
      ...structuredClone(pkg),
      filename: wheel.filename,
      wheel: wheel.body,
    })
    this.#pypi.set(name, versions)
  }

  snapshot(): {
    npm: Array<{ name: string; version: string }>
    pypi: Array<{ name: string; version: string }>
  } {
    return {
      npm: [...this.#npm].flatMap(([name, versions]) =>
        [...versions.keys()].map((version) => ({ name, version })),
      ),
      pypi: [...this.#pypi].flatMap(([name, versions]) =>
        [...versions.keys()].map((version) => ({ name, version })),
      ),
    }
  }

  handle(input: { request: IncomingMessage; response: ServerResponse; url: URL }): boolean {
    if (input.url.pathname.startsWith('/npm')) return this.#handleNpm(input)
    if (input.url.pathname.startsWith('/pypi')) return this.#handlePypi(input)
    return false
  }

  #handleNpm(input: { request: IncomingMessage; response: ServerResponse; url: URL }): boolean {
    const path = decodeURIComponent(input.url.pathname.slice('/npm'.length)).replace(/^\/+/, '')
    if (path.length === 0) {
      writeJson(input.response, 200, { ok: true, service: 'system-mock-npm' })
      return true
    }
    for (const [name, versions] of this.#npm) {
      const escapedName = name.startsWith('@') ? name : name
      const tarPrefix = `${escapedName}/-/`
      if (path.startsWith(tarPrefix)) {
        const filename = path.slice(tarPrefix.length)
        const pkg = [...versions.values()].find(
          (candidate) => filename === `${name.split('/').at(-1)}-${candidate.version}.tgz`,
        )
        if (pkg === undefined) return npmNotFound(input.response, name)
        input.response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(pkg.tarball.length),
        })
        input.response.end(pkg.tarball)
        return true
      }
      if (path === name) {
        const versionEntries = Object.fromEntries(
          [...versions].map(([version, pkg]) => {
            const leaf = name.split('/').at(-1) ?? name
            const tarball = `${this.#baseUrl()}/npm/${name}/-/${leaf}-${version}.tgz`
            return [
              version,
              {
                name,
                version,
                ...pkg.packageJson,
                dist: {
                  tarball,
                  shasum: createHash('sha1').update(pkg.tarball).digest('hex'),
                  integrity: `sha512-${createHash('sha512').update(pkg.tarball).digest('base64')}`,
                },
              },
            ]
          }),
        )
        const latest = [...versions.keys()].at(-1)
        writeJson(input.response, 200, {
          _id: name,
          name,
          'dist-tags': { latest },
          versions: versionEntries,
        })
        return true
      }
    }
    return npmNotFound(input.response, path)
  }

  #handlePypi(input: { request: IncomingMessage; response: ServerResponse; url: URL }): boolean {
    if (input.url.pathname === '/pypi/simple' || input.url.pathname === '/pypi/simple/') {
      const links = [...this.#pypi.keys()]
        .map((name) => `<a href="${name}/">${name}</a>`)
        .join('\n')
      writeText(
        input.response,
        200,
        `<!doctype html><html><body>${links}</body></html>`,
        'text/html',
      )
      return true
    }
    const projectMatch = /^\/pypi\/simple\/([^/]+)\/?$/.exec(input.url.pathname)
    if (projectMatch !== null) {
      const name = normalizePythonName(decodeURIComponent(projectMatch[1]!))
      const versions = this.#pypi.get(name)
      if (versions === undefined) return pypiNotFound(input.response)
      const links = [...versions.values()]
        .map(
          (pkg) =>
            `<a href="../../files/${pkg.filename}#sha256=${sha256Hex(pkg.wheel)}">${pkg.filename}</a>`,
        )
        .join('\n')
      writeText(
        input.response,
        200,
        `<!doctype html><html><body>${links}</body></html>`,
        'text/html',
      )
      return true
    }
    const filename = /^\/pypi\/files\/([^/]+)$/.exec(input.url.pathname)?.[1]
    if (filename !== undefined) {
      const pkg = [...this.#pypi.values()]
        .flatMap((versions) => [...versions.values()])
        .find((candidate) => candidate.filename === filename)
      if (pkg === undefined) return pypiNotFound(input.response)
      input.response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(pkg.wheel.length),
      })
      input.response.end(pkg.wheel)
      return true
    }
    return pypiNotFound(input.response)
  }
}

function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function npmNotFound(response: ServerResponse, name: string): true {
  writeJson(response, 404, { error: 'not_found', reason: `no such package: ${name}` })
  return true
}

function pypiNotFound(response: ServerResponse): true {
  writeText(response, 404, 'Not Found')
  return true
}
