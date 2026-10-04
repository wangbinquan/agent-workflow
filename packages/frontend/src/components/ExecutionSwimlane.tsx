import type { ReactNode } from 'react'
import { TableViewport } from './TableViewport'
import './ExecutionSwimlane.css'

export interface ExecutionSwimlaneRow {
  readonly id: string
  readonly label: ReactNode
  readonly start: number | null
  readonly end: number | null
  readonly description: string
  readonly detail: ReactNode
  readonly point?: boolean
  readonly open?: boolean
}
/** One shared, keyboard-selectable time axis. Text details remain available without the bars. */
export function ExecutionSwimlane(props: {
  readonly label: string
  readonly rowHeading: string
  readonly timeHeading: string
  readonly unknownLabel: string
  readonly from: number
  readonly to: number
  readonly rows: readonly ExecutionSwimlaneRow[]
  readonly onSelect: (id: string, trigger: HTMLButtonElement) => void
}) {
  const width = Math.max(1, props.to - props.from)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const hasKnownTime = props.rows.some(
    (row) =>
      (row.start !== null && row.end !== null && row.end >= row.start) ||
      (row.point === true && row.end !== null) ||
      (row.open === true && row.start !== null),
  )
  return (
    <TableViewport label={props.label} minWidth="lg">
      <table className="data-table data-table--compact execution-swimlane">
        <thead>
          <tr>
            <th scope="col">{props.rowHeading}</th>
            <th scope="col">
              {props.timeHeading}
              {hasKnownTime && (
                <div className="execution-swimlane__axis">
                  {ticks.map((fraction) => (
                    <span key={fraction} style={{ left: `${fraction * 100}%` }}>
                      +{Number(((width * fraction) / 1000).toFixed(3))} s
                    </span>
                  ))}
                </div>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const valid = row.start !== null && row.end !== null && row.end >= row.start
            const start = Math.max(props.from, Math.min(props.to, row.start ?? props.from))
            const end = Math.max(start, Math.min(props.to, row.end ?? start))
            return (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                <td>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost execution-swimlane__select"
                    data-execution-id={row.id}
                    onClick={(event) => props.onSelect(row.id, event.currentTarget)}
                    aria-label={row.description}
                  >
                    <span className="execution-swimlane__track" aria-hidden="true">
                      {valid && row.start !== row.end && (
                        <span
                          className="execution-swimlane__bar"
                          data-open={row.open === true ? 'true' : undefined}
                          style={{
                            left: `${((start - props.from) / width) * 100}%`,
                            width: `${((end - start) / width) * 100}%`,
                          }}
                        />
                      )}
                      {valid && row.start === row.end && (
                        <span
                          className="execution-swimlane__point"
                          style={{ left: `${((start - props.from) / width) * 100}%` }}
                        />
                      )}
                      {!valid && row.point && row.end !== null && (
                        <span
                          className="execution-swimlane__point"
                          style={{
                            left: `${((Math.max(props.from, Math.min(props.to, row.end)) - props.from) / width) * 100}%`,
                          }}
                        />
                      )}
                      {!valid && row.open && row.start !== null && (
                        <span
                          className="execution-swimlane__open"
                          style={{ left: `${((start - props.from) / width) * 100}%` }}
                        />
                      )}
                    </span>
                    <span className="execution-swimlane__detail">
                      {valid ? row.detail : props.unknownLabel}
                    </span>
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableViewport>
  )
}
