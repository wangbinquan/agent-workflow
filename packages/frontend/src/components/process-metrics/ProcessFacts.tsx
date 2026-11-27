// RFC-616 §11 — the facts of one selected node or work item, as a definition list.
import { EmptyState } from '@/components/EmptyState'

export interface ProcessFact {
  readonly key: string
  readonly label: string
  readonly value: string
}

export function ProcessFacts(props: { facts: readonly ProcessFact[]; empty: string }) {
  if (props.facts.length === 0) return <EmptyState size="compact" title={props.empty} />
  return (
    <dl className="process-facts">
      {props.facts.map((fact) => (
        <div key={fact.key}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
