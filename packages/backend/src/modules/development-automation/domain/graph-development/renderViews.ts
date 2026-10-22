import { canonicalJson, type GraphDesignDocument, type GraphSubmodel } from '@agent-workflow/shared'
import { graphDigest } from './model'

export interface RenderedGraphModel {
  readonly format: 'mermaid' | 'markdown'
  readonly source: string
  readonly elementIndex: readonly {
    readonly renderId: string
    readonly elementId: string
    readonly label: string
  }[]
}

export function renderGraphModel(
  document: GraphDesignDocument,
  model: GraphSubmodel,
): RenderedGraphModel {
  const elements = new Map(document.elements.map((item) => [item.id, item]))
  const relations = new Map(document.relations.map((item) => [item.id, item]))
  const renderId = (id: string): string => `g${graphDigest(id).slice(0, 16)}`
  const label = (id: string): string => elements.get(id)?.label ?? id
  const line = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/;/g, '；')
  const quote = (value: string): string => JSON.stringify(line(value).replace(/"/g, '＂'))
  const indexIds = new Set<string>()
  const node = (id: string): string => {
    indexIds.add(id)
    return renderId(id)
  }
  let format: RenderedGraphModel['format'] = 'mermaid'
  let source: string
  switch (model.kind) {
    case 'flow': {
      const nodes = model.elementIds.map((id) => `  ${node(id)}[${quote(label(id))}]`)
      const edges = model.relationIds.flatMap((id) => {
        const relation = relations.get(id)
        return relation
          ? [`  ${node(relation.from)} -->|${quote(relation.label)}| ${node(relation.to)}`]
          : []
      })
      source = ['flowchart TD', ...nodes, ...edges].join('\n')
      break
    }
    case 'sequence': {
      const messages = new Map(
        model.messageIds.map((id) => {
          const relation = relations.get(id)
          return [
            id,
            relation
              ? `  ${node(relation.from)}->>${node(relation.to)}: ${line(relation.label)}`
              : '',
          ]
        }),
      )
      const participants = model.participantIds.map(
        (id) => `  participant ${node(id)} as ${line(label(id))}`,
      )
      const body: string[] = []
      const starts = new Map(model.fragments.map((fragment) => [fragment.messageIds[0], fragment]))
      for (let i = 0; i < model.messageIds.length; i++) {
        const id = model.messageIds[i]!
        const fragment = starts.get(id)
        if (!fragment) {
          body.push(messages.get(id) ?? '')
          continue
        }
        const head = {
          parallel: 'par',
          alternative: 'alt',
          loop: 'loop',
          sequence: 'rect rgb(245,245,245)',
        }[fragment.kind]
        body.push(`  ${head}${fragment.kind === 'sequence' ? '' : ` ${line(fragment.condition)}`}`)
        fragment.messageIds.forEach((messageId, index) => {
          if (index > 0 && fragment.kind === 'parallel')
            body.push(`  and ${line(relations.get(messageId)?.condition ?? 'parallel')}`)
          if (index > 0 && fragment.kind === 'alternative')
            body.push(`  else ${line(relations.get(messageId)?.condition ?? 'alternative')}`)
          body.push(messages.get(messageId) ?? '')
        })
        body.push('  end')
        i += fragment.messageIds.length - 1
      }
      source = ['sequenceDiagram', ...participants, ...body].join('\n')
      break
    }
    case 'state':
      source = [
        'stateDiagram-v2',
        ...model.stateIds.map((id) => `  state ${quote(label(id))} as ${node(id)}`),
        `  [*] --> ${node(model.initialStateId)}`,
        ...model.transitions.flatMap((transition) => {
          const relation = relations.get(transition.relationId)
          return relation
            ? [
                `  ${node(relation.from)} --> ${node(relation.to)}: ${line(transition.event)}${relation.condition ? ` [${line(relation.condition)}]` : ''}`,
              ]
            : []
        }),
        ...model.terminalStateIds.map((id) => `  ${node(id)} --> [*]`),
      ].join('\n')
      break
    case 'data': {
      const entities = model.entityIds.flatMap((id) => {
        const entity = elements.get(id)
        if (entity?.kind !== 'entity') return []
        return [
          `  ${node(id)}[${quote(entity.label)}] {`,
          ...entity.fields.map(
            (field) =>
              `    ${field.type.replace(/[^a-zA-Z0-9_]/g, '_') || 'value'} ${field.name.replace(/[^a-zA-Z0-9_]/g, '_') || 'field'}${field.key === 'primary' ? ' PK' : field.key === 'foreign' ? ' FK' : ''}`,
          ),
          '  }',
        ]
      })
      source = [
        'erDiagram',
        ...entities,
        ...model.relationships.flatMap((item) => {
          const relation = relations.get(item.relationId)
          if (!relation) return []
          const cardinality = {
            'one-one': '||--||',
            'one-many': item.required ? '||--|{' : '||--o{',
            'many-many': '}o--o{',
          }[item.cardinality]
          return [
            `  ${node(relation.from)} ${cardinality} ${node(relation.to)} : ${quote(relation.label)}`,
          ]
        }),
      ].join('\n')
      break
    }
    case 'decision-table': {
      format = 'markdown'
      const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
      source = [
        '| 规则 | 条件 | 结果 | 优先级 |',
        '| --- | --- | --- | --- |',
        ...model.rows.map((row) => {
          node(row.ruleId)
          return `| ${cell(label(row.ruleId))} | ${cell(row.conditions.map((condition) => `${condition.field} ${condition.operator} ${canonicalJson(condition.value ?? null)}`).join(' ∧ '))} | ${cell(canonicalJson(row.output))} | ${row.priority} |`
        }),
      ].join('\n')
      break
    }
  }
  return {
    format,
    source,
    elementIndex: [...indexIds].map((id) => ({
      renderId: renderId(id),
      elementId: id,
      label: label(id),
    })),
  }
}
