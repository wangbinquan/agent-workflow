import { createHash } from 'node:crypto'

export interface SourceFile {
  readonly blob: string
  readonly mode: '100644' | '100755'
  readonly bytes: () => Uint8Array
}
export interface PublishedFile {
  readonly blob_id: string
  readonly last_commit_id: string
  readonly execute_filemode: boolean
}
export interface PublicationAction {
  readonly action: 'create' | 'update' | 'delete' | 'chmod'
  readonly file_path: string
  readonly content?: string
  readonly encoding?: 'base64'
  readonly last_commit_id?: string
  readonly execute_filemode?: boolean
}

export function sourceFile(bytes: Uint8Array): SourceFile {
  const blob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
  return { blob, mode: '100644', bytes: () => bytes }
}

/** The head message of every AW publication names its source commit. */
const PROVENANCE = /^agent-workflow ([a-f0-9]{40})(?:\n|$)/

/** The files the next publication is planned against. A branch AW published
 * before names that source commit in its head message. A branch AW never
 * published — a new CrewStation project still holding its template scaffold —
 * is adopted only on request: its current files count as the previous
 * publication, so AW's snapshot replaces them and removes the rest (RFC-370
 * hosted acceptance, 2026-10-19: the first publication to a new project
 * failed with no way forward). */
export function previousPublication(input: {
  readonly headMessage: string
  readonly adopt: boolean
  readonly committedFiles: (sha: string) => Map<string, SourceFile>
  readonly remoteTree: ReadonlyMap<string, { readonly id: string; readonly mode: string }>
}): { readonly sourceSha: string | null; readonly files: Map<string, SourceFile> } {
  const sha = PROVENANCE.exec(input.headMessage)?.[1]
  if (sha !== undefined) return { sourceSha: sha, files: input.committedFiles(sha) }
  if (!input.adopt)
    throw new Error(
      'publication-target-source-provenance-missing: agent-workflow never published this branch; ' +
        'for the first publication to a new project pass --adopt-existing to replace its current files',
    )
  const files = new Map<string, SourceFile>()
  for (const [path, entry] of input.remoteTree) {
    if (entry.mode !== '100644' && entry.mode !== '100755')
      throw new Error(`publication-unsupported-remote-entry: ${path}`)
    files.set(path, {
      blob: entry.id,
      mode: entry.mode,
      bytes: () => {
        throw new Error(`publication-adopted-file-unread: ${path}`)
      },
    })
  }
  return { sourceSha: null, files }
}

/** Delta against the previous published AW snapshot. Unmanaged files are
 * untouched. A modified managed file blocks publication instead of being
 * replaced. API last_commit_id also protects the read/commit race. */
export async function planSourcePublication(input: {
  readonly previous: ReadonlyMap<string, SourceFile>
  readonly next: ReadonlyMap<string, SourceFile>
  readonly remoteFile: (path: string) => Promise<PublishedFile | null>
}): Promise<readonly PublicationAction[]> {
  const actions: PublicationAction[] = []
  for (const path of new Set([...input.previous.keys(), ...input.next.keys()])) {
    const previous = input.previous.get(path),
      next = input.next.get(path)
    const remote = await input.remoteFile(path)
    if (remote?.blob_id === next?.blob && remote?.execute_filemode === (next?.mode === '100755'))
      continue
    if (
      remote === null
        ? previous !== undefined
        : previous === undefined ||
          remote.blob_id !== previous.blob ||
          remote.execute_filemode !== (previous.mode === '100755')
    ) {
      throw new Error(`publication-managed-file-changed: ${path}`)
    }
    if (next === undefined) {
      if (remote !== null)
        actions.push({ action: 'delete', file_path: path, last_commit_id: remote.last_commit_id })
      continue
    }
    if (remote?.blob_id !== next.blob)
      actions.push({
        action: remote === null ? 'create' : 'update',
        file_path: path,
        content: Buffer.from(next.bytes()).toString('base64'),
        encoding: 'base64',
        ...(remote === null ? {} : { last_commit_id: remote.last_commit_id }),
      })
    // GitLab considers execute_filemode only on chmod, including new files.
    if ((remote?.execute_filemode ?? false) !== (next.mode === '100755')) {
      actions.push({ action: 'chmod', file_path: path, execute_filemode: next.mode === '100755' })
    }
  }
  return actions
}

export interface PublicationCommit {
  readonly id: string
  readonly message: string
  readonly parent_ids: readonly string[]
}

export function createGitLabPublication(input: {
  readonly apiUrl: string
  readonly project: string
  readonly token: string
  readonly fetch?: typeof fetch
}) {
  const request = input.fetch ?? fetch
  const base =
    input.apiUrl.replace(/\/$/, '') + '/api/v4/projects/' + encodeURIComponent(input.project)
  const read = async <T>(path: string, body?: unknown): Promise<T | null> => {
    const response = await request(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'PRIVATE-TOKEN': input.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (body === undefined && response.status === 404) return null
    // Never print upstream bodies: a proxy error may echo credentials.
    if (!response.ok) throw new Error(`source-publication-http-${response.status}`)
    return (await response.json()) as T
  }
  const head = async (branch: string) => {
    const commit = await read<PublicationCommit>(
      '/repository/commits/' + encodeURIComponent(branch),
    )
    if (commit === null) throw new Error('publication-target-branch-not-found')
    return commit
  }
  return {
    head,
    async tree(ref: string) {
      const entries = new Map<string, { readonly id: string; readonly mode: string }>()
      for (let page = 1; ; page += 1) {
        const batch = await read<Array<{ path: string; id: string; mode: string; type: string }>>(
          '/repository/tree?recursive=true&per_page=100&page=' +
            page +
            '&ref=' +
            encodeURIComponent(ref),
        )
        if (batch === null) throw new Error('publication-source-tree-missing')
        for (const entry of batch) if (entry.type !== 'tree') entries.set(entry.path, entry)
        if (batch.length < 100) return entries
      }
    },
    file: (path: string, ref: string) =>
      read<PublishedFile & { content: string }>(
        '/repository/files/' + encodeURIComponent(path) + '?ref=' + encodeURIComponent(ref),
      ),
    async commit(input: {
      branch: string
      expectedHead: string
      message: string
      actions: readonly PublicationAction[]
      authorName: string
      authorEmail: string
    }) {
      if ((await head(input.branch)).id !== input.expectedHead)
        throw new Error('publication-target-advanced')
      if (input.actions.length === 0) return input.expectedHead
      // Commit onto the existing branch: GitLab rejects `start_sha` (a new-branch
      // start point) when the branch exists. The head check above, the
      // per-file `last_commit_id` and the parent check below keep it exact.
      const commit = await read<PublicationCommit>('/repository/commits', {
        branch: input.branch,
        commit_message: input.message,
        actions: input.actions,
        author_name: input.authorName,
        author_email: input.authorEmail,
      })
      if (commit === null || commit.parent_ids[0] !== input.expectedHead)
        throw new Error('publication-target-advanced-during-commit')
      if ((await head(input.branch)).id !== commit.id)
        throw new Error('publication-target-advanced-after-commit')
      return commit.id
    },
  }
}
