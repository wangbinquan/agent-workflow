import { fireEvent, screen } from '@testing-library/react'
import { vi } from 'vitest'
import * as pkgApi from '../src/api/resourcePackages'

export async function beginDeferredPackageCommit(
  resourceType: pkgApi.PackagePreviewEntry['type'],
  packageTabTestId: string,
): Promise<{ finish: () => void }> {
  let finish!: () => void
  const commit = new Promise<pkgApi.PackageImportReceipt>((resolve) => {
    finish = () => resolve({ journalId: 'busy-journal', applied: [] })
  })

  vi.spyOn(pkgApi, 'previewResourcePackage').mockResolvedValue({
    importId: 'busy-import',
    previewToken: 'busy-token',
    expiresAt: Date.now() + 60_000,
    root: { slug: 'busy-root', type: resourceType, name: 'busy-root' },
    humanMembers: [],
    secrets: [],
    requirements: {
      runtimes: [],
      codeHosts: [],
      executables: [],
      pluginSources: [],
      projectSkills: [],
      mcpKinds: [],
      humanMembers: [],
    },
    entries: [
      {
        localSlug: 'busy-root',
        type: resourceType,
        name: 'busy-root',
        suggestedName: 'busy-root-copy',
        allowedActions: ['new'],
        defaultAction: 'new',
        missingPermissions: [],
        secretFields: [],
        candidates: [],
      },
    ],
  })
  vi.spyOn(pkgApi, 'commitResourcePackage').mockReturnValue(commit)

  fireEvent.click(screen.getByTestId(packageTabTestId))
  fireEvent.change(screen.getByTestId('package-import-file'), {
    target: {
      files: [new File(['package'], 'busy-package.zip', { type: 'application/zip' })],
    },
  })
  fireEvent.click(screen.getByTestId('package-import-preview'))
  fireEvent.click(await screen.findByTestId('package-import-commit'))

  return { finish }
}

export async function beginUnknownPackageCommit(
  resourceType: pkgApi.PackagePreviewEntry['type'],
  packageTabTestId: string,
): Promise<void> {
  vi.spyOn(pkgApi, 'previewResourcePackage').mockResolvedValue({
    importId: 'unknown-import',
    previewToken: 'unknown-token',
    expiresAt: Date.now() + 60_000,
    root: { slug: 'unknown-root', type: resourceType, name: 'unknown-root' },
    humanMembers: [],
    secrets: [],
    requirements: {
      runtimes: [],
      codeHosts: [],
      executables: [],
      pluginSources: [],
      projectSkills: [],
      mcpKinds: [],
      humanMembers: [],
    },
    entries: [
      {
        localSlug: 'unknown-root',
        type: resourceType,
        name: 'unknown-root',
        suggestedName: 'unknown-root-copy',
        allowedActions: ['new'],
        defaultAction: 'new',
        missingPermissions: [],
        secretFields: [],
        candidates: [],
      },
    ],
  })
  vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(new Error('commit response lost'))

  fireEvent.click(screen.getByTestId(packageTabTestId))
  fireEvent.change(screen.getByTestId('package-import-file'), {
    target: {
      files: [new File(['package'], 'unknown-package.zip', { type: 'application/zip' })],
    },
  })
  fireEvent.click(screen.getByTestId('package-import-preview'))
  fireEvent.click(await screen.findByTestId('package-import-commit'))
  await screen.findByTestId('package-import-retry-notice')
}
