import { useState } from 'react'
import { StatementRow } from './MatrixUnitRelations'

// The findings of lib/matrixChecks.js, as a list under the matrix toolbar.
// A click on a finding marks its units in the matrix and selects the first,
// so the place it is about is one click away. With an editor, the finding also
// opens to the relations it is about -- a cycle's, a contradiction's -- each
// one removable on its own, however the lines overlap in the drawing.

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }
const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' }

export function MatrixChecksPanel({ result, onPick, onClose, statementsFor, onRemove, labelOf, busy }) {
  const [open, setOpen] = useState(null) // the finding opened to its relations
  const issues = [...result.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return (
    <div className="mx-checks">
      <div className="mx-checks-hdr">
        <b>Checks</b>
        <span>{result.counts.error} errors · {result.counts.warning} warnings · {result.counts.info} notes</span>
        <span className="mx-checks-close" onClick={onClose} title="Close">×</span>
      </div>
      {!issues.length && <div className="mx-checks-empty">Nothing to report — the sequence is consistent.</div>}
      {issues.map((issue, i) => {
        const statements = open === i && statementsFor ? statementsFor(issue) : []
        return (
          <div key={i}>
            <div
              className={`mx-check ${issue.severity}${open === i ? ' open' : ''}`}
              onClick={() => {
                onPick(issue)
                setOpen(open === i ? null : i)
              }}
              title={issue.description}
            >
              <span className="mx-check-sev">{SEVERITY_LABEL[issue.severity]}</span>
              <span className="mx-check-msg">{issue.message}</span>
              {statementsFor && <span className="mx-check-more">{open === i ? '▾' : '▸'}</span>}
            </div>
            {open === i && statements.length > 0 && (
              <div className="mx-check-stmts">
                {statements.map((s) => (
                  <StatementRow
                    key={`${s.a} ${s.kind} ${s.b}`}
                    statement={s}
                    labelOf={labelOf}
                    busy={busy}
                    onRemove={() => onRemove(s)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {result.redundancySkipped && (
        <div className="mx-checks-empty">Redundant relations are not looked for in matrices of more than 3,000 units.</div>
      )}
    </div>
  )
}
