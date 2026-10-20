import { Handle, Position } from 'reactflow'

// Four dedicated handles so rank edges (vertical) and same-rank/equals
// edges (horizontal) each connect via the two box edges that actually face
// each other, instead of ReactFlow's single default source/target pair
// routing the "long way around" the box.
//
//   top    (source) -- rank edges leave here towards the node above
//   bottom (target) -- rank edges arrive here from the node below
//   right  (source) -- same-rank/equals edges leave here towards the
//                       neighbour positioned to the right
//   left   (target) -- same-rank/equals edges arrive here from the
//                       neighbour positioned to the left
//
// In the edit mode (data.editing) the handles show, and any of them starts or
// ends a line: the Matrix tab connects loosely and asks which relation it is.
// A unit a check points at (data.marked) gets an orange ring. A unit of one of
// the HME's types (data.look) has its symbol and border colour, an interface
// is drawn round.
export function MatrixNode({ data, selected }) {
  const handleStyle = data.editing ? undefined : { visibility: 'hidden' }
  const look = data.look
  return (
    <div
      className={data.editing ? 'mx-node editing' : 'mx-node'}
      style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: data.color, color: '#1e2d33',
        border: selected ? '2px solid var(--gold)' : data.marked ? '2px solid var(--orange)' : look ? `1.5px solid ${look.border}` : '1px solid rgba(0,0,0,.25)',
        borderRadius: look?.shape === 'ellipse' ? '50%' : 4,
        boxShadow: selected
          ? '0 0 0 3px rgba(31,141,166,.35), 0 0 14px rgba(31,141,166,.5)'
          : data.marked ? '0 0 0 3px rgba(212,140,26,.35)' : 'none',
        fontSize: 11, fontFamily: "'IBM Plex Mono',monospace",
        fontWeight: selected ? 700 : 400,
        padding: '0 6px', textAlign: 'center',
        zIndex: selected ? 10 : 0,
      }}
    >
      <Handle type="source" position={Position.Top} id="top" style={handleStyle} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle} />
      <Handle type="target" position={Position.Left} id="left" style={handleStyle} />
      {look && <span style={{ color: look.border, marginRight: 5 }} aria-label={look.label}>{look.symbol}</span>}
      {data.label}
    </div>
  )
}
