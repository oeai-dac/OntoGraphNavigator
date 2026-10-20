import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { Marker, Polygon, Polyline, CircleMarker, useMap } from 'react-leaflet'
import { insertVertex, midpoints, moveVertex, removeVertex, toCoordinates, minVertices } from '../../lib/wktEdit'

// Handles are plain divs (styled in views.css): a filled square per vertex, a
// hollow one between two vertices where a new one can be put.
const vertexIcon = L.divIcon({ className: 'ge-vertex', iconSize: [12, 12] })
const midIcon = L.divIcon({ className: 'ge-vertex-mid', iconSize: [10, 10] })

const EDIT_STYLE = { color: '#d48c1a', weight: 2.5, fillColor: '#d48c1a', fillOpacity: 0.2, dashArray: '6 4' }

/**
 * The geometry being edited, drawn over the map with its handles.
 *
 * Works on the dataset's own coordinates (lib/wktEdit.js) and converts only
 * for drawing and back on every move -- `projection` is projectionFor() of
 * lib/geo.js. Every change goes to `onChange` as a new model; nothing is
 * written anywhere until the Map tab's Save.
 *
 *   drag a square          move that vertex
 *   click a hollow square  add a vertex there (or drag it where it belongs)
 *   right-click a square   remove that vertex (not below what the shape needs)
 *
 * `fitKey` names the geometry: when it changes, the map zooms to it -- a unit
 * of a few metres would otherwise be a cluster of handles on a few pixels.
 */
export function GeometryEditor({ model, projection, onChange, fitKey }) {
  const map = useMap()
  useEffect(() => {
    const points = []
    for (const path of model.paths) for (const v of path.vertices) points.push(projection.forward(v.x, v.y))
    if (!points.length) return
    map.fitBounds(L.latLngBounds(points), { padding: [80, 80], maxZoom: 22 })
    // Only when another geometry is opened, not on every edit of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey])

  // While a handle is dragged, the shape follows it without going through the
  // model on every pointer move.
  const [dragging, setDragging] = useState(null) // { pathIndex, vertexIndex, latlng }

  const shape = useMemo(() => {
    let current = model
    if (dragging) {
      const [x, y] = projection.inverse(dragging.latlng.lat, dragging.latlng.lng)
      current = moveVertex(model, dragging.pathIndex, dragging.vertexIndex, x, y)
    }
    return toCoordinates(current)
  }, [model, dragging, projection])

  const toLatLng = (xy) => projection.forward(xy[0], xy[1])
  const deep = (c) => (typeof c[0] === 'number' ? toLatLng(c) : c.map(deep))

  const outline = (() => {
    if (!shape) return null
    const c = deep(shape.coordinates)
    switch (shape.type) {
      case 'Polygon':
      case 'MultiPolygon':
        return <Polygon positions={c} pathOptions={EDIT_STYLE} interactive={false} />
      case 'LineString':
      case 'MultiLineString':
        return <Polyline positions={c} pathOptions={EDIT_STYLE} interactive={false} />
      case 'Point':
        return <CircleMarker center={c} radius={9} pathOptions={EDIT_STYLE} interactive={false} />
      case 'MultiPoint':
        return c.map((p, i) => <CircleMarker key={i} center={p} radius={9} pathOptions={EDIT_STYLE} interactive={false} />)
      default:
        return null
    }
  })()

  const handles = []
  model.paths.forEach((path, pathIndex) => {
    const removable = path.vertices.length > minVertices(path)
    path.vertices.forEach((v, vertexIndex) => {
      handles.push(
        <Marker
          key={`v:${pathIndex}:${vertexIndex}`}
          position={toLatLng([v.x, v.y])}
          icon={vertexIcon}
          draggable
          title={removable ? 'Drag to move · right-click to remove' : 'Drag to move'}
          eventHandlers={{
            drag: (e) => setDragging({ pathIndex, vertexIndex, latlng: e.target.getLatLng() }),
            dragend: (e) => {
              const ll = e.target.getLatLng()
              const [x, y] = projection.inverse(ll.lat, ll.lng)
              setDragging(null)
              onChange(moveVertex(model, pathIndex, vertexIndex, x, y))
            },
            contextmenu: (e) => {
              e.originalEvent?.preventDefault()
              if (removable) onChange(removeVertex(model, pathIndex, vertexIndex))
            },
          }}
        />
      )
    })
  })
  if (!dragging) {
    for (const mid of midpoints(model)) {
      handles.push(
        <Marker
          key={`m:${mid.pathIndex}:${mid.afterIndex}`}
          position={toLatLng([mid.x, mid.y])}
          icon={midIcon}
          draggable
          title="Click or drag to add a point here"
          eventHandlers={{
            click: () => onChange(insertVertex(model, mid.pathIndex, mid.afterIndex, mid.x, mid.y)),
            dragend: (e) => {
              const ll = e.target.getLatLng()
              const [x, y] = projection.inverse(ll.lat, ll.lng)
              onChange(insertVertex(model, mid.pathIndex, mid.afterIndex, x, y))
            },
          }}
        />
      )
    }
  }

  return (
    <>
      {outline}
      {handles}
    </>
  )
}
