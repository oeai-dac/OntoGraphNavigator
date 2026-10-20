// One phase as a band behind its units (lib/matrixPhases.js: layoutByPhase).
// Not a unit: it cannot be selected, moved or connected -- the Matrix tab
// gives it the lowest layer and leaves it out of every interaction.
export function PhaseLane({ data }) {
  return (
    <div
      className="mx-lane"
      style={{
        width: '100%', height: '100%',
        background: data.color ? `${data.color}14` : 'rgba(30,45,51,.03)',
        borderTop: `2px solid ${data.color || 'var(--bd)'}`,
      }}
    >
      <span className="mx-lane-label" style={{ color: data.color || 'var(--tx3)' }}>
        {data.label} <em>{data.count}</em>
      </span>
    </div>
  )
}
