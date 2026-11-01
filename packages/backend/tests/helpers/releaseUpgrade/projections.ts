// RFC-398 S3: independent, source-derived relational and content projections.
import { createHash } from 'node:crypto'
import { redactGitUrl } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { compareNodeRunMintOrder } from '../model/frozenSelection/order'
import { sha256 } from '../../../../../scripts/release-upgrade/lib/io'
import type { BuiltRelease } from './build'
import type { Destination, OracleEntry } from './oracle'
import {
  equal,
  invariant,
  sortedRows,
  normalized,
  UPGRADE_TIME,
  type Row,
  type Snapshot,
} from './data'

const parse = (value: unknown, fallback: unknown = null): unknown =>
  value == null || value === '' ? fallback : JSON.parse(String(value))
const rows = (snapshot: Snapshot, table: string, where: Row): Row[] =>
  (snapshot.get(table) ?? []).filter((row) =>
    Object.entries(where).every(
      ([k, v]) => canonicalSchemaJson(normalized(row[k])) === canonicalSchemaJson(normalized(v)),
    ),
  )
export function one(snapshot: Snapshot, table: string, where: Row): Row {
  const found = rows(snapshot, table, where)
  equal(found.length, 1, `S3 destination ${table} ${JSON.stringify(where)}`)
  return found[0]!
}
export function destinationRows(
  entry: OracleEntry,
  source: Row,
  destination: Destination,
  _current: Snapshot,
  target: Snapshot,
): Row[] {
  const where: Row = {}
  let projected = false
  for (const [column, key] of Object.entries(destination.key)) {
    if (key.sourceColumn) where[column] = source[key.sourceColumn]
    else if ('literal' in key) where[column] = key.literal
    else if (key.projection) projected = true
  }
  const found = rows(target, destination.table, where)
  if (!projected) {
    if (entry.table === 'node_runs') {
      const additional: Record<string, string[]> = {
        node_run_configs: ['prompt_text', 'prompt_path'],
        node_run_runtime_states: ['opencode_session_id', 'iso_worktree_path'],
        node_run_results: [],
      }
      if (destination.table in additional) {
        const columns = [...destination.preserveColumns, ...additional[destination.table]!]
        const expected = columns.some((column) => source[column] != null) ? 1 : 0
        equal(found.length, expected, `S2 ${destination.table} recorded source facts`)
        return found
      }
    }
    const optional = entry.table === 'tasks' && destination.table === 'task_repository_mounts'
    invariant(
      optional ? found.length <= 1 : found.length === 1,
      `S2 ${entry.table} -> ${destination.table} destination cardinality ${found.length}`,
    )
  }
  return found
}
function referenceId(value: unknown, source: Snapshot, table: string): unknown {
  if (value && typeof value === 'object') {
    const object = value as Row
    if (object.id !== undefined) return object.id
    if (object.name !== undefined) value = object.name
  }
  const found = (source.get(table) ?? []).filter((r) => r.id === value || r.name === value)
  equal(found.length, 1, `S3 unique legacy ${table} reference ${String(value)}`)
  return found[0]!.id
}
function agentReferences(source: Row, current: Snapshot, target: Snapshot): void {
  for (const [column, table, resource, identity] of [
    ['skills', 'agent_skill_refs', 'skills', 'skill_id'],
    ['mcp', 'agent_mcp_refs', 'mcps', 'mcp_id'],
    ['plugins', 'agent_plugin_refs', 'plugins', 'plugin_id'],
    ['depends_on', 'agent_dependencies', 'agents', 'dependency_agent_id'],
  ] as const) {
    const values = parse(source[column], []) as unknown[]
    invariant(Array.isArray(values), `S3 ${column} array`)
    const actual = rows(target, table, { agent_id: source.id }).sort(
      (a, b) => Number(a.ordinal) - Number(b.ordinal),
    )
    equal(actual.length, values.length, `S3 ${table} cardinality`)
    const occurrences = new Map<string, number>()
    for (const [i, value] of values.entries()) {
      const object = value && typeof value === 'object' ? (value as Row) : undefined
      const project = column === 'skills' && object?.kind === 'project'
      const id = project
        ? (object!.name ?? object!.projectName)
        : referenceId(
            object?.skillId ?? object?.mcpId ?? object?.pluginId ?? object?.agentId ?? value,
            current,
            resource,
          )
      const key = JSON.stringify([project, id]),
        occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      equal(
        [actual[i]!.ordinal, actual[i]!.occurrence],
        [i, occurrence],
        `S3 ${table} order/duplicates`,
      )
      equal(actual[i]![project ? 'project_name' : identity], id, `S3 ${table} reference`)
      if (column === 'skills')
        equal(actual[i]!.kind, project ? 'project' : 'managed', 'S3 skill reference kind')
    }
  }
}
function clarify(source: Row, target: Snapshot): void {
  const questions = parse(source.questions_json, []) as Row[]
  for (const [column, table] of [
    ['answers_json', 'clarify_answers'],
    ['draft_answers_json', 'clarify_answer_drafts'],
    ['answer_attributions_json', 'clarify_answer_attributions'],
  ] as const) {
    const values = parse(source[column], column === 'answers_json' ? [] : {}) as Row | Row[]
    const actual = rows(target, table, { round_id: source.id }).sort(
      (a, b) => Number(a.ordinal) - Number(b.ordinal),
    )
    const wanted: [string, unknown][] = Array.isArray(values)
      ? values.map((answer) => {
          invariant(typeof answer.questionId === 'string', 'S3 answer question identity')
          return [answer.questionId, answer]
        })
      : Object.entries(values)
    equal(actual.length, wanted.length, `S3 ${table} no lost answer/attribution`)
    for (const [key, value] of wanted) {
      const matches = actual.filter((r) => r.question_id === key)
      equal(matches.length, 1, `S3 ${table} question ${key}`)
      equal(parse(matches[0]!.value_json), value, `S3 ${table} value ${key}`)
      equal(matches[0]!.occurrence, 0, `S3 ${table} occurrence ${key}`)
      invariant(
        questions.some((q) => q.id === key),
        `S3 orphan question requires decision ${key}`,
      )
    }
    const order = wanted.map(([id]) => id)
    equal(
      actual.map((r) => r.question_id),
      order,
      `S3 ${table} recorded order`,
    )
  }
}
function treeBytes(path: string): Buffer {
  const entries: { path: string; size: number; sha256: string }[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        invariant(entry.isFile(), 'S3 unexpected content tree entry')
        const bytes = readFileSync(full)
        entries.push({
          path: relative(path, full).replaceAll('\\', '/'),
          size: bytes.length,
          sha256: sha256(bytes),
        })
      }
    }
  }
  walk(path)
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  return Buffer.from(canonicalSchemaJson({ format: 'skill-tree-manifest@1', entries }))
}
function fixtureBytes(reference: unknown, built: BuiltRelease): Buffer | null {
  if (typeof reference !== 'string') return null
  const object = built.seeds.flatMap((s) => s.content ?? []).find((c) => c.objectId === reference)
  const path = object
    ? join(built.home, object.path)
    : isAbsolute(reference)
      ? reference
      : join(built.home, reference)
  if (!existsSync(path)) return null
  return statSync(path).isDirectory() ? treeBytes(path) : readFileSync(path)
}
function content(
  source: Row,
  entry: OracleEntry,
  current: Snapshot,
  target: Snapshot,
  built: BuiltRelease,
  key: string,
): void {
  const receipts = (target.get('aw_meta_migration_artifact_receipts') ?? []).filter(
    (r) => r.source_table === entry.table && r.source_key === key,
  )
  const columns =
    entry.table === 'node_runs'
      ? ['prompt_text', 'prompt_path']
      : (entry.projections ?? []).flatMap((p) => p.sourceColumns)
  const meaningful = columns.some((column) => source[column] != null)
  if (
    meaningful &&
    !(
      entry.table === 'hosted_task_archive_entries' &&
      (parse(source.parts_json, []) as unknown[]).length === 0
    )
  )
    invariant(receipts.length > 0, `S3 content receipts missing ${entry.table}/${key}`)
  for (const receipt of receipts) {
    const column = String(receipt.source_column)
    let bytes: Buffer | null = null
    if (['content', 'comment_text', 'body', 'prompt_text'].includes(column)) {
      const value = source[column]
      if (value !== null && value !== undefined)
        bytes = Buffer.from(
          String(value),
          entry.table === 'skill_content_entries' && source.encoding === 'base64'
            ? 'base64'
            : 'utf8',
        )
    } else bytes = fixtureBytes(source[column], built)
    if (entry.table === 'skills' || entry.table === 'skill_versions') {
      const skill = source.skill_id ?? source.id,
        tree = entry.table === 'skills' ? 'live' : `version:${String(source.version_index)}`
      const entries = rows(current, 'skill_content_entries', { skill_id: skill, tree }).map(
        (file) => ({
          path: String(file.path),
          bytes: Buffer.from(String(file.content), file.encoding === 'base64' ? 'base64' : 'utf8'),
        }),
      )
      if (!entries.length && typeof source[column] === 'string') {
        const root = isAbsolute(String(source[column]))
          ? String(source[column])
          : join(built.home, String(source[column]))
        if (existsSync(root) && statSync(root).isDirectory()) {
          const walk = (dir: string) => {
            for (const item of readdirSync(dir, { withFileTypes: true })) {
              const path = join(dir, item.name)
              if (item.isDirectory()) walk(path)
              else if (item.isFile())
                entries.push({
                  path: relative(root, path).replaceAll('\\', '/'),
                  bytes: readFileSync(path),
                })
            }
          }
          walk(root)
        }
      }
      if (entries.length) {
        const hash = createHash('sha256')
        for (const item of entries.sort((a, b) =>
          Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
        )) {
          hash
            .update(item.path)
            .update(Buffer.from([0]))
            .update(item.bytes)
            .update(Buffer.from([0]))
        }
        const contentHash = hash.digest('hex')
        const versions =
          entry.table === 'skill_versions'
            ? [one(target, 'skill_versions', { id: source.id })]
            : rows(target, 'skill_versions', {
                skill_id: source.id,
                version_index: rows(current, 'skill_versions', { skill_id: skill }).length
                  ? source.content_version
                  : 1,
              })
        equal(versions.length, 1, 'S3 skill tree has exactly one matching version')
        equal(versions[0]!.content_hash, contentHash, 'S3 skill tree content hash')
        bytes = Buffer.from(
          canonicalSchemaJson({
            format: 'skill-tree-manifest@1',
            entries: entries.map((item) => ({
              path: item.path,
              size: item.bytes.length,
              sha256: sha256(item.bytes),
            })),
          }),
        )
        const migrated = one(target, entry.table, { id: source.id })
        const ref = decodeContentRefColumns(String(migrated.content_ref_json), null)!
        const databaseTree =
          rows(current, 'skill_content_entries', { skill_id: skill, tree }).length > 0
        equal(
          [ref.kind, ref.location, ref.contentId, ref.contentVersion, ref.sha256, ref.size],
          [
            databaseTree ? 'database-bytes' : 'local-file',
            databaseTree
              ? { codec: 'skill-tree', value: { skillId: skill, tree } }
              : { codec: 'skill-path', value: source[column] },
            null,
            null,
            null,
            null,
          ],
          'S3 frozen skill tree reference',
        )
        if (
          databaseTree ||
          (entry.table === 'skills' && !rows(current, 'skill_versions', { skill_id: skill }).length)
        ) {
          const targetTree = databaseTree ? tree : 'version:1'
          const files = rows(target, 'skill_content_entries', { skill_id: skill, tree: targetTree })
          equal(files.length, entries.length, 'S3 exact skill tree file count')
          for (const file of entries) {
            const migratedFile = one(target, 'skill_content_entries', {
              skill_id: skill,
              tree: targetTree,
              path: file.path,
            })
            const fileRef = decodeContentRefColumns(
              String(migratedFile.content_ref_json),
              (migratedFile.content_inline_bytes ?? null) as Uint8Array | null,
            )!
            const actual =
              fileRef.kind === 'inline'
                ? fileRef.bytes
                : one(target, 'content_bytes', { content_id: fileRef.contentId }).bytes
            equal(
              Buffer.from(actual as Uint8Array).toString('base64'),
              file.bytes.toString('base64'),
              'S3 exact skill tree file bytes',
            )
          }
        }
      }
    }
    if (bytes) {
      equal(receipt.sha256, sha256(bytes), `S3 ${entry.table}.${column} source bytes digest`)
      equal(Number(receipt.size), bytes.length, `S3 ${entry.table}.${column} byte length`)
      invariant(receipt.missing_state === null, `S3 present content mislabeled absent ${column}`)
    } else if (source[column] != null && entry.table !== 'hosted_task_archive_entries') {
      // A present ledger object/file may never be accepted as originally absent.
      invariant(
        receipt.missing_state !== null && !!receipt.missing_evidence,
        `S3 unavailable content lacks absence evidence ${entry.table}.${column}`,
      )
    }
    if (column in source && column !== 'prompt_text' && column !== 'parts_json')
      equal(
        receipt.original_reference,
        typeof source[column] === 'string' ? source[column] : null,
        `S3 original content identity ${entry.table}.${column}`,
      )
  }
  const destinations = (entry.destinations ?? [])
    .filter((d) => entry.table !== 'node_runs' || d.table === 'node_run_configs')
    .flatMap((d) => destinationRows(entry, source, d, current, target))
  for (const row of destinations)
    for (const [column, value] of Object.entries(row))
      if (column.endsWith('_ref_json') && value !== null) {
        const bytesColumn =
          column === 'staged_content_ref_json'
            ? 'staged_inline_bytes'
            : column.replace('_ref_json', '_inline_bytes')
        const ref = decodeContentRefColumns(
          String(value),
          (row[bytesColumn] ?? null) as Uint8Array | null,
        )
        if (!ref) continue
        const mediaType = ['node_runs', 'doc_versions', 'collaboration_gate_artifacts'].includes(
          entry.table,
        )
          ? 'text/markdown'
          : entry.table === 'hosted_node_event_archives'
            ? 'application/x-ndjson'
            : null
        equal(ref.mediaType, mediaType, `S3 ${entry.table} content media type`)
        const sourceColumn =
          entry.table === 'node_runs'
            ? source.prompt_text !== null
              ? 'prompt_text'
              : 'prompt_path'
            : entry.table === 'collaboration_gate_artifacts'
              ? column === 'staged_content_ref_json'
                ? 'staged_path'
                : 'final_path'
              : (
                  {
                    development_object_artifacts: 'object_id',
                    doc_versions: 'body_path',
                    employee_reaction_artifacts: 'body',
                    hosted_node_event_archives: 'object_id',
                    hosted_task_artifacts: 'object_id',
                    node_run_outputs: 'content',
                    review_comments: 'comment_text',
                    skill_content_entries: 'content',
                    skill_versions: 'files_path',
                    skills: 'managed_path',
                    hosted_task_archive_entries: 'parts_json',
                  } as Record<string, string>
                )[entry.table]
        invariant(sourceColumn, `S3 content column mapping absent ${entry.table}.${column}`)
        const ownReceipts = receipts.filter((r) => r.source_column === sourceColumn)
        invariant(
          ownReceipts.length > 0,
          `S3 target content has no matching source column ${sourceColumn}`,
        )
        if (ref.sha256 !== null && ref.size !== null)
          invariant(
            ownReceipts.some((r) => r.sha256 === ref.sha256 && Number(r.size) === ref.size),
            `S3 target content differs from ${entry.table}.${sourceColumn}`,
          )
        if (ref.kind === 'inline') {
          const receipt = ownReceipts.find((r) => r.sha256 === sha256(ref.bytes))
          invariant(receipt, `S3 inline target bytes not backed by source receipt ${entry.table}`)
        } else if (ref.contentId) {
          const object = one(target, 'content_objects', { content_id: ref.contentId })
          if (ref.kind === 'database-bytes') {
            const stored = one(target, 'content_bytes', { content_id: ref.contentId })
            equal(
              sha256(stored.bytes as Uint8Array),
              object.sha256,
              'S3 target database content bytes',
            )
          }
          equal(
            [object.sha256, Number(object.size)],
            [ref.sha256, ref.size],
            'S3 published content identity',
          )
        }
      }
  if (entry.table === 'hosted_object_publications') {
    const publication = one(target, 'content_publications', { id: source.id })
    if (source.object_id !== null) {
      const object = one(target, 'content_objects', { content_id: publication.content_id })
      equal(
        parse(object.location_json),
        { codec: 'hosted-object-id', value: source.object_id },
        'S3 publication object location',
      )
    }
  }
  if (entry.table === 'hosted_task_archive_entries') {
    const parts = parse(source.parts_json, []) as Row[]
    const actual = rows(target, 'hosted_task_archive_entry_parts', { path: source.path }).sort(
      (a, b) => Number(a.ordinal) - Number(b.ordinal),
    )
    equal(actual.length, parts.length, 'S3 archive part count')
    for (const [i, part] of parts.entries()) {
      equal(actual[i]!.ordinal, i, 'S3 archive part order')
      equal(actual[i]!.part_key, part.key, 'S3 archive part identity')
      const ref = decodeContentRefColumns(
        String(actual[i]!.content_ref_json),
        (actual[i]!.content_inline_bytes ?? null) as Uint8Array | null,
      )!
      equal(
        [ref.location.value, ref.sha256, ref.size],
        [part.id, part.sha256, part.size],
        'S3 archive object identity',
      )
      const bytes = fixtureBytes(part.id, built)
      invariant(bytes, 'S3 archive fixture bytes absent')
      equal(
        [sha256(bytes), bytes.length],
        [part.sha256, part.size],
        'S3 source archive object bytes',
      )
      invariant(
        receipts.some(
          (r) =>
            r.original_reference ===
            canonicalSchemaJson({
              key: part.key,
              id: part.id,
              sha256: part.sha256,
              size: part.size,
            }),
        ),
        'S3 archive part receipt missing',
      )
    }
  }
}
function taskProjection(source: Row, current: Snapshot, target: Snapshot): void {
  const task = one(target, 'tasks', { id: source.id }),
    definition = one(target, 'task_definitions', { task_id: source.id }),
    workspace = one(target, 'task_workspaces', { task_id: source.id })
  equal(
    task.workspace_root_ref,
    source.worktree_path === '' ? null : source.worktree_path,
    'S3 workspace root',
  )
  equal(
    task.name,
    source.name == null || source.name === ''
      ? `task-${String(source.id).slice(-10)}`
      : source.name,
    'S3 task display name',
  )
  const kind = source.code_round_id
    ? 'code-round'
    : source.workgroup_id
      ? 'workgroup'
      : source.source_agent_name
        ? 'agent'
        : source.workflow_id === '00000000000000DIGEMPHOST0'
          ? 'digital-employee'
          : 'workflow'
  equal(definition.subject_kind, kind, 'S3 task subject precedence')
  equal(definition.source_revision, source.workflow_version, 'S3 frozen definition revision')
  if (kind === 'workflow')
    equal(definition.source_id, source.workflow_id, 'S3 workflow source identity')
  if (kind === 'agent')
    equal(
      [definition.source_id, definition.source_name],
      [source.source_agent_id, source.source_agent_name],
      'S3 agent source identity',
    )
  equal(workspace.task_branch, source.branch, 'S3 requested task branch')
  const request = parse(workspace.requested_source) as Row
  invariant(request && typeof request === 'object', 'S3 requested source object')
  // The storage contract uses camelCase request fields, preserving legacy values.
  for (const [old, name] of [
    ['repo_path', 'repoPath'],
    ['repo_url', 'repoUrl'],
    ['base_commit', 'legacyBaseCommit'],
    ['cached_repo_id', 'cachedRepoId'],
  ] as const)
    equal(request[name], source[old], `S3 requested source ${name}`)
  equal((request.requestedRef as Row).value, source.base_branch, 'S3 requested base branch')
  const children = rows(current, 'task_repos', { task_id: source.id })
  const mounts = rows(target, 'task_repository_mounts', { task_id: source.id })
  equal(
    mounts.length,
    children.length || (source.worktree_path ? 1 : 0),
    'S3 workspace mount cardinality',
  )
  if (source.workgroup_config_json !== null) {
    const state = one(target, 'workgroup_task_state', { task_id: source.id })
    equal(
      state.runtime_config_json,
      source.workgroup_config_json,
      'S3 full workgroup runtime config',
    )
    equal(state.config_revision, 1, 'S3 workgroup config revision')
  }
}
function runProjection(source: Row, current: Snapshot, target: Snapshot): void {
  const run = one(target, 'node_runs', { id: source.id })
  equal(
    [run.historical_parent_id, run.attempt_index, run.generation_seq],
    [source.parent_node_run_id, source.retry_index, 0],
    'S3 NodeRun parent/retry/generation',
  )
  if (source.seq !== null) equal(run.seq, source.seq, 'S3 recorded sequence including negatives')
  // RFC-398 §11: v0.18.x PostgreSQL left lineage NULL and recorded the task path on the slot's
  // effects; that single recorded path is the lineage the old runtime used.
  const slotPaths = new Set(
    source.lineage_slot_path_json === null && typeof source.continuation_slot_key === 'string'
      ? rows(current, 'task_execution_effects', { task_id: source.task_id })
          .filter((effect) =>
            String(effect.operation_key).startsWith(`${String(source.continuation_slot_key)}:`),
          )
          .map((effect) => effect.slot_path_json)
      : [],
  )
  equal(
    run.lineage_slot_path_json,
    source.lineage_slot_path_json ?? (slotPaths.size === 1 ? [...slotPaths][0] : null),
    'S3 recorded lineage or the single legacy effect path',
  )
  for (const runtime of rows(target, 'node_run_runtime_states', { node_run_id: source.id }))
    equal(
      [runtime.session_id, runtime.isolation_root_ref],
      [source.opencode_session_id, source.iso_worktree_path],
      'S3 runtime identity',
    )
  equal(
    Boolean(run.inputs_recorded),
    source.consumed_upstream_runs_json !== null,
    'S3 recorded consumption flag',
  )
  const consumed = parse(source.consumed_upstream_runs_json, {}) as Row
  const inputRows = rows(target, 'node_run_inputs', { consumer_run_id: source.id }).sort(
    (a, b) => Number(a.ordinal) - Number(b.ordinal),
  )
  equal(inputRows.length, Object.keys(consumed).length, 'S3 consumed input count')
  for (const [i, [node, id]] of Object.entries(consumed).entries()) {
    equal(
      [
        inputRows[i]!.producer_node_id,
        inputRows[i]!.producer_run_ref,
        inputRows[i]!.ordinal,
        inputRows[i]!.input_kind,
      ],
      [node, id, i, 'frame-input'],
      'S3 actual consumed producer and order',
    )
  }
  const mounts = rows(current, 'task_repos', { task_id: source.task_id })
  for (const [scalar, mapName, column] of [
    ['pre_snapshot', 'pre_snapshot_repos_json', 'pre_snapshot'],
    ['iso_base_snapshot', 'iso_base_snapshot_repos_json', 'isolation_base'],
    ['iso_node_tree', 'iso_node_tree_repos_json', 'node_tree'],
    ['iso_submodules_json', 'iso_submodules_repos_json', 'submodules'],
  ] as const) {
    const map = parse(source[mapName], {}) as Row
    for (const mount of mounts) {
      const name = String(mount.worktree_dir_name ?? ''),
        value = Object.hasOwn(map, name) ? map[name] : mounts.length === 1 ? source[scalar] : null
      if (value == null) continue
      const targetMount = one(target, 'task_repository_mounts', {
        task_id: source.task_id,
        ordinal: mount.repo_index,
      })
      const checkpoint = one(target, 'node_run_repo_checkpoints', {
        node_run_id: source.id,
        repo_key: targetMount.repo_key,
      })
      equal(
        checkpoint[column],
        typeof value === 'string' ? value : JSON.stringify(value),
        `S3 checkpoint ${column}`,
      )
    }
  }
}

export function checkRunRestrictions(
  current: Snapshot,
  target: Snapshot,
  built: BuiltRelease,
): void {
  const source = current.get('node_runs') ?? [],
    restrictions = target.get('aw_meta_migration_history_restrictions') ?? []
  const wanted = source.filter((r) => r.envelope_nonce === null)
  const sequence = new Map<unknown, number>()
  const allocations = current.get('node_run_seq_allocations') ?? []
  const sourceHighWater = Math.max(
    0,
    ...source.map((r) => Number(r.seq ?? 0)),
    ...allocations.map((r) => Number(r.seq)),
    ...(built.before.get('sqlite_sequence') ?? [])
      .filter((r) => r.name === 'node_run_seq_allocations')
      .map((r) => Number(r.seq)),
  )
  let next = sourceHighWater
  const newAllocations: Row[] = []
  // RFC-374's approved order: task IDs, then legacy IDs; old missing rows
  // precede the existing minimum, new missing rows allocate above high water.
  for (const taskId of [...new Set(source.map((r) => String(r.task_id)))].sort()) {
    const taskRows = source.filter((r) => r.task_id === taskId)
    const recorded = taskRows.filter((r) => r.seq !== null)
    const missing = taskRows
      .filter((r) => r.seq === null)
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    for (const row of recorded) sequence.set(row.id, Number(row.seq))
    if (!recorded.length) {
      missing.forEach((row, i) => sequence.set(row.id, i - missing.length + 1))
      continue
    }
    const minimum = Math.min(...recorded.map((r) => Number(r.seq)))
    const lastId = recorded
      .map((r) => String(r.id))
      .sort()
      .at(-1)!
    const older = missing.filter((r) => String(r.id) <= lastId)
    older.forEach((row, i) => sequence.set(row.id, minimum - older.length + i))
    for (const row of missing.filter((r) => String(r.id) > lastId)) {
      sequence.set(row.id, ++next)
      const task = one(current, 'tasks', { id: row.task_id })
      newAllocations.push({
        seq: next,
        task_id: row.task_id,
        node_run_id: row.id,
        allocated_at: row.started_at ?? task.started_at,
      })
    }
  }
  equal(
    sortedRows(target.get('node_run_seq_allocations') ?? []),
    sortedRows([...allocations, ...newAllocations]),
    'S3 original/pruned allocations plus exactly the newly allocated sequences',
  )
  const expectedSlots = new Map<unknown, string>()
  // Curated release seeds contain terminal, ordinary root-frame runs only. A new
  // fixture family must extend this independent oracle instead of weakening it.
  for (const row of source) {
    const task = one(current, 'tasks', { id: row.task_id })
    invariant(
      ['done', 'failed', 'canceled'].includes(String(task.status)),
      'S1 add an explicit active-run restriction oracle',
    )
    invariant(row.container_run_id === null, 'S1 add a nested-frame restriction oracle')
    invariant(
      row.parent_node_run_id === null && row.shard_key === null,
      'S3 add a synthetic/shard run oracle',
    )
    const definition = parse(task.workflow_snapshot) as { nodes: Row[] }
    invariant(
      definition.nodes.some(
        (node) =>
          node.id === row.node_id &&
          ['agent-single', 'review', 'clarify', 'clarify-cross-agent'].includes(String(node.kind)),
      ),
      'S3 add an oracle for the new frozen node kind',
    )
    const slot = JSON.stringify(['rs1', 'node', row.node_id, null, Number(row.iteration)])
    expectedSlots.set(row.id, slot)
    const migrated = one(target, 'node_runs', { id: row.id })
    equal(
      [
        migrated.seq,
        migrated.role,
        migrated.slot_key,
        migrated.generation_seq,
        migrated.record_mode,
      ],
      [
        sequence.get(row.id),
        'node-attempt',
        slot,
        0,
        row.envelope_nonce === null ? 'history-only' : 'executable',
      ],
      'S3 independent sequence, role, canonical slot and execution mode',
    )
  }
  equal(
    restrictions.map((r) => r.node_run_id).sort(),
    wanted.map((r) => r.id).sort(),
    'S1 exact history-only run set',
  )
  const selectedIds = new Set<unknown>()
  const expectedSelections: Row[] = []
  // Frozen legacy mint order is independent of the conversion implementation.
  for (const task of current.get('tasks') ?? []) {
    const generation = one(target, 'task_execution_generations', {
      task_id: task.id,
      generation_seq: 0,
    })
    equal(
      [generation.cause, generation.previous_generation_seq, generation.operation_ref],
      ['legacy-epoch1', null, null],
      'S3 initial execution generation',
    )
    const sourceRuns = source.filter((r) => r.task_id === task.id)
    const families = new Map<string, Row[]>()
    for (const run of sourceRuns) {
      const key = JSON.stringify([run.node_id, run.container_run_id, run.iteration, run.shard_key])
      const list = families.get(key) ?? []
      list.push(run)
      families.set(key, list)
    }
    for (const family of families.values()) {
      family.sort((a, b) =>
        compareNodeRunMintOrder(
          { id: String(a.id), seq: sequence.get(a.id)! },
          { id: String(b.id), seq: sequence.get(b.id)! },
        ),
      )
      const newest = family.at(-1)!
      selectedIds.add(newest.id)
      expectedSelections.push({
        task_id: task.id,
        slot_key: expectedSlots.get(newest.id),
        selected_run_id: newest.id,
        revision: 1,
        generation_seq: 0,
        cause: 'legacy-epoch1',
        selected_at: newest.started_at ?? task.started_at,
      })
    }
  }
  equal(
    sortedRows(target.get('node_run_selections') ?? []),
    sortedRows(expectedSelections),
    'S3 complete frozen selection oracle, including terminal history selections',
  )
  for (const restriction of restrictions) {
    const expectedFields = [
      'envelope_nonce',
      ...(selectedIds.has(restriction.node_run_id) ? ['slot_key', 'selected_run_id'] : []),
    ]
    equal(
      (parse(restriction.missing_fields_json) as string[]).sort(),
      expectedFields.sort(),
      'S1 exact restriction fields',
    )
    const sourceRow = one(current, 'node_runs', { id: restriction.node_run_id })
    const task = one(current, 'tasks', { id: sourceRow.task_id })
    equal(
      restriction.execution,
      task.status === 'done' ? 'terminal-history' : 'retryable-history',
      'S1 terminal execution restriction',
    )
  }
  const highWater = (target.get('aw_meta_migration_records') ?? [])
    .map((r) => JSON.parse(String(r.record_json)) as Row)
    .filter((r) => r.kind === 'identity-high-water' && r.table === 'node_run_seq_allocations')
  invariant(
    highWater.some((r) => Number(r.value) >= next),
    'S3 allocation high water was lowered',
  )
}

export function checkProjections(
  entry: OracleEntry,
  source: Row,
  current: Snapshot,
  target: Snapshot,
  built: BuiltRelease,
  key: string,
): void {
  if (!entry.projections?.length) return
  switch (entry.table) {
    case 'scheduled_tasks': {
      const migrated = one(target, entry.table, { id: source.id })
      const payload = parse(source.launch_payload) as Row
      invariant(typeof payload.repoPath === 'string', 'S3 fixture schedule local path')
      invariant(!existsSync(payload.repoPath), 'S3 fixture local repository is historically absent')
      equal(
        [Boolean(migrated.enabled), migrated.last_error, migrated.next_run_at, migrated.updated_at],
        [false, `rfc165-local-path-retired: ${payload.repoPath}`, null, UPGRADE_TIME],
        'S3 released schedule retirement',
      )
      return
    }
    case 'skills': {
      const migrated = one(target, entry.table, { id: source.id })
      const initial = rows(current, 'skill_versions', { skill_id: source.id }).length === 0
      equal(
        [migrated.content_version, migrated.version_state, migrated.updated_at],
        initial
          ? [1, 'snapshot-authoritative', UPGRADE_TIME]
          : [source.content_version, source.version_state, source.updated_at],
        'S3 released skill initial-version backfill',
      )
      if (initial) {
        const versions = rows(target, 'skill_versions', { skill_id: source.id })
        equal(versions.length, 1, 'S3 exactly one initial skill snapshot')
        equal(
          [versions[0]!.version_index, versions[0]!.source, versions[0]!.created_at],
          [1, 'initial', UPGRADE_TIME],
          'S3 initial skill snapshot identity',
        )
      }
      content(source, entry, current, target, built, key)
      return
    }
    case 'cached_repos': {
      const migrated = one(target, 'cached_repos', { id: source.id })
      const escrow = 'aw-legacy-url-hex-v1:'
      if (
        typeof source.url_enc === 'string' &&
        (source.url_enc.startsWith(escrow) || source.url_redacted === null)
      ) {
        const box = createSecretBoxFromKey(readFileSync(join(built.home, 'secret.key')))
        const plain = source.url_enc.startsWith(escrow)
          ? Buffer.from(source.url_enc.slice(escrow.length), 'hex').toString('utf8')
          : box.unseal(source.url_enc)
        equal(box.unseal(String(migrated.url_enc)), plain, 'S3 repository URL exact plaintext')
        equal(migrated.url_redacted, redactGitUrl(plain), 'S3 repository URL display')
      } else {
        equal(migrated.url_enc, source.url_enc, 'S3 unchanged repository URL encoding')
        equal(migrated.url_redacted, source.url_redacted, 'S3 unchanged repository URL display')
      }
      return
    }
    case 'resource_bundle_applies':
    case 'intent_apply_journal': {
      const migrated = one(target, entry.table, { id: source.id })
      // The ledger's released journal has no staged filesystem artifacts. The
      // target wraps that exact empty list in the approved AtomicApply codec.
      equal(parse(source.prepared_artifacts_json), [], 'S3 fixture bundle artifact facts')
      equal(
        parse(migrated.prepared_artifacts_json),
        {
          scene: entry.table === 'resource_bundle_applies' ? 'resource-package' : 'intent',
          version: entry.table === 'resource_bundle_applies' ? 2 : 3,
          artifacts: [],
        },
        'S3 bundle artifact envelope',
      )
      return
    }
    case 'agents':
      agentReferences(source, current, target)
      return
    case 'clarify_rounds':
      clarify(source, target)
      return
    case 'tasks':
      taskProjection(source, current, target)
      return
    case 'node_runs':
      runProjection(source, current, target)
      content(source, entry, current, target, built, key)
      return
    case 'task_repos': {
      const mount = one(target, 'task_repository_mounts', {
        task_id: source.task_id,
        ordinal: source.repo_index,
      })
      equal(mount.mount_path, source.worktree_dir_name, 'S3 mount identity')
      for (const column of ['branch', 'base_branch', 'base_commit'])
        equal(mount[column], source[column], `S3 repository ${column}`)
      return
    }
    case 'workgroup_task_state': {
      const task = one(current, 'tasks', { id: source.task_id }),
        state = one(target, 'workgroup_task_state', { task_id: source.task_id })
      equal(
        [state.runtime_config_json, state.config_revision],
        [task.workgroup_config_json, 1],
        'S3 current workgroup config',
      )
      return
    }
    case 'committed_event_family_cutovers':
      equal(source.mode, 'dispatchable', 'S3 dispatchable event families')
      return
    case 'node_run_seq_allocations':
      one(target, 'node_run_seq_allocations', { seq: source.seq })
      return
    case 'workflows': {
      const definition = parse(source.definition) as Row
      const expected: Row[] = []
      const nodes = (definition.nodes ?? []) as Row[]
      for (const [index, node] of nodes.entries())
        for (const [field, resource, selector] of [
          ['agentId', 'agent', 'id'],
          ['workflowName', 'workflow', 'name'],
          ['workgroupName', 'workgroup', 'name'],
        ] as const) {
          if (field === 'workflowName' && node.kind !== 'call-workflow') continue
          if (field === 'workgroupName' && node.kind !== 'call-workgroup') continue
          if (typeof node[field] !== 'string') continue
          expected.push({
            reference_path: `nodes[${index}].${field}`,
            resource_kind: resource,
            selector_kind: selector,
            selector_value: node[field],
            namespace_json: JSON.stringify({
              version: 2,
              resourceType: resource,
              referenceKind: field,
              nodeKind: node.kind ?? null,
            }),
          })
        }
      const actual = rows(target, 'workflow_dependency_index', {
        workflow_id: source.id,
        revision: source.version,
      })
      equal(
        sortedRows(
          actual.map((r) =>
            Object.fromEntries(
              [
                'reference_path',
                'resource_kind',
                'selector_kind',
                'selector_value',
                'namespace_json',
              ].map((k) => [k, r[k]]),
            ),
          ),
        ),
        sortedRows(expected),
        'S3 all definition dependency selectors',
      )
      return
    }
    default:
      if (entry.projections.every((p) => p.sourceColumns.length === 0)) return // Exact payload columns checked by the caller.
      invariant(
        entry.projections.some((p) => p.codec === 'content-bytes@1') ||
          entry.table === 'hosted_object_publications',
        `unimplemented oracle projection ${entry.table}`,
      )
      content(source, entry, current, target, built, key)
  }
}
