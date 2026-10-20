/**
 * One entry point for every file the Navigator accepts.
 *
 * Which file it is decides what the tool can do afterwards, so the result says
 * so explicitly rather than leaving the export screen to guess:
 *
 *   project  mapping + tables. Everything is possible, including writing the
 *            project file back.
 *   graph    a materialised graph. Display and export, but the target table and
 *            column of every field are gone, so no faithful project file.
 */

import { readProjectFile } from './projectFile'
import { createMaterializer } from './materialize'
import { DEFAULT_PRIMARY } from './languages'
import { needsScaffolding, scaffoldTables } from './scaffold'
import { readGraphJson, deriveModelFromGraph } from './graphJson'
import { importRdf } from './rdfImport'
import { convertHme, describeHmeReport, isHmeProject } from './hmeImport'
import { graphmlToHme } from './graphmlImport'

const RDF_EXTENSIONS = ['ttl', 'trig', 'nt', 'nq', 'n3']

export function extensionOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''))
  return m ? m[1].toLowerCase() : ''
}

/** Does this JSON look like a Studio project rather than a graph? */
function looksLikeProject(json) {
  return Array.isArray(json?.nodes) && Array.isArray(json?.edges)
}

/**
 * @param {string} filename
 * @param {string} text
 * @returns {{source: 'project'|'graph', graph: object, model: object|null,
 *            derived: object|null, report: object, warnings: string[]}}
 */
export function loadFile(filename, text, { packages = [] } = {}) {
  const extension = extensionOf(filename)
  const warnings = []

  if (extension === 'rdf' || extension === 'owl' || extension === 'xml') {
    throw new Error(
      'RDF/XML cannot be read — the parser this tool uses does not support it. Convert to Turtle or TriG first.'
    )
  }

  if (RDF_EXTENSIONS.includes(extension)) {
    const { graph, report } = importRdf(text, { title: filename })
    if (report.namedGraphs.length) {
      warnings.push(
        `${report.namedGraphs.length} named graph(s) were flattened — RDF import does not keep graph context.`
      )
    }
    if (report.skipped) warnings.push(`${report.skipped} statement(s) involving blank nodes were skipped.`)
    warnings.push('Loaded from RDF: relation names, colours and the table layout of the mapping are not available.')
    return { source: 'graph', graph, model: null, derived: deriveModelFromGraph(graph), report, warnings }
  }

  // A Harris matrix from yEd or the HME as GraphML: as an HME project (step 5c).
  if (extension === 'graphml') {
    return loadFile(filename.replace(/\.graphml$/i, '.json'), JSON.stringify(graphmlToHme(text)), { packages })
  }

  if (extension !== 'json' && extension !== '') {
    throw new Error(`Unsupported file type ".${extension}".`)
  }

  let json
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`Not valid JSON: ${error.message}`)
  }

  // A Harris Matrix Editor project becomes a project on the BDA mapping (step 4d).
  let hmeReport = null
  if (isHmeProject(json)) {
    const converted = convertHme(json, { packages })
    json = converted.json
    hmeReport = converted.report
    warnings.push(...describeHmeReport(hmeReport))
  }

  if (looksLikeProject(json)) {
    const model = readProjectFile(json)

    // A mapping without tables cannot be written into. Build them from the
    // mapping itself rather than presenting an empty tool.
    let scaffolded = null
    if (needsScaffolding(model)) {
      scaffolded = scaffoldTables(model)
      warnings.push(
        `This project brought no tables, so ${scaffolded.tables} were created from the mapping ` +
          `with ${scaffolded.columns} columns. Column names are derived from the display names — ` +
          `rename them in the Studio if you want different ones.`
      )
      warnings.push(...scaffolded.warnings)
    }

    // Kept and handed on: the write layer feeds it the edits, so the graph is
    // updated row by row instead of recomputed whole.
    if (!model.languages) {
      warnings.push(
        `This project was saved before the Studio named languages (3.1). Its labels are treated as ` +
          `${DEFAULT_PRIMARY} — the Studio's default — and tagged @${DEFAULT_PRIMARY} in RDF. ` +
          `If they are in another language, set it under Settings.`
      )
    }

    const materializer = createMaterializer(model)
    const { graph, diagnostics } = materializer.result()
    if (diagnostics.unpairable.length) {
      warnings.push(
        `${diagnostics.unpairable.length} mapping edge(s) connect different tables without a join key and produced nothing.`
      )
    }
    if (diagnostics.unmirroredDot1.size) {
      warnings.push(
        `Stratigraphic values outside the known vocabulary were kept one-way only: ${[...diagnostics.unmirroredDot1].join(', ')}.`
      )
    }
    return {
      source: 'project',
      graph,
      model,
      materializer,
      derived: null,
      report: {
        hme: hmeReport,
        scaffolded,
        tables: model.tables.size,
        rows: [...model.tables.values()].reduce((n, t) => n + t.rows.length, 0),
        entities: model.entities.size,
        relations: model.relations.length,
        ...diagnostics,
      },
      warnings,
    }
  }

  const { graph, report } = readGraphJson(json)
  if (report.dangling.length) {
    warnings.push(`${report.dangling.length} edge(s) point at nodes the file does not contain.`)
  }
  if (report.typeless) warnings.push(`${report.typeless} node(s) carry no type.`)
  warnings.push('Loaded from Graph-JSON: the mapping is not included, so the project file cannot be written back.')
  return { source: 'graph', graph, model: null, derived: deriveModelFromGraph(graph), report, warnings }
}
