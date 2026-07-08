// Prompt-template `{{ref}}` diagnostics for the agent inspector — moved out
// of NodeInspector.tsx by RFC-146 T3 (they belong to the agent-single Edit
// component's concern, not the drawer shell).

import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'

/**
 * Lists `{{xxx}}` placeholders in the prompt template that don't have a
 * matching input port (i.e., no inbound edge with that target.portName).
 * Mirror of the P-2-01 backend validator's "template ref missing" rule,
 * surfaced at edit time so users can self-debug before launching.
 *
 * Built-in meta tokens (e.g., `__repo_path__`) are always available at
 * runtime, so we exclude any name starting with `__`.
 *
 * Exported for unit tests.
 */
export function extractMissingRefs(template: string, inputPorts: string[]): string[] {
  const re = /\{\{(\w+)\}\}/g
  const refs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const name = m[1]
    if (name === undefined || name.startsWith('__')) continue
    refs.add(name)
  }
  const have = new Set(inputPorts)
  return [...refs].filter((r) => !have.has(r))
}

export function MissingRefList({
  template,
  inputPorts,
}: {
  template: string
  inputPorts: string[]
}) {
  const { t } = useTranslation()
  const missing = extractMissingRefs(template, inputPorts)
  if (missing.length === 0) return null
  return (
    <div className="inspector__port-refs inspector__port-refs--missing">
      <span className="muted">{t('inspector.missingRefsLabel')}</span>{' '}
      <ChipsInput value={missing} onChange={() => {}} placeholder="" />
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {t('inspector.missingRefsHint')}
      </p>
    </div>
  )
}

export function PortRefList({ ports }: { ports: string[] }) {
  const { t } = useTranslation()
  if (ports.length === 0) return null
  return (
    <div className="inspector__port-refs">
      <span className="muted">{t('inspector.resolvedInbound')}</span>{' '}
      <ChipsInput value={ports} onChange={() => {}} placeholder="" />
    </div>
  )
}
