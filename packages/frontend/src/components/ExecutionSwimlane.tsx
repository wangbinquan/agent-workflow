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
  return (
    <TableViewport label={props.label} minWidth="lg">
      <table className="data-table data-table--compact execution-swimlane">
        <thead>
          <tr>
            <th scope="col">{props.rowHeading}</th>
            <th scope="col">{props.timeHeading}</th>
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
                    className="btn btn--sm execution-swimlane__select"
                    onClick={(event) => props.onSelect(row.id, event.currentTarget)}
                    aria-label={row.description}
                  >
                    <span className="execution-swimlane__track" aria-hidden="true">
                      {valid && (
                        <span
                          className="execution-swimlane__bar"
                          style={{
                            left: `${((start - props.from) / width) * 100}%`,
                            width: `${((end - start) / width) * 100}%`,
                          }}
                        />
                      )}
                    </span>
                    <span>{valid ? row.detail : props.unknownLabel}</span>
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
