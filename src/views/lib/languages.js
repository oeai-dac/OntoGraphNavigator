/**
 * The graph in a language of the project (OntoCartographer Studio 3.1+).
 *
 * A multilingual graph names its languages (`graph.languages`: { primary,
 * additional }) and carries, beside each node's label `l` in the primary
 * language, its translations (`l_i18n`: { lang: text }); the type names the
 * same way (`schema.typeLabelsI18n`). Attribute and relation names come in the
 * primary language only.
 *
 * localizeGraph gives the views the graph as it reads in one language: the
 * nodes that have a translation as copies with it as their label (the primary
 * one kept as `l_primary`, which search still finds), the type names likewise;
 * everything else is the very same object. So every view shows the language
 * without knowing of it, and an editor still edits by node id.
 */

/** The languages a graph has, or null for a graph in one language. */
export function languagesOf(graph) {
  const l = graph?.languages
  return l?.primary && Array.isArray(l.additional) && l.additional.length ? l : null
}

/** Primary first. */
export const allLanguages = (langs) => (langs ? [langs.primary, ...langs.additional] : [])

/** The graph read in `lang` — the same graph where there is nothing to change. */
export function localizeGraph(graph, lang) {
  const langs = languagesOf(graph)
  if (!graph || !lang || !langs || lang === langs.primary) return graph
  const nodes = {}
  let changed = false
  for (const id of Object.keys(graph.nodes)) {
    const nd = graph.nodes[id]
    const l = nd.l_i18n?.[lang]
    if (l && l !== nd.l) {
      nodes[id] = { ...nd, l, l_primary: nd.l }
      changed = true
    } else nodes[id] = nd
  }
  const typeLabels = graph.schema?.typeLabelsI18n?.[lang]
  if (!changed && !typeLabels) return graph
  return {
    ...graph,
    nodes: changed ? nodes : graph.nodes,
    schema: typeLabels ? { ...graph.schema, typeLabels: { ...(graph.schema.typeLabels || {}), ...typeLabels } } : graph.schema,
    displayLang: lang,
  }
}
