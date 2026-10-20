// The frame around the units of one object, or around the objects of one
// group (lib/matrixObjects.js: objectBoxes). Like a phase band, not a unit: it
// lies behind the units and takes no clicks, so every line stays reachable --
// except its name in the edit mode, by which it is dragged with all it holds.
export function ObjectBox({ data }) {
  const group = data.kind === 'group'
  return (
    <div
      className={'mx-box' + (group ? ' group' : '') + (data.editing ? ' editing' : '')}
      style={{ width: '100%', height: '100%', borderColor: data.color || undefined, background: data.color ? `${data.color}0d` : undefined }}
    >
      <span className="mx-box-label" style={{ color: data.color || undefined }}
        title={data.editing ? 'Drag to move everything in it — onto a phase band to put it all into that phase' : undefined}>{data.label}</span>
    </div>
  )
}
