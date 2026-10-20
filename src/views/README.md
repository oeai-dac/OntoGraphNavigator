# src/views — the views, as a piece of their own

Overview, Explorer, Graph, Harris matrix, Map, 3D, Timeline, Charts and
Dashboard, with the state they share (`store.js`), the logic behind them
(`lib/`) and their styles (`views.css`).

The GraphExplorer is one application built around them: landing page, header,
tab bar, RDF import and the bridge to QGIS, Blender and CloudCompare live
outside this folder. The **OntoGraphNavigator** is another — it shows the same
views over the graph it edits, from a **copy** of this folder.

## Rules for this folder

- **Self-contained.** Nothing in here imports from outside `src/views/`,
  apart from npm packages. The copy elsewhere has nothing else to lean on.
- **Changed only here.** The OntoGraphNavigator's copy is brought up to date
  with `npm run sync-views` there, and its checks report a copy that was
  edited by hand. A view is fixed or extended in the GraphExplorer, checked
  here, and then synced.
- **No styles beyond the views.** `views.css` applies its design tokens and
  base rules inside `.ge-root` only; the host puts the views in such an
  element. Class rules keep their names.

## The contract with a host

```js
import { createExplorerStore, ExplorerStoreProvider, MatrixTab, NodeHoverCard } from './views'

const store = createExplorerStore({ prefsKey: 'my-app:explorerPrefs:v1' })
store.getState().loadGraph(graphJson)    // a new graph: view state starts over
store.getState().updateGraph(graphJson)  // the same graph, edited: view state kept
```

```jsx
<ExplorerStoreProvider store={store}>
  <div className="ge-root">
    <MatrixTab active={tab === 'matrix'} />
    <NodeHoverCard />
  </div>
</ExplorerStoreProvider>
```

- `createExplorerStore(options)` — one store per application. `prefsKey`
  is where colours, attribute order and the dashboard layout are kept
  (localStorage); `geoEpsg` answers the map's coordinate question in advance.
- `useStore(selector)` inside the views, `useStoreApi()` for code that reads
  outside render. The host may use both, and `store.subscribe` to follow the
  selection (`selectedId`) or the tab a view asks for (`activeTab`, e.g. after
  "open in Explorer").
- Views that need data the graph does not have are not offered:
  `availableViews(graph)`.
- A multilingual graph (`graph.languages`, labels in `l_i18n`, type names in
  `schema.typeLabelsI18n`) is read in one of its languages with
  `store.getState().setDisplayLang(lang)` (null: its primary) — every view
  shows it, nothing else changes; `graphForSaving()` gives the graph with its
  own labels (lib/languages.js).

## Host panes

The Dashboard arranges the views in panes; an application may add panes of
its own beside them — an entry form next to the map — and presets that
arrange them:

```js
store.getState().setHostPanes(
  [{ key: 'host:enter', label: 'Enter', icon: '✎', Component: EnterPane }],
  [{ key: 'enter-map', label: 'Enter │ Map', panes: ['host:enter', 'map'] }], // dir 'row' | 'col', ratio; a third pane goes under the second
)
store.getState().setViewsAlso(['matrix']) // offered although the graph has no unit yet
```

`Component` gets `{ active }` and fills its pane; its look is the
application's (the pane sits inside `.ge-root`, whose base rules have zero
specificity). The selection the views share (`selectedId`) is the
application's to follow.

## Editing

The GraphExplorer only shows. A host that can change the data passes an
**editor** — `createExplorerStore({ editor })` or `store.getState().setEditor(editor)` —
and the views offer editing where it has a say:

```js
const editor = {
  // May this attribute of this node be changed? If not, say why.
  describeAttribute(nodeId, key) { return { editable: true } /* or { editable: false, reason } */ },
  // Change it. The host then hands over the updated graph (updateGraph).
  setAttribute(nodeId, key, value) { return { ok: true } /* or { ok: false, error } */ },
}
```

- **Explorer** — a ✎ beside every attribute in the detail view: asks
  `describeAttribute` first, shows the reason when the answer is no, edits in
  place otherwise. A geometry (WKT) also offers "edit on map".
- **Map** — "✎ Edit geometries": a click on a geometry opens it with its
  vertices as handles (drag to move, click a hollow handle to add, right-click
  to remove), zoomed to it; Save writes it back through `setAttribute`.
  `lib/wktEdit.js` keeps every untouched coordinate as written and writes new
  ones in the source's precision, so a change is no larger than what was
  moved; the dataset's coordinate system is kept (`projectionFor` in
  `lib/geo.js`).

Without an editor none of this renders, and the views are exactly what they
were.

### Editing the matrix

An editor may also carry `matrix` — the Matrix view then offers "✎ Edit
matrix": a line dragged from one unit to another asks which relation it is, a
line clicked can be changed or removed, "＋ Relation" enters one by name, also
with a unit not in the matrix yet.

```js
editor.matrix = {
  describe({ baseProp, typeKey }) { return { editable: true } /* or { editable: false, reason } */ },
  addRelation({ baseProp, typeKey, a, b, kind, word, newUnits }) { return { ok: true } },
  setRelation({ baseProp, typeKey, a, b, kind, word, from }) { return { ok: true } },
  removeRelation({ baseProp, typeKey, a, b, kind }) { return { ok: true } },
  suggestIdentifier({ baseProp, typeKey, label }) { return 'an identifier for a new unit' },
  rules() { return [{ typeKey, baseProp, label }] }, // optional: matrices the mapping holds, also with no unit yet
  openProtocol(unitId) {}, hasProtocols() { return true }, // optional: "Protocol" in the unit panel opens the host's form
  positions: { load(key) { return {} }, save(key, positions) {} }, // optional: units placed by hand, kept per view
}
```

A click on a unit lists all its relations — each with its kind to change and a
✕ to remove — and an opened finding of the checks lists the relations it is
about, each removable on its own: the way to one relation when lines run on
top of each other. Units can be pulled aside; "Arrange" lays the matrix out
again. With `positions` the editor keeps where they were put — per matrix view
(`key`: type, relation, phase and object property), `positions` = `{ unitId:
{ x, y } }`, saved after every change by hand; without it they last for the
session. `removeRelation` with `kind` removes only what says
"a <kind> b" (of "A above B" and "B above A", the one meant), without `kind`
everything between the two; `setRelation` takes `from` for the kind replaced.

`kind` is one of `RELATION_KINDS` (lib/harrisMatrix.js) and reads "a <kind> b";
`word` is how this dataset spells it (`qualifierVocabulary`). `a`/`b` are node
ids, or null with `newUnits.a`/`newUnits.b` = `{ label, identifier }`.

The checks (lib/matrixChecks.js) show in every case, editor or not.

### Unit types

Units of the Harris Matrix Editor's types — layer, deposit, fill, structure,
interface, read from the label of a type a unit points at — are drawn as the
HME draws them: its colour (unless a colouring is chosen), its symbol and
border, an interface round; a legend lists them. An editor may carry
`matrix.unitTypes` — the unit panel of the edit mode then offers "Type":

```js
editor.matrix.unitTypes = {
  describe({ typeKey }) { return { available: true, edgeKey, options: ['layer', 'deposit', …] } /* or { available: false, reason } */ },
  assign({ typeKey, unitId, value }) { return { ok: true } }, // value '' for none
}
```

`edgeKey` is the key of the units' type relation in the graph, which the panel
reads the current type through.

### Phases

The Matrix view stacks the units phase by phase when they point at a phase
through one property — P10 falls within (to an E4 Period) by default, any
other relation by choice ("Phases: …"). The phases are ordered by P120 occurs
before between them (the earlier before the later), without it by name; the
youngest is drawn on top, units without a phase at the bottom. The checks then
also report an older phase above a younger (error), relations that skip a
phase, contemporary or equal units in different phases, and units without a
phase (warnings). All of this works without an editor (lib/matrixPhases.js).

An editor may carry `matrix.phases` — the edit mode then offers "◧ Phases"
(create, order, rename, remove) and a phase for the selected unit:

```js
editor.matrix.phases = {
  describe({ typeKey }) { return { available: true, edgeKey } /* or { available: false, canAdd, reason } */ },
  list({ typeKey }) { return [{ id, label }] /* youngest first, also phases no unit belongs to yet */ },
  addToMapping({ typeKey }) { return { ok: true } },   // offered when canAdd
  create({ typeKey, label }) { return { ok: true } },  // the new phase is the youngest
  rename({ typeKey, phaseId, label }) { return { ok: true } },
  move({ typeKey, phaseId, direction }) { return { ok: true } }, // 'younger' | 'older'
  remove({ typeKey, phaseId }) { return { ok: true } },
  assign({ typeKey, unitId, phaseId }) { return { ok: true } },  // phaseId null: none; unitIds: several at once, one undo
}
```

`edgeKey` is the key the units' phase relation has in the graph; the list of
the editor gives the order whenever that key is the one shown.

### Objects and object groups

Units that form part of an object (P46i forms part of — a wall, a room, a
grave; any such relation by choice under "Objects: …") are kept together in the
layout and framed, with the object's name; objects that form part of a group
(P46i again) get a frame around them. Within phases, an object with units in
two phases gets a frame in each. One object per unit is expected; a unit with
more is kept with its first and reported by the checks (lib/matrixObjects.js,
`layoutHarrisMatrix(…, nest)` in lib/dagreLayout.js).

An editor may carry `matrix.objects` — the edit mode then offers "▢ Objects"
and an object for the selected unit (a new one by name):

```js
editor.matrix.objects = {
  describe({ typeKey }) {
    return { available: true, edgeKey, groupEdgeKey, groups, standalone, groupsStandalone, canAddGroups }
    /* or { available: false, canAdd, reason } */
  },
  list({ typeKey }) { return { objects: [{ id, label, group }], groups: [{ id, label }] } },
  addToMapping({ typeKey }) { return { ok: true } },          // objects and/or groups
  createObject({ typeKey, label }), createGroup({ typeKey, label }),   // when standalone
  renameObject({ typeKey, objectId, label }), renameGroup({ typeKey, groupId, label }),
  removeObject({ typeKey, objectId }), removeGroup({ typeKey, groupId }),
  assign({ typeKey, unitId, objectId, newLabel }),            // objectId null: none
  setGroup({ typeKey, objectId, groupId, newLabel }),
}
```

`standalone` says objects can exist before a unit belongs to them (a table of
their own); otherwise an object exists through the units that name it, and a
new one is given by name to a unit.
