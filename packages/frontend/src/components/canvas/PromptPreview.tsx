// Live preview of the prompt sent to opencode for one node. Uses the
// shared renderUserPrompt() so what the user sees here matches what the
// runner builds at run time.
//
// Users edit mock port values in a small form; the preview re-renders
// on every keystroke. Builtin meta uses placeholders since the editor
// has no real task to bind to.

import { renderUserPrompt, type AgentOutputKindsMap } from '@agent-workflow/shared'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TextArea } from '@/components/Form'

interface Props {
  /** Prompt template currently bound to the node. */
  template: string
  /** Input port names declared by inbound edges (for the form). */
  inputPorts: string[]
  /** Output ports the agent declares (drives the protocol block). */
  outputs: string[]
  /**
   * Per-port `outputKinds` map from the agent. Optional — when any entry is
   * `markdown_file`, the rendered protocol block calls out the file-first
   * rule. Threading this through keeps the editor preview byte-for-byte
   * aligned with what the runner sends opencode.
   */
  outputKinds?: AgentOutputKindsMap
}

const DEFAULT_PLACEHOLDER = '<sample content>'

export function PromptPreview({ template, inputPorts, outputs, outputKinds }: Props) {
  const { t } = useTranslation()
  const [inputs, setInputs] = useState<Record<string, string>>(() => seedInputs(inputPorts))

  // Re-seed whenever the port set changes — but preserve any values the
  // user already typed.
  useMemo(() => {
    setInputs((prev) => {
      const next: Record<string, string> = {}
      for (const p of inputPorts) next[p] = prev[p] ?? DEFAULT_PLACEHOLDER
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputPorts.join('|')])

  const rendered = useMemo(
    () =>
      renderUserPrompt({
        promptTemplate: template,
        inputs,
        meta: {
          repoPath: '<task.worktreePath>',
          baseBranch: '<task.baseBranch>',
          taskId: '<task.id>',
        },
        agentOutputs: outputs,
        ...(outputKinds !== undefined ? { agentOutputKinds: outputKinds } : {}),
      }),
    [template, inputs, outputs, outputKinds],
  )

  return (
    <div className="prompt-preview">
      <div className="prompt-preview__inputs">
        <div className="prompt-preview__title">{t('promptPreview.mockTitle')}</div>
        {inputPorts.length === 0 ? (
          <div className="muted">{t('promptPreview.noPorts')}</div>
        ) : (
          inputPorts.map((p) => (
            <label key={p} className="prompt-preview__field">
              <span className="prompt-preview__port-name">{p}</span>
              <TextArea
                value={inputs[p] ?? ''}
                onChange={(value) => setInputs((prev) => ({ ...prev, [p]: value }))}
                rows={2}
                monospace
              />
            </label>
          ))
        )}
      </div>
      <div className="prompt-preview__output">
        <div className="prompt-preview__title">{t('promptPreview.assembledTitle')}</div>
        <pre className="prompt-preview__pre">{rendered}</pre>
      </div>
    </div>
  )
}

function seedInputs(ports: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of ports) out[p] = DEFAULT_PLACEHOLDER
  return out
}
