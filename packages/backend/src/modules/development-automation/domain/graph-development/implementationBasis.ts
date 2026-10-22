import {
  canonicalJson,
  type GraphDesignDocument,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
import { graphScopeContentRefs, graphDigest, validateGraphDocument } from './model'
import { renderGraphModel } from './renderViews'

export function createGraphImplementationBasis(input: {
  readonly id: string
  readonly document: GraphDesignDocument
  readonly includedElementIds: readonly string[]
  readonly createdAt: number
}): GraphImplementationBasis {
  const { document } = input
  const issues = validateGraphDocument(document)
  if (issues.length) throw new Error(`graph-baseline-invalid:${canonicalJson(issues)}`)
  if (!document.repositoryBaseline) throw new Error('graph-baseline-repository-unresolved')
  const included = new Set(input.includedElementIds)
  if (!included.size) throw new Error('graph-baseline-empty-scope')
  for (const id of included)
    if (!document.elements.some((item) => item.id === id))
      throw new Error(`graph-baseline-unknown-element:${id}`)
  for (const concern of document.concerns) {
    if (concern.priority === 'required' && concern.disposition === 'open')
      throw new Error(`graph-baseline-unresolved-concern:${concern.id}`)
  }
  const obligations = document.obligations.filter((item) =>
    item.elementIds.some((id) => included.has(id)),
  )
  for (const element of document.elements.filter(
    (item) => included.has(item.id) && item.kind === 'requirement',
  )) {
    if (!obligations.some((item) => item.elementIds.includes(element.id)))
      throw new Error(`graph-baseline-missing-obligation:${element.id}`)
  }
  for (const obligation of obligations)
    if (obligation.verification.kind === 'unassigned')
      throw new Error(`graph-baseline-verification-unassigned:${obligation.id}`)
  const excludedElementIds = document.elements
    .filter((item) => !included.has(item.id))
    .map((item) => item.id)
    .sort()
  const basisContent = {
    schemaVersion: 1,
    designId: document.id,
    revision: document.revision,
    includedElementIds: [...included].sort(),
    excludedElementIds,
    document,
  }
  const contentFiles = [
    { path: 'design.json', mediaType: 'application/json', content: canonicalJson(basisContent) },
    { path: 'acceptance.json', mediaType: 'application/json', content: canonicalJson(obligations) },
    {
      path: 'implementation.md',
      mediaType: 'text/markdown',
      content: [
        `# ${document.title}`,
        '',
        `Design: ${document.id} / revision ${document.revision}`,
        '',
        'Implement only the included scope. Preserve the original human answers, provisional judgments and unknowns below.',
        `Included: ${[...included].sort().join(', ')}`,
        `Excluded: ${excludedElementIds.join(', ') || '(none)'}`,
        '',
        '## Requirements and design',
        ...document.elements
          .filter((item) => included.has(item.id))
          .map(
            (item) =>
              `- ${item.id}: ${item.label}\n  ${item.description}${item.kind === 'assumption' ? `\n  Conditional on: ${item.condition}\n  Unknown: ${item.unknowns}` : ''}`,
          ),
        '',
        '## Complete frozen semantics',
        'The following exact values are part of this review. Dependencies outside Included are context only and must not expand implementation scope.',
        '```json',
        JSON.stringify(
          {
            goals: document.goals,
            concerns: document.concerns,
            sources: document.sources,
            elements: document.elements,
            relations: document.relations,
            models: document.models,
            views: document.views,
            repositoryBaseline: document.repositoryBaseline,
          },
          null,
          2,
        ),
        '```',
        '',
        '## Original human input',
        ...document.sources
          .filter((source) => source.kind === 'clarify')
          .map(
            (source) =>
              `- ${source.roundId}/${source.questionId}: ${JSON.stringify(source.originalAnswer)}\n  User notes: ${canonicalJson(source.decision ?? {})}`,
          ),
        '',
        '## Acceptance obligations',
        ...obligations.map(
          (item) =>
            `- ${item.id}: ${item.statement}\n  Arrangement: ${canonicalJson(item.verification)}`,
        ),
        '',
        'Generate complete code and tests before executing the planned checks. A graph, a trace link or a model statement is not an execution receipt.',
        '',
      ].join('\n'),
    },
    ...document.models.map((model, index) => {
      const rendered = renderGraphModel(document, model)
      return {
        path: `views/${index + 1}-${model.kind}.${rendered.format === 'mermaid' ? 'mmd' : 'md'}`,
        mediaType: rendered.format === 'mermaid' ? 'text/vnd.mermaid' : 'text/markdown',
        content: rendered.source,
      }
    }),
  ]
  const files = contentFiles.map((file) => ({ ...file, digest: graphDigest(file.content) }))
  const manifest = canonicalJson({
    schemaVersion: 1,
    designDigest: graphDigest(document),
    files: files.map(({ path, digest, mediaType }) => ({ path, digest, mediaType })),
  })
  files.push({
    path: 'manifest.json',
    mediaType: 'application/json',
    content: manifest,
    digest: graphDigest(manifest),
  })
  return {
    schemaVersion: 1,
    id: input.id,
    designRef: { id: document.id, revision: document.revision, digest: graphDigest(document) },
    document,
    includedElementIds: [...included].sort(),
    excludedElementIds,
    obligationIds: obligations.map((item) => item.id),
    readSet: graphScopeContentRefs(document, [...included]),
    toolContractVersion: 1,
    files,
    digest: graphDigest(files),
    createdAt: input.createdAt,
  }
}
