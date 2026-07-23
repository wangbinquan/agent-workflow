// RFC-002 → RFC-173 T3 → RFC-223 (PR-1) — skill picker over <MultiSelect>.
//
// RFC-223: `agents.skills` is a typed union (AgentSkillRef): a `managed` ref
// points at a DB skill by id; a `project` ref names a repo-local self-discovered
// skill (RFC-178, no DB row). This wrapper adapts that union to MultiSelect's
// `string[]` via a prefixed token encoding (`managed:<id>` / `project:<name>`)
// so the tag / dropdown still show the friendly skill name:
//   - managed options come from /api/skills, value = `managed:<skill.id>`;
//   - typing a free-text name commits it as a `project` ref (custom → project);
//   - already-selected refs are synthesized as checked options so their tags
//     render a name, not the raw token.
// Falls back to plain free-text when the list fails to load.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSkillRef, Skill } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import { MultiSelect, type MultiSelectOption } from './MultiSelect'

export const SKILLS_QUERY_KEY = ['skills'] as const

const MANAGED_PREFIX = 'managed:'
const PROJECT_PREFIX = 'project:'

/** AgentSkillRef → MultiSelect token. */
export function encodeSkillRef(ref: AgentSkillRef): string {
  return ref.kind === 'managed' ? MANAGED_PREFIX + ref.skillId : PROJECT_PREFIX + ref.name
}

/** MultiSelect token → AgentSkillRef. An un-prefixed token is a free-text
 *  (custom) commit → a repo-local `project` skill. */
export function decodeSkillToken(token: string): AgentSkillRef {
  if (token.startsWith(MANAGED_PREFIX)) {
    return { kind: 'managed', skillId: token.slice(MANAGED_PREFIX.length) }
  }
  if (token.startsWith(PROJECT_PREFIX)) {
    return { kind: 'project', name: token.slice(PROJECT_PREFIX.length) }
  }
  return { kind: 'project', name: token }
}

interface Props {
  value: AgentSkillRef[]
  onChange: (next: AgentSkillRef[]) => void
  placeholder?: string
}

export function SkillsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Skill[]>({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  const owners = useUserLookup((list.data ?? []).map((skill) => skill.ownerUserId))

  const tokens = useMemo(() => value.map(encodeSkillRef), [value])

  const options = useMemo<MultiSelectOption[]>(() => {
    const out: MultiSelectOption[] = []
    const seen = new Set<string>()
    for (const s of list.data ?? []) {
      const v = MANAGED_PREFIX + s.id
      if (seen.has(v)) continue
      seen.add(v)
      out.push({
        value: v,
        label: resourceOptionLabel(
          s.name,
          owners.get(s.ownerUserId)?.displayName ?? s.ownerUserId ?? undefined,
        ),
        description: s.description || undefined,
      })
    }
    // Synthesize a checked row for any currently-selected ref not covered by the
    // list (every project ref, plus a managed ref whose skill isn't visible) so
    // its tag renders a name rather than the raw token.
    for (const ref of value) {
      const v = encodeSkillRef(ref)
      if (seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: ref.kind === 'project' ? ref.name : ref.skillId })
    }
    return out
  }, [list.data, value, owners])

  const failed = list.error !== null && list.error !== undefined

  return (
    <div>
      <MultiSelect
        value={tokens}
        onChange={(next) => onChange(next.map(decodeSkillToken))}
        options={options}
        ariaLabel={t('agentForm.fieldSkills')}
        placeholder={placeholder}
        searchable
        // Free-text (a repo-local project skill name, or a forward-reference
        // while the list is down) commits as a project ref.
        allowCustom
        loading={list.isLoading}
        loadingLabel={t('agentForm.skillsPickerLoading')}
        emptyLabel={t('agentForm.skillsPickerEmpty')}
      />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.skillsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
