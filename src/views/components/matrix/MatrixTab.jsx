import { useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, ConnectionMode, useReactFlow } from 'reactflow'
import 'reactflow/dist/style.css'
import { useStore } from '../../store'
import { hideNodeHover, scheduleNodeHover } from '../shared/nodeHover'
import { nodeColor, nodeColorOverride, typeLabel, fmt } from '../../lib/schema'
import { detectDotOneProperties, buildSequence, qualifierVocabulary, relationBetween, statementsOf } from '../../lib/harrisMatrix'
import { checkMatrix } from '../../lib/matrixChecks'
import { defaultPhaseKey, inGivenOrder, layoutByPhase, phaseCandidates, readPhases } from '../../lib/matrixPhases'
import { PALETTE } from '../../lib/schema'
import { MatrixPhasesPanel } from './MatrixPhasesPanel'
import { PhaseLane } from './PhaseLane'
import { defaultObjectKey, objectBoxes, objectCandidates, readObjects } from '../../lib/matrixObjects'
import { MatrixObjectsPanel } from './MatrixObjectsPanel'
import { UNIT_TYPE_LOOK, unitTypeOf, writeMatrixGraphML } from '../../lib/matrixGraphml'
import { ObjectBox } from './ObjectBox'
import { MatrixChecksPanel } from './MatrixChecksPanel'
import { MatrixUnitRelations } from './MatrixUnitRelations'
import { NewRelationDialog, RelationDialog } from './MatrixEditDialog'
import {
  assignCategoryColors,
  conditionForCategory,
  dimForProperty,
  groupAndCount,
  listChartProperties,
  NO_VALUE,
} from '../../lib/chartData'
import { layoutHarrisMatrix } from '../../lib/dagreLayout'
import { MatrixNode } from './MatrixNode'

const NODE_TYPES = { matrixNode: MatrixNode, phaseLane: PhaseLane, objectBox: ObjectBox }
const BOX = 'box:' // id prefix of the object and group frames
const isBackdrop = (n) => n.type === 'phaseLane' || n.type === 'objectBox'
const LANE = 'lane:' // id prefix of the phase bands, which are no units

// ReactFlow fits the view once, when it mounts. The canvas changes height
// afterwards -- the checks panel, the edit bar, a legend come and go -- and
// the matrix would stay at the old fit, small at the bottom or cut off. Fitted
// again whenever one of those changes.
// Nothing to fit on an empty canvas (a matrix before its first unit), nor on
// a hidden one (another tab in front, the canvas 0 × 0): the viewport would
// become NaN.
function Refit({ deps, empty, visible }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (empty || !visible) return undefined
    const t = setTimeout(() => fitView({ duration: 200 }), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return null
}

const EDGE_TYPE = 'step' // angular/right-angle routing, no curves

const RANK_EDGE_STYLE = { stroke: 'var(--gold)', strokeWidth: 1.4 }
const SAME_RANK_EDGE_STYLE = { stroke: 'var(--tx2)', strokeWidth: 1.2, strokeDasharray: '5 4' }
const EQUALS_EDGE_STYLE = { stroke: '#32A88B', strokeWidth: 1.4, strokeDasharray: '1 3' }
const UNKNOWN_EDGE_STYLE = { stroke: '#c94052', strokeWidth: 1.2, strokeDasharray: '2 3' }

/** The matrix as shown, for yEd (lib/matrixGraphml.js) — handed to the browser as a download. */
function downloadGraphML(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/graphml+xml;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function propLocalName(uri) {
  return uri.split('#').pop().split('/').pop().replace(/_/g, ' ')
}

// Rank edges always connect source's TOP (source = physically lower) to
// target's BOTTOM (target = physically higher) -- the two box edges that
// actually face each other across the gap between adjacent ranks, instead
// of routing the long way around both boxes.
//
// Drawn as plain lines, the way a Harris matrix is drawn on paper: the
// direction is already in the layout (lower/older sinks to the bottom), so
// an arrowhead on every single edge only adds ink.
//
// `data` says what the line stands for, as "a <kind> b" -- what the edit mode
// offers to change or remove when it is clicked.
function rankEdgeToRf(e, i) {
  return {
    id: `r${i}`, source: e.source, target: e.target,
    sourceHandle: 'top', targetHandle: 'bottom',
    type: EDGE_TYPE, style: RANK_EDGE_STYLE,
    data: { a: e.target, b: e.source, kind: 'higher' },
  }
}

// Same-rank/equals edges are horizontal: connect the RIGHT handle of
// whichever node ends up positioned further left to the LEFT handle of
// whichever ends up further right, so the line runs straight through the
// gap between the two boxes instead of dipping via top/bottom handles.
function horizontalEdgeToRf(e, i, idPrefix, style, positions, kind) {
  const pa = positions[e.source]
  const pb = positions[e.target]
  const [leftId, rightId] = (pa?.x ?? 0) <= (pb?.x ?? 0) ? [e.source, e.target] : [e.target, e.source]
  return {
    id: `${idPrefix}${i}`, source: leftId, target: rightId,
    sourceHandle: 'right', targetHandle: 'left',
    type: EDGE_TYPE, style,
    data: { a: e.source, b: e.target, kind },
  }
}

const idCollator = new Intl.Collator(undefined, { numeric: true })
const byId = (a, b) => idCollator.compare(a, b)

export function MatrixTab({ active, domId = 'tab-matrix' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const explorerType = useStore((s) => s.explorerType)
  const setExplorerType = useStore((s) => s.setExplorerType)
  const openInExplorer = useStore((s) => s.openInExplorer)
  const openExplorerWithFilter = useStore((s) => s.openExplorerWithFilter)
  const selectedId = useStore((s) => s.selectedId)

  const [selectedProp, setSelectedProp] = useState('')
  // The matrices an editor's mapping can hold -- also before the first unit
  // is entered, when the graph has no stratigraphic relation to find them by.
  const editorRules = useStore((s) => s.editor?.matrix?.rules)
  const rules = useMemo(() => (editorRules ? editorRules() : []), [editorRules, graph])
  // Which property the boxes are colored by ('' = the node type's own color).
  // Local, like the dot-one property above: two Dashboard panes may well want
  // to look at the same matrix through two different lenses.
  const [colorPropId, setColorPropId] = useState('')

  // Only list types that can actually produce a Harris Matrix (i.e. carry
  // Dot-One relations among their own instances) -- picking e.g. a Material
  // type would always land on the "keine Dot-One-Relationen" empty state.
  const types = useMemo(() => {
    const found = Object.keys(graph?.node_types || typeIndex || {})
      .filter((t) => detectDotOneProperties(graph, typeIndex[t] || []).length > 0)
    for (const r of rules) if (!found.includes(r.typeKey)) found.push(r.typeKey)
    return found.sort()
  }, [graph, typeIndex, rules])

  // Suggest the type with the most dot-one relations as a starting point,
  // but only while nothing is picked yet -- once the user (or the Explorer
  // tab) sets a type, that choice always wins.
  const suggestedType = useMemo(() => {
    if (!graph) return ''
    let best = ''
    let bestCount = 0
    for (const t of types) {
      const ids = typeIndex[t] || []
      const props = detectDotOneProperties(graph, ids)
      if (props.length && ids.length > bestCount) {
        best = t
        bestCount = ids.length
      }
    }
    return best || rules[0]?.typeKey || ''
  }, [graph, types, typeIndex, rules])

  useEffect(() => {
    if (!explorerType && suggestedType) setExplorerType(suggestedType)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedType])

  // The type is shared with the Explorer's type filter. A type without
  // Dot-One relations (e.g. the Explorer narrowed to finds) has no matrix,
  // so fall back to the suggestion instead of showing an empty canvas.
  const activeType = types.includes(explorerType) ? explorerType : suggestedType
  const typeNodeIds = activeType ? (typeIndex[activeType] || []) : []

  const dotOneProps = useMemo(
    () => (graph ? detectDotOneProperties(graph, typeNodeIds) : []),
    [graph, typeNodeIds]
  )
  const ruleProp = rules.find((r) => r.typeKey === activeType)?.baseProp || ''
  const activeProp = dotOneProps.includes(selectedProp) ? selectedProp : dotOneProps[0] || ruleProp

  // The units of the matrix: the chosen type, and every unit related to one of
  // them by this property even if it carries another type. A mapping may give
  // the partner of a relation a role of its own ("SE (Relation)"); a unit that
  // only ever appears as such a partner -- one just entered with its first
  // relation, say -- belongs in the matrix all the same.
  // In a fixed order (by id, numbers as numbers), not the graph's: an edit
  // moves the node it touched to the end there, and the layout -- which
  // follows the order it is given -- would jump with every change, away from
  // units placed by hand.
  const matrixIds = useMemo(() => {
    const sorted = (list) => [...list].sort(byId)
    if (!graph || !activeProp) return sorted(typeNodeIds)
    const ids = new Set(typeNodeIds)
    for (const id of typeNodeIds) {
      for (const side of ['o', 'i']) {
        for (const [key, targets] of Object.entries(graph.nodes[id]?.[side] || {})) {
          if (!key.startsWith(activeProp + '#dot1:')) continue
          for (const t of targets) if (graph.nodes[t]) ids.add(t)
        }
      }
    }
    return sorted(ids)
  }, [graph, typeNodeIds, activeProp])

  const { rankEdges, sameRankEdges, equalsEdges, unknownEdges } = useMemo(() => {
    if (!graph || !activeProp) return { rankEdges: [], sameRankEdges: [], equalsEdges: [], unknownEdges: [] }
    return buildSequence(graph, matrixIds, activeProp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, matrixIds, activeProp])

  // -- Phases (lib/matrixPhases.js) --------------------------------------
  // Read through one property of the units, P10 falls within by default; with
  // an editor that knows the phases (README.md, "Editing": matrix.phases) its
  // list gives the order and the phases no unit belongs to yet.
  const editor = useStore((s) => s.editor)
  const phasesApi = editor?.matrix?.phases || null
  const phaseInfo = useMemo(
    () => (phasesApi && activeType ? phasesApi.describe({ typeKey: activeType }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phasesApi, activeType, graph]
  )
  // The unit types the editor can set (README.md, "Editing": matrix.unitTypes).
  const unitTypesApi = editor?.matrix?.unitTypes || null
  const unitTypeInfo = useMemo(
    () => (unitTypesApi && activeType ? unitTypesApi.describe({ typeKey: activeType }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unitTypesApi, activeType, graph]
  )
  const editorPhases = useMemo(
    () => (phasesApi && phaseInfo?.available ? phasesApi.list({ typeKey: activeType }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phasesApi, phaseInfo, activeType, graph]
  )
  const phaseChoices = useMemo(() => (graph ? phaseCandidates(graph, matrixIds) : []), [graph, matrixIds])
  const [phaseChoice, setPhaseChoice] = useState('') // '' = the default, 'none' = no phases
  const phaseKey = phaseChoice === 'none'
    ? ''
    : phaseChoices.some((c) => c.key === phaseChoice)
      ? phaseChoice
      : (phaseInfo?.available && phaseInfo.edgeKey) || (graph ? defaultPhaseKey(graph, matrixIds) : '')
  const editorKey = !!phaseInfo?.available && phaseKey === phaseInfo.edgeKey
  const phaseModel = useMemo(() => {
    if (!graph || !phaseKey) return null
    const given = editorKey ? editorPhases : []
    const m = inGivenOrder(readPhases(graph, matrixIds, phaseKey, given), given)
    return m.phases.length ? m : null
  }, [graph, matrixIds, phaseKey, editorKey, editorPhases])
  const phaseColor = useMemo(
    () => new Map((phaseModel?.phases || []).map((p, i) => [p.id, PALETTE[i % PALETTE.length]])),
    [phaseModel]
  )

  // -- Objects and object groups (lib/matrixObjects.js) -------------------
  // The same pattern: P46i forms part of by default, any such property by
  // choice, and the editor's list for objects and groups nothing belongs to yet.
  const objectsApi = editor?.matrix?.objects || null
  const objectInfo = useMemo(
    () => (objectsApi && activeType ? objectsApi.describe({ typeKey: activeType }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objectsApi, activeType, graph]
  )
  const editorObjects = useMemo(
    () => (objectsApi && objectInfo?.available ? objectsApi.list({ typeKey: activeType }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objectsApi, objectInfo, activeType, graph]
  )
  const objectChoices = useMemo(() => (graph ? objectCandidates(graph, matrixIds) : []), [graph, matrixIds])
  const [objectChoice, setObjectChoice] = useState('') // '' = the default, 'none' = no objects
  const objectKey = objectChoice === 'none'
    ? ''
    : objectChoices.some((c) => c.key === objectChoice)
      ? objectChoice
      : (objectInfo?.available && objectInfo.edgeKey) || (graph ? defaultObjectKey(graph, matrixIds) : '')
  const objectEditorKey = !!objectInfo?.available && objectKey === objectInfo.edgeKey
  const objectModel = useMemo(() => {
    if (!graph || !objectKey) return null
    const m = readObjects(graph, matrixIds, objectKey, objectEditorKey
      ? { groupKey: objectInfo.groupEdgeKey || null, extra: editorObjects }
      : {})
    return m.objects.length ? m : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, matrixIds, objectKey, objectEditorKey, editorObjects])
  const objectColor = useMemo(
    () => new Map((objectModel?.objects || []).map((o, i) => [o.id, PALETTE[(i + 7) % PALETTE.length]])),
    [objectModel]
  )
  const nest = objectModel?.objectOf.size ? { objectOf: objectModel.objectOf, groupOf: objectModel.groupOf } : null

  const { positions: laidOut, width, height, lanes } = useMemo(
    () => (phaseModel
      ? layoutByPhase(matrixIds, phaseModel, rankEdges, sameRankEdges, equalsEdges, nest)
      : layoutHarrisMatrix(matrixIds, rankEdges, sameRankEdges, equalsEdges, nest)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matrixIds, phaseModel, rankEdges, sameRankEdges, equalsEdges, objectModel]
  )
  // Units pulled aside by hand in the edit mode -- to get at lines that run on
  // top of each other. Kept by the editor when it can (below), for the session
  // otherwise; "Arrange" lays out afresh.
  const [moved, setMoved] = useState({})
  const positions = useMemo(
    () => (Object.keys(moved).length ? { ...laidOut, ...moved } : laidOut),
    [laidOut, moved]
  )
  // Frames around objects and groups, from where the units are -- so a unit
  // moved aside takes its frame along, and a frame dragged moves its units.
  const boxes = useMemo(
    () => (objectModel?.objectOf.size ? objectBoxes(positions, width, height, objectModel, phaseModel) : []),
    [positions, width, height, objectModel, phaseModel]
  )

  // What the boxes can be colored by: every property these units actually
  // carry -- connections ("Hat die Interpretation") and literal attributes
  // alike, the same list the Diagramme tab groups by.
  const colorProps = useMemo(
    () => (graph ? listChartProperties(graph, matrixIds, schema) : []),
    [graph, matrixIds, schema]
  )
  const colorProp = colorProps.find((p) => p.id === colorPropId) || null
  const colorDim = useMemo(() => dimForProperty(colorProp, ''), [colorProp])

  const categories = useMemo(() => {
    if (!graph || !colorDim || !matrixIds.length) return null
    // 'count' order is what makes the color assignment meaningful: the biggest
    // groups get the palette, and a unit with two values takes the color of
    // its bigger one (see assignCategoryColors).
    return assignCategoryColors(groupAndCount(graph, matrixIds, colorDim, { sort: 'count' }))
  }, [graph, matrixIds, colorDim])

  // The HME's unit types of the units (layer, deposit, fill, structure,
  // interface): drawn as the HME draws them, listed under the matrix.
  const unitTypes = useMemo(
    () => new Map(graph ? matrixIds.map((id) => [id, unitTypeOf(graph, id)]) : []),
    [graph, matrixIds]
  )
  const typesShown = useMemo(() => {
    const counts = new Map()
    for (const t of unitTypes.values()) if (t) counts.set(t, (counts.get(t) || 0) + 1)
    return Object.keys(UNIT_TYPE_LOOK).filter((t) => counts.has(t)).map((t) => [t, counts.get(t)])
  }, [unitTypes])

  // -- Checks: what the Harris Matrix Editor reported (lib/matrixChecks.js) --
  const checks = useMemo(() => {
    if (!graph || !activeProp) return null
    return checkMatrix(matrixIds, (id) => graph.nodes[id]?.l, { rankEdges, sameRankEdges, equalsEdges, unknownEdges }, { phaseModel, objectModel })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, activeProp, rankEdges, sameRankEdges, equalsEdges, unknownEdges, phaseModel, objectModel])
  const [showChecks, setShowChecks] = useState(false)
  const [marked, setMarked] = useState(null) // Set of unit ids a finding points at

  // -- Editing (only with an editor that can: README.md, "Editing") ----------
  const navigateTo = useStore((s) => s.navigateTo)
  const matrixEditor = editor?.matrix || null
  const [editMode, setEditMode] = useState(false)
  const [dialog, setDialog] = useState(null) // { mode: 'relation', a, b, current } | { mode: 'new' }
  const [editNote, setEditNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPhases, setShowPhases] = useState(false)
  const [showObjects, setShowObjects] = useState(false)
  // Where a line was started: React Flow turns a connection round when it
  // begins at a target handle, but the dialog should name first the unit the
  // drag began at -- "SU1001 lies above …", as it was meant.
  const connectFrom = useRef(null)
  const verdict = useMemo(
    () => (matrixEditor && activeProp ? matrixEditor.describe({ baseProp: activeProp, typeKey: activeType }) : null),
    [matrixEditor, activeProp, activeType, graph]
  )
  const vocabulary = useMemo(() => (graph && activeProp ? qualifierVocabulary(graph, activeProp) : {}), [graph, activeProp])
  useEffect(() => {
    if (!matrixEditor) {
      setEditMode(false)
      setDialog(null)
    }
  }, [matrixEditor])
  // Units placed by hand belong to one look at one matrix -- this type, this
  // relation, these phases and objects. An editor that can keep them
  // (README.md, "Editing": matrix.positions) gives them back and keeps every
  // change; without one they last for the session.
  const positionsKey = `${activeType}|${activeProp}|${phaseKey}|${objectKey}`
  const keeper = matrixEditor?.positions || null
  const loadedKey = useRef(null)
  // Only what a hand changed is handed back -- never the state from before
  // the load, which would wipe what was kept.
  const touched = useRef(false)
  const place = (update) => {
    touched.current = true
    setMoved(update)
  }
  useEffect(() => {
    loadedKey.current = positionsKey
    touched.current = false
    setMoved(keeper ? { ...(keeper.load(positionsKey) || {}) } : {})
  }, [positionsKey, keeper])
  useEffect(() => {
    if (keeper && touched.current && loadedKey.current === positionsKey) keeper.save(positionsKey, moved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moved])

  // The phase and object actions of the editor; their answer shown as in apply().
  function applyPhases(action, payload, api = phasesApi) {
    setBusy(true)
    let result
    try {
      result = api[action]({ typeKey: activeType, ...payload })
    } finally {
      setBusy(false)
    }
    if (result?.ok) setEditNote('')
    else setEditNote(result?.error || 'Could not save.')
  }
  function apply(action, payload) {
    setBusy(true)
    const result = matrixEditor[action]({ baseProp: activeProp, typeKey: activeType, ...payload })
    setBusy(false)
    if (result?.ok) {
      setDialog(null)
      setEditNote('')
    } else {
      setEditNote(result?.error || 'Could not save.')
    }
  }
  // A kind chosen in the dialog: a new relation, or another kind for one there is.
  function pickKind(a, b, kind) {
    const word = vocabulary[kind]
    if (relationBetween(graph, activeProp, a, b)) apply('setRelation', { a, b, kind, word })
    else apply('addRelation', { a, b, kind, word })
  }

  if (!graph) return null

  // The phase bands first, so they lie behind the units.
  const phaseCounts = new Map()
  for (const p of phaseModel?.phaseOf?.values() || []) phaseCounts.set(p, (phaseCounts.get(p) || 0) + 1)
  const laneNodes = (lanes || []).map((ln) => ({
    id: LANE + (ln.id ?? ''),
    type: 'phaseLane',
    position: { x: ln.x, y: ln.y },
    data: {
      label: ln.label,
      color: ln.id == null ? null : phaseColor.get(ln.id),
      count: ln.id == null ? matrixIds.length - (phaseModel?.phaseOf.size || 0) : phaseCounts.get(ln.id) || 0,
    },
    style: { width: ln.w, height: ln.h },
    width: ln.w,
    height: ln.h,
    zIndex: -1,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
  }))
  // The frames of objects and groups, above the bands and below the units.
  const objectCounts = new Map()
  for (const o of objectModel?.objectOf?.values() || []) objectCounts.set(o, (objectCounts.get(o) || 0) + 1)
  const objectLabel = new Map([...(objectModel?.objects || []), ...(objectModel?.groups || [])].map((o) => [o.id, o.label]))
  const boxNodes = boxes.map((b) => ({
    id: `${BOX}${b.kind}:${b.phase ?? ''}:${b.id}`,
    type: 'objectBox',
    position: { x: b.x, y: b.y },
    data: { label: objectLabel.get(b.id) || b.id, kind: b.kind, color: b.kind === 'object' ? objectColor.get(b.id) : null, editing: editMode, members: b.members },
    style: { width: b.w, height: b.h },
    width: b.w,
    height: b.h,
    zIndex: -1,
    // In the edit mode a frame is dragged by its name -- the rest of it stays
    // out of the way, so the lines inside can still be clicked.
    draggable: editMode,
    dragHandle: '.mx-box-label',
    selectable: false,
    connectable: false,
    focusable: false,
  }))
  // Groups behind their objects.
  boxNodes.sort((a, b) => (a.data.kind === b.data.kind ? 0 : a.data.kind === 'group' ? -1 : 1))
  const unitNodes = matrixIds.map((id) => {
    const nd = graph.nodes[id]
    const pos = positions[id] || { x: 0, y: 0 }
    const look = UNIT_TYPE_LOOK[unitTypes.get(id)] || null
    // A color given to this one node still wins -- it says "this specific unit
    // matters", which no category rule should overrule. Without a colouring
    // chosen, a unit of one of the HME's types has the colour of its type.
    const color = categories
      ? nodeColorOverride(schema, id) || categories.colorOf(id)
      : nodeColorOverride(schema, id) || look?.fill || nodeColor(schema, id, nd?.t)
    return {
      id,
      type: 'matrixNode',
      position: pos,
      selected: id === selectedId,
      data: { label: nd?.l ?? id, color, look, editing: editMode, marked: !!marked?.has(id) },
      style: { width, height },
      // The size, given rather than measured. React Flow hides a node until it
      // knows its size, and with the nodes handed in anew on every move of a
      // drag, the size it had measured got lost -- the whole matrix vanished
      // after a unit was moved. Every box here has this one fixed size.
      width,
      height,
    }
  })
  const rfNodes = laneNodes.length || boxNodes.length ? [...laneNodes, ...boxNodes, ...unitNodes] : unitNodes

  function exportGraphML() {
    const units = matrixIds.map((id) => ({ id, label: labelOf(id), type: unitTypeOf(graph, id) }))
    const relations = [
      // rank edges run lower -> higher: the target lies above the source
      ...rankEdges.map((e) => ({ a: e.target, b: e.source, kind: 'higher' })),
      ...sameRankEdges.map((e) => ({ a: e.source, b: e.target, kind: 'same-rank' })),
      ...equalsEdges.map((e) => ({ a: e.source, b: e.target, kind: 'equals' })),
    ]
    const xml = writeMatrixGraphML({
      units,
      relations,
      phases: (phaseModel?.phases || []).map((p) => ({ id: p.id, label: p.label, color: phaseColor.get(p.id) })),
      phaseOf: phaseModel?.phaseOf || new Map(),
      objects: (objectModel?.objects || []).map((o) => ({
        id: o.id, label: o.label, color: objectColor.get(o.id),
        group: objectModel.groupOf.has(o.id) ? objectModel.groups.find((g) => g.id === objectModel.groupOf.get(o.id))?.label : undefined,
      })),
      objectOf: objectModel?.objectOf || new Map(),
      positions,
      width,
      height,
      title: `${typeLabel(schema, activeType)} — ${matrixIds.length} units`,
    })
    downloadGraphML(`harris-matrix_${String(typeLabel(schema, activeType)).replace(/[^\w.-]+/g, '_')}.graphml`, xml)
  }

  // The tail the palette couldn't cover, plus the units without a value,
  // folded into one entry -- listing 300 grey categories individually would
  // bury the ones that are actually distinguishable.
  const namedCategories = categories?.legend.filter((c) => !c.plain) || []
  const plainCategories = categories?.legend.filter((c) => c.plain) || []

  // Same move as a bar click in the Diagramme tab: the category re-expressed
  // as an Explorer filter, so "which units are these?" is one click away.
  function openCategory(cat) {
    const cond = conditionForCategory(graph, colorDim, cat.label, cat.ids)
    if (cond) openExplorerWithFilter(activeType, [cond])
  }

  const rfEdges = [
    ...rankEdges.map((e, i) => rankEdgeToRf(e, i)),
    ...sameRankEdges.map((e, i) => horizontalEdgeToRf(e, i, 's', SAME_RANK_EDGE_STYLE, positions, 'same-rank')),
    ...equalsEdges.map((e, i) => horizontalEdgeToRf(e, i, 'eq', EQUALS_EDGE_STYLE, positions, 'equals')),
    ...unknownEdges.map((e, i) => horizontalEdgeToRf(e, i, 'u', UNKNOWN_EDGE_STYLE, positions, 'unknown')),
  ].map((e) => (
    // In the edit mode, the lines of the selected unit stand out.
    editMode && selectedId && (e.source === selectedId || e.target === selectedId)
      ? { ...e, style: { ...e.style, stroke: 'var(--orange)', strokeWidth: 2.4 }, zIndex: 5 }
      : e
  ))
  const labelOf = (id) => graph.nodes[id]?.l || id
  const units = editMode ? matrixIds.map((id) => ({ id, label: labelOf(id) })) : []

  // The relations among the units of a finding, each once: "A above B" and
  // its reverse reading "B below A" are one relation.
  function statementsFor(issue) {
    if (issue.nodeIds.length > 30) return []
    const ids = new Set(issue.nodeIds)
    const out = []
    const seen = new Set()
    for (const a of ids) {
      for (const { partner: b, kind } of statementsOf(graph, activeProp, a)) {
        if (!ids.has(b)) continue
        const key = kind === 'lower' ? `${b} higher ${a}` : kind === 'higher' ? `${a} higher ${b}` : `${[a, b].sort().join(' ')} ${kind}`
        if (seen.has(key)) continue
        seen.add(key)
        // Read top-down, as a matrix is read: "X lies above Y", never "Y lies below X".
        out.push(kind === 'lower' ? { a: b, b: a, kind: 'higher' } : { a, b, kind })
      }
    }
    return out
  }
  const selectedStatements = editMode && selectedId && matrixIds.includes(selectedId)
    ? statementsOf(graph, activeProp, selectedId)
    : null

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Harris Matrix</h2>
        <span className="badge">{fmt(matrixIds.length)} units</span>
        {checks && (
          <span
            className={'badge mx-checks-badge' + (checks.counts.error ? ' err' : checks.counts.warning ? ' warn' : '')}
            onClick={() => setShowChecks((v) => !v)}
            title="Show the checks"
          >
            {checks.counts.error || checks.counts.warning
              ? `⚠ ${checks.counts.error} errors · ${checks.counts.warning} warnings`
              : '✔ consistent'}
          </span>
        )}
        {marked && (
          <span className="badge" style={{ cursor: 'pointer' }} onClick={() => setMarked(null)} title="Remove the marking">
            {fmt(marked.size)} marked · reset
          </span>
        )}
      </div>

      {matrixEditor && activeProp && (
        <div className="frow map-edit-bar">
          {verdict?.editable ? (
            <>
              <button type="button" className={'map-edit-toggle' + (editMode ? ' on' : '')}
                onClick={() => { setEditMode((m) => !m); setDialog(null); setEditNote('') }}>
                {editMode ? '✔ Done editing' : '✎ Edit matrix'}
              </button>
              {editMode && (
                <>
                  <span className="map-edit-hint">drag from a unit's edge to another unit to relate them · click a unit to list its relations · drag a unit to move it aside{phaseModel && editorKey ? ', onto a phase band to put it there' : ''}{boxes.length ? ' · drag a frame by its name to move all it holds' : ''}</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                    {Object.keys(moved).length > 0 && (
                      <button type="button" className="copy-btn" onClick={() => place({})} title="Lay the matrix out afresh">↺ Arrange</button>
                    )}
                    {objectsApi && (
                      <button type="button" className={'copy-btn' + (showObjects ? ' on' : '')} onClick={() => { setShowObjects((v) => !v); setShowPhases(false) }}
                        title="The objects and object groups of this matrix">▢ Objects</button>
                    )}
                    {phasesApi && (
                      <button type="button" className={'copy-btn' + (showPhases ? ' on' : '')} onClick={() => { setShowPhases((v) => !v); setShowObjects(false) }}
                        title="The phases of this matrix: create, order, rename, remove">◧ Phases</button>
                    )}
                    <button type="button" className="copy-btn" onClick={() => setDialog({ mode: 'new' })}>＋ Relation</button>
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="map-edit-hint">{verdict?.reason}</span>
          )}
          {editNote && (
            <span className="attr-edit-note">
              {editNote} <span className="attr-edit-dismiss" onClick={() => setEditNote('')}>×</span>
            </span>
          )}
        </div>
      )}

      {showChecks && checks && (
        <MatrixChecksPanel
          result={checks}
          labelOf={labelOf}
          busy={busy}
          // With the edit mode on, a finding opens to its relations, each removable.
          statementsFor={editMode ? statementsFor : null}
          onRemove={(s) => apply('removeRelation', { a: s.a, b: s.b, kind: s.kind })}
          onClose={() => setShowChecks(false)}
          onPick={(issue) => {
            setMarked(new Set(issue.nodeIds))
            if (issue.nodeIds[0]) navigateTo(issue.nodeIds[0], false)
          }}
        />
      )}

      <div className="frow">
        <select className="sl" value={activeType} onChange={(e) => setExplorerType(e.target.value)}>
          <option value="">Choose type…</option>
          {types.map((t) => (
            <option key={t} value={t}>{schema?.typeLabels?.[t] || rules.find((r) => r.typeKey === t)?.label || typeLabel(schema, t)}</option>
          ))}
        </select>
        {dotOneProps.length > 1 && (
          <select className="sl" value={activeProp} onChange={(e) => setSelectedProp(e.target.value)}>
            {dotOneProps.map((p) => (
              <option key={p} value={p}>{propLocalName(p)}</option>
            ))}
          </select>
        )}
        {(phaseChoices.length > 0 || phaseInfo?.available) && (
          <select
            className="sl"
            value={phaseChoice === 'none' || !phaseKey ? 'none' : phaseKey}
            title="Stack the matrix phase by phase: the property that names the phase of a unit"
            onChange={(e) => setPhaseChoice(e.target.value)}
          >
            <option value="none">Phases: none</option>
            {phaseInfo?.available && !phaseChoices.some((c) => c.key === phaseInfo.edgeKey) && (
              <option value={phaseInfo.edgeKey}>Phases: {propLocalName(phaseInfo.edgeKey.split('#as:')[0])}</option>
            )}
            {phaseChoices.map((c) => (
              <option key={c.key} value={c.key}>Phases: {propLocalName(c.key.split('#as:')[0])} ({fmt(c.count)})</option>
            ))}
          </select>
        )}
        {(objectChoices.length > 0 || objectInfo?.available) && (
          <select
            className="sl"
            value={objectChoice === 'none' || !objectKey ? 'none' : objectKey}
            title="Keep the units of an object together, framed: the property that names the object of a unit"
            onChange={(e) => setObjectChoice(e.target.value)}
          >
            <option value="none">Objects: none</option>
            {objectInfo?.available && !objectChoices.some((c) => c.key === objectInfo.edgeKey) && (
              <option value={objectInfo.edgeKey}>Objects: {propLocalName(objectInfo.edgeKey.split('#as:')[0])}</option>
            )}
            {objectChoices.map((c) => (
              <option key={c.key} value={c.key}>Objects: {propLocalName(c.key.split('#as:')[0])} ({fmt(c.count)})</option>
            ))}
          </select>
        )}
        {colorProps.length > 0 && (
          <select
            className="sl"
            // Falls back to "Typfarbe" when the picked property doesn't exist
            // for the newly chosen type -- an unmatched value would leave the
            // dropdown showing nothing at all.
            value={colorProp ? colorPropId : ''}
            title="Colour the boxes by the value of a property. The number in brackets tells how many units have a value for this property."
            onChange={(e) => setColorPropId(e.target.value)}
          >
            <option value="">Colour by: type colour</option>
            {colorProps.map((p) => (
              <option key={p.id} value={p.id}>Colour by: {p.label} ({fmt(p.coverage)})</option>
            ))}
          </select>
        )}
        {matrixIds.length > 0 && (
          <button type="button" className="copy-btn" onClick={exportGraphML} title="The matrix as shown — with its phases and objects — as GraphML for yEd">⇩ GraphML</button>
        )}
        <span style={{ fontSize: '.7rem', color: 'var(--tx3)', display: 'flex', alignItems: 'center', gap: '.9rem', marginLeft: '.4rem' }}>
          <span><span style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--gold)', marginRight: 4, verticalAlign: 'middle' }} />above/below</span>
          <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--tx2)', marginRight: 4, verticalAlign: 'middle' }} />contemporary (same level)</span>
          <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dotted #32A88B', marginRight: 4, verticalAlign: 'middle' }} />equals (same level + close)</span>
          {unknownEdges.length > 0 && (
            <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #c94052', marginRight: 4, verticalAlign: 'middle' }} />unknown value</span>
          )}
        </span>
      </div>

      {!categories && typesShown.length > 0 && (
        <div className="mx-legend">
          <span className="mx-leg-lbl">Unit type:</span>
          {typesShown.map(([type, n]) => (
            <span key={type} className="mx-leg-item">
              <span style={{ color: UNIT_TYPE_LOOK[type].border, marginRight: 3 }}>{UNIT_TYPE_LOOK[type].symbol}</span>
              {UNIT_TYPE_LOOK[type].label} <em>{fmt(n)}</em>
            </span>
          ))}
        </div>
      )}
      {categories && (
        <div className="mx-legend">
          <span className="mx-leg-lbl">{colorProp.label}:</span>
          {namedCategories.map((c) => (
            <span
              key={c.label}
              className="mx-leg-item"
              title={`${fmt(c.count)} units — open in Explorer`}
              onClick={() => openCategory(c)}
            >
              <span className="tl-leg-dot" style={{ background: c.color }} />
              {c.label} <em>{fmt(c.count)}</em>
            </span>
          ))}
          {plainCategories.length > 0 && (
            <span
              className="mx-leg-item plain"
              title={
                plainCategories.length === 1 && plainCategories[0].label === NO_VALUE
                  ? 'Units without a value'
                  : `Without a value, and ${fmt(plainCategories.length)} more values too rare for a colour of their own`
              }
            >
              <span className="tl-leg-dot" style={{ background: plainCategories[0].color }} />
              {plainCategories.length === 1 ? plainCategories[0].label : 'other'} <em>{fmt(categories.plainCount)}</em>
            </span>
          )}
        </div>
      )}
      {/* Outside the legend box, which scrolls once there are many values --
          a hint that can scroll out of sight is no hint. Same honesty as the
          Diagramme tab: a property with one value per unit can't produce a
          readable coloring, and saying so beats leaving people to wonder. */}
      {categories && colorProp.poorGrouping && (
        <div className="cat-note">
          “{colorProp.label}” has a value of its own for almost every unit — only the most frequent get a colour.
        </div>
      )}

      {/* minHeight 0: a flex child may otherwise not shrink below its content -- the
          canvas then grows past the panel when the checks or the edit bar open,
          and the matrix is fitted into space nobody sees. */}
      <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--bd)', borderRadius: 'var(--r)', overflow: 'hidden', background: 'var(--bg2)', position: 'relative' }}>
        {selectedStatements && !dialog && (
          <MatrixUnitRelations
            unitId={selectedId}
            statements={selectedStatements}
            labelOf={labelOf}
            busy={busy}
            onChange={(s, kind) => apply('setRelation', { a: selectedId, b: s.partner, kind, from: s.kind, word: vocabulary[kind] })}
            onRemove={(s) => apply('removeRelation', { a: selectedId, b: s.partner, kind: s.kind })}
            onClose={() => navigateTo(null, false)}
            phases={editorKey ? phaseModel?.phases || [] : null}
            phaseId={phaseModel?.phaseOf.get(selectedId)}
            onAssign={(phaseId) => applyPhases('assign', { unitId: selectedId, phaseId })}
            objects={objectEditorKey ? objectModel?.objects || [] : objectInfo?.available ? [] : null}
            objectId={objectModel?.objectOf.get(selectedId)}
            onAssignObject={(objectId, newLabel) => applyPhases('assign', { unitId: selectedId, objectId, newLabel }, objectsApi)}
            unitTypes={unitTypeInfo?.available ? unitTypeInfo.options : null}
            unitType={unitTypeInfo?.available ? graph.nodes[graph.nodes[selectedId]?.o?.[unitTypeInfo.edgeKey]?.[0]]?.l || '' : ''}
            onAssignType={(value) => applyPhases('assign', { unitId: selectedId, value }, unitTypesApi)}
            onOpenProtocol={matrixEditor?.openProtocol && (matrixEditor.hasProtocols?.() ?? true) ? () => matrixEditor.openProtocol(selectedId) : null}
          />
        )}
        {editMode && showObjects && objectsApi && !dialog && (
          <MatrixObjectsPanel
            info={objectInfo}
            objects={editorObjects?.objects || []}
            groups={editorObjects?.groups || []}
            groupOf={new Map((editorObjects?.objects || []).filter((o) => o.group).map((o) => [o.id, o.group]))}
            counts={objectCounts}
            colorOf={(id) => objectColor.get(id) || 'var(--tx3)'}
            busy={busy}
            onAddToMapping={() => { applyPhases('addToMapping', {}, objectsApi); setObjectChoice('') }}
            onCreateObject={(label) => applyPhases('createObject', { label }, objectsApi)}
            onCreateGroup={(label) => applyPhases('createGroup', { label }, objectsApi)}
            onRenameObject={(objectId, label) => applyPhases('renameObject', { objectId, label }, objectsApi)}
            onRenameGroup={(groupId, label) => applyPhases('renameGroup', { groupId, label }, objectsApi)}
            onRemoveObject={(objectId) => applyPhases('removeObject', { objectId }, objectsApi)}
            onRemoveGroup={(groupId) => applyPhases('removeGroup', { groupId }, objectsApi)}
            onSetGroup={(objectId, groupId, newLabel) => applyPhases('setGroup', { objectId, groupId, newLabel }, objectsApi)}
            onClose={() => setShowObjects(false)}
          />
        )}
        {editMode && showPhases && phasesApi && !dialog && (
          <MatrixPhasesPanel
            info={phaseInfo}
            phases={editorPhases}
            counts={phaseCounts}
            busy={busy}
            onAddToMapping={() => { applyPhases('addToMapping', {}); setPhaseChoice('') }}
            onCreate={(label) => applyPhases('create', { label })}
            onRename={(phaseId, label) => applyPhases('rename', { phaseId, label })}
            onMove={(phaseId, direction) => applyPhases('move', { phaseId, direction })}
            onRemove={(phaseId) => applyPhases('remove', { phaseId })}
            onClose={() => setShowPhases(false)}
          />
        )}
        {dialog?.mode === 'relation' && (
          <RelationDialog
            aLabel={labelOf(dialog.a)}
            bLabel={labelOf(dialog.b)}
            current={dialog.current}
            busy={busy}
            onPick={(kind) => pickKind(dialog.a, dialog.b, kind)}
            onRemove={dialog.current ? () => apply('removeRelation', { a: dialog.a, b: dialog.b }) : null}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog?.mode === 'new' && (
          <NewRelationDialog
            units={units}
            busy={busy}
            suggestIdentifier={(label) => matrixEditor.suggestIdentifier?.({ baseProp: activeProp, typeKey: activeType, label }) || ''}
            onSave={({ a, b, kind, newUnits }) => apply('addRelation', { a, b, kind, word: vocabulary[kind], newUnits })}
            onCancel={() => setDialog(null)}
          />
        )}
        {!activeType ? (
          <div className="det-empty">Please choose a node type with Dot-One relations</div>
        ) : !activeProp ? (
          <div className="det-empty">No Dot-One relations were found for this type</div>
        ) : !matrixIds.length ? (
          <div className="det-empty">
            No units yet.{matrixEditor ? <> {editMode ? 'Enter' : 'Choose “✎ Edit matrix”, then enter'} the first two with “＋ Relation”.</> : null}
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            fitView={rfNodes.length > 0}
            // ReactFlow stops zooming out at 0.5 -- a matrix of a few dozen
            // units in a column is then cut off top and bottom, and a unit at
            // the edge cannot be reached to draw a line to it.
            minZoom={0.05}
            nodesDraggable={editMode}
            onNodesChange={(changes) => {
              if (!editMode) return
              const next = {}
              for (const c of changes) {
                if (c.type !== 'position' || !c.position || c.id.startsWith(LANE)) continue
                if (c.id.startsWith(BOX)) {
                  // A frame dragged: its units move with it, by as much.
                  const box = boxNodes.find((b) => b.id === c.id)
                  if (!box) continue
                  const dx = c.position.x - box.position.x
                  const dy = c.position.y - box.position.y
                  for (const u of box.data.members) {
                    const p = next[u] || positions[u]
                    if (p) next[u] = { x: p.x + dx, y: p.y + dy }
                  }
                  continue
                }
                next[c.id] = c.position
              }
              if (Object.keys(next).length) place((m) => ({ ...m, ...next }))
            }}
            // Dropped onto a phase band: the unit -- or every unit of a frame --
            // into that phase (one undo), and back into the layout.
            onNodeDragStop={(_, node) => {
              if (!editMode || !lanes || !phasesApi || !editorKey || node.type === 'phaseLane') return
              const w = node.width || width
              const h = node.type === 'objectBox' ? 24 : node.height || height
              const cx = node.position.x + w / 2
              const cy = node.position.y + h / 2
              const lane = lanes.find((ln) => cx >= ln.x && cx <= ln.x + ln.w && cy >= ln.y && cy <= ln.y + ln.h)
              if (!lane) return
              const units = node.type === 'objectBox' ? node.data.members : [node.id]
              const target = lane.id ?? null
              const change = units.filter((u) => (phaseModel?.phaseOf.get(u) ?? null) !== target)
              if (!change.length) return
              applyPhases('assign', change.length === 1 ? { unitId: change[0], phaseId: target } : { unitIds: change, phaseId: target })
              place((m) => {
                const rest = { ...m }
                for (const u of units) delete rest[u]
                return rest
              })
            }}
            nodesConnectable={editMode}
            // In edit mode any side of a box may start or end a line -- which
            // relation it is, is asked afterwards, not read off the handles.
            connectionMode={ConnectionMode.Loose}
            onConnectStart={(_, { nodeId }) => { connectFrom.current = nodeId }}
            onConnect={(c) => {
              if (!editMode || !c.source || !c.target || c.source === c.target) return
              const [a, b] = connectFrom.current === c.target ? [c.target, c.source] : [c.source, c.target]
              setDialog({ mode: 'relation', a, b, current: relationBetween(graph, activeProp, a, b) })
            }}
            onEdgeClick={(_, e) => {
              if (!editMode || !e.data) return
              setDialog({ mode: 'relation', a: e.data.a, b: e.data.b, current: relationBetween(graph, activeProp, e.data.a, e.data.b) })
            }}
            elementsSelectable={true}
            proOptions={{ hideAttribution: true }}
            // In edit mode a click selects; a double click still opens the Explorer.
            onNodeClick={(_, n) => (isBackdrop(n) ? null : editMode ? navigateTo(n.id, false) : openInExplorer(n.id))}
            onNodeDoubleClick={(_, n) => editMode && !isBackdrop(n) && openInExplorer(n.id)}
            // The boxes only carry a label; hovering one reveals what that
            // stratigraphic unit actually holds without leaving the matrix.
            onNodeMouseEnter={(e, n) => !isBackdrop(n) && scheduleNodeHover(n.id, e.currentTarget)}
            onNodeMouseLeave={hideNodeHover}
          >
            <Refit empty={!rfNodes.length} visible={active} deps={[!rfNodes.length, active, showChecks, editMode, !!categories, activeType, activeProp, phaseKey, !!phaseModel, objectKey, !!objectModel]} />
            <Background color="#d2dfe2" gap={16} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable zoomable
              maskColor="rgba(244,248,249,0.75)"
              style={{ background: 'var(--bg3)' }}
              nodeColor={(n) => (isBackdrop(n) ? 'transparent' : n.data?.color || '#4a5e66')}
            />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
