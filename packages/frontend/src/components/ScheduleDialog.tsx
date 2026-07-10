// RFC-159 — "Save as scheduled task" dialog. Reuses the launch form's already-built
// StartTask body (passed as `buildLaunchPayload`) and only collects the schedule:
// a name + one of interval / daily / weekly / monthly, in the creator's timezone.
import type { ScheduledLaunchKind, ScheduleSpec } from '@agent-workflow/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, NumberInput, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { describeApiError } from '@/i18n'
import { nextRuns } from '@/lib/schedule-view'

type Kind = ScheduleSpec['kind']
type Unit = 'minutes' | 'hours' | 'days'

const CREATOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

interface ScheduleDialogProps {
  open: boolean
  onClose: () => void
  /**
   * Create mode — returns the current launch form's StartTask body (opaque JSON;
   * backend validates). Ignored (and unnecessary) in edit mode.
   */
  buildLaunchPayload?: () => unknown
  /**
   * RFC-165 §9b — which execution kind `buildLaunchPayload` composes. Stamped
   * as `launchKind` on the created schedule (immutable afterwards). Create
   * mode only; defaults to the workflow arm.
   */
  launchKind?: ScheduledLaunchKind
  defaultName?: string
  /**
   * Edit mode — pre-fill from an existing schedule and PUT { name, scheduleSpec }
   * instead of POST. `launchPayload` (the task config) is left untouched here; it
   * is edited from the launch form. Render this dialog conditionally (mount on open)
   * so the form re-initializes from the latest values each time.
   */
  edit?: { id: string; name: string; scheduleSpec: ScheduleSpec }
}

interface FormState {
  kind: Kind
  every: number | undefined
  unit: Unit
  at: string
  daysOfWeek: number[]
  dayOfMonth: number | undefined
}

const DEFAULT_STATE: FormState = {
  kind: 'daily',
  every: 6,
  unit: 'hours',
  at: '09:00',
  daysOfWeek: [1],
  dayOfMonth: 1,
}

/** Existing ScheduleSpec → dialog form fields (inverse of buildSpec). */
function specToState(spec: ScheduleSpec): FormState {
  switch (spec.kind) {
    case 'interval':
      return { ...DEFAULT_STATE, kind: 'interval', every: spec.every, unit: spec.unit }
    case 'daily':
      return { ...DEFAULT_STATE, kind: 'daily', at: spec.at }
    case 'weekly':
      return { ...DEFAULT_STATE, kind: 'weekly', at: spec.at, daysOfWeek: spec.daysOfWeek }
    case 'monthly':
      return { ...DEFAULT_STATE, kind: 'monthly', at: spec.at, dayOfMonth: spec.dayOfMonth }
  }
}

function buildSpec(
  kind: Kind,
  every: number,
  unit: Unit,
  at: string,
  daysOfWeek: number[],
  dayOfMonth: number,
): ScheduleSpec {
  if (kind === 'interval') return { kind: 'interval', every, unit }
  if (kind === 'daily') return { kind: 'daily', at, timezone: CREATOR_TZ }
  if (kind === 'weekly') return { kind: 'weekly', daysOfWeek, at, timezone: CREATOR_TZ }
  return { kind: 'monthly', dayOfMonth, at, timezone: CREATOR_TZ }
}

function fmtPreview(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ScheduleDialog({
  open,
  onClose,
  buildLaunchPayload,
  launchKind,
  defaultName,
  edit,
}: ScheduleDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const init = edit ? specToState(edit.scheduleSpec) : DEFAULT_STATE
  const [name, setName] = useState(edit?.name ?? defaultName ?? '')
  const [kind, setKind] = useState<Kind>(init.kind)
  const [every, setEvery] = useState<number | undefined>(init.every)
  const [unit, setUnit] = useState<Unit>(init.unit)
  const [at, setAt] = useState(init.at)
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(init.daysOfWeek)
  const [dayOfMonth, setDayOfMonth] = useState<number | undefined>(init.dayOfMonth)

  const spec = useMemo<ScheduleSpec | null>(() => {
    try {
      if (kind === 'interval' && (every === undefined || every < 1)) return null
      if (kind === 'monthly' && (dayOfMonth === undefined || dayOfMonth < 1 || dayOfMonth > 31))
        return null
      if (kind === 'weekly' && daysOfWeek.length === 0) return null
      return buildSpec(kind, every ?? 1, unit, at, daysOfWeek, dayOfMonth ?? 1)
    } catch {
      return null
    }
  }, [kind, every, unit, at, daysOfWeek, dayOfMonth])

  const preview = useMemo(() => {
    if (spec === null) return []
    try {
      return nextRuns(spec, Date.now(), 3)
    } catch {
      return []
    }
  }, [spec])

  const save = useMutation<{ id: string }, ApiError>({
    mutationFn: () =>
      edit
        ? api.put(`/api/scheduled-tasks/${encodeURIComponent(edit.id)}`, {
            name: name.trim(),
            scheduleSpec: spec,
          })
        : api.post('/api/scheduled-tasks', {
            name: name.trim(),
            launchKind: launchKind ?? 'workflow',
            launchPayload: buildLaunchPayload?.(),
            scheduleSpec: spec,
            enabled: true,
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      onClose()
      // Create lands on the list; edit stays on the detail page it was opened from.
      if (edit === undefined) void navigate({ to: '/scheduled' })
    },
  })

  const canSave = name.trim().length > 0 && spec !== null && !save.isPending
  const toggleDay = (d: number) =>
    setDaysOfWeek((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b),
    )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t(edit ? 'scheduled.editTitle' : 'scheduled.dialogTitle')}
      size="md"
      data-testid="schedule-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('scheduled.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={() => save.mutate()}
            data-testid="schedule-save"
          >
            {save.isPending ? t('scheduled.saving') : t('scheduled.save')}
          </button>
        </>
      }
    >
      <Field label={t('scheduled.fieldName')} required>
        <TextInput value={name} onChange={setName} maxLength={255} data-testid="schedule-name" />
      </Field>

      <Field label={t('scheduled.fieldMode')} group>
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          ariaLabel={t('scheduled.fieldMode')}
          testidPrefix="schedule-kind"
          options={[
            { value: 'interval', label: t('scheduled.modeInterval') },
            { value: 'daily', label: t('scheduled.modeDaily') },
            { value: 'weekly', label: t('scheduled.modeWeekly') },
            { value: 'monthly', label: t('scheduled.modeMonthly') },
          ]}
        />
      </Field>

      {kind === 'interval' && (
        <div className="schedule-dialog__row">
          <Field label={t('scheduled.fieldEvery')}>
            <NumberInput
              value={every}
              onChange={setEvery}
              min={1}
              max={1000}
              data-testid="schedule-every"
            />
          </Field>
          <Field label={t('scheduled.fieldUnit')}>
            <Select<Unit>
              value={unit}
              onChange={setUnit}
              options={[
                { value: 'minutes', label: t('scheduled.unitMinutes') },
                { value: 'hours', label: t('scheduled.unitHours') },
                { value: 'days', label: t('scheduled.unitDays') },
              ]}
            />
          </Field>
        </div>
      )}

      {kind !== 'interval' && (
        <Field label={t('scheduled.fieldAt')} hint={t('scheduled.tzNote', { tz: CREATOR_TZ })}>
          <TextInput
            value={at}
            onChange={setAt}
            type="text"
            pattern="^([01]\d|2[0-3]):[0-5]\d$"
            data-testid="schedule-at"
          />
        </Field>
      )}

      {kind === 'weekly' && (
        <Field label={t('scheduled.fieldDays')} group>
          <div className="schedule-dialog__days" role="group" aria-label={t('scheduled.fieldDays')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <button
                key={d}
                type="button"
                className={`btn btn--sm${daysOfWeek.includes(d) ? ' btn--primary' : ''}`}
                aria-pressed={daysOfWeek.includes(d)}
                onClick={() => toggleDay(d)}
                data-testid={`schedule-dow-${d}`}
              >
                {t(`scheduled.dow.${d}`)}
              </button>
            ))}
          </div>
        </Field>
      )}

      {kind === 'monthly' && (
        <Field label={t('scheduled.fieldDayOfMonth')} hint={t('scheduled.dayOfMonthHint')}>
          <NumberInput
            value={dayOfMonth}
            onChange={setDayOfMonth}
            min={1}
            max={31}
            data-testid="schedule-dom"
          />
        </Field>
      )}

      <div className="schedule-dialog__preview" data-testid="schedule-preview">
        <span className="schedule-dialog__preview-label">{t('scheduled.preview')}</span>
        {preview.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <ul>
            {preview.map((e) => (
              <li key={e}>{fmtPreview(e)}</li>
            ))}
          </ul>
        )}
      </div>

      {save.error != null && <div className="error-box">{describeApiError(save.error)}</div>}
    </Dialog>
  )
}
