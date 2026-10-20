/**
 * Keys must come out of this tool exactly as they come out of the Studio.
 *
 * A "#as:" key is how the Studio, the GraphExplorer and this tool recognise one
 * type as the same; a dot-one value decides whether a stratigraphic relation is
 * mirrored. Two tools that read one name differently file the same data under
 * two types. The Studio's export is the reference, so the table below is the
 * one its import test (tests/test_graph_json_import.py) holds as well — change
 * both or neither.
 *
 *   node tests/run-keys-check.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { slugify, typeKey, canonicalDot1, oppositeDot1 } = await import(pathToFileURL(path.join(root, 'src/lib/keys.js')))

let failures = 0
const check = (cond, what) => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}`)
  if (!cond) failures++
}

// ---- the shared table (same as the Studio's) ----------------------------------
const SLUGS = [
  ['Fund (human-made)', 'fund_human_made'],
  ['Link zu oeai.DAM', 'link_zu_oeai_dam'],
  ['Grabungsfläche', 'grabungsflaeche'],
  ['Straße', 'strasse'],
  ['Ölmühle', 'oelmuehle'],
  ['Café', 'cafe'],
  ['Čech', 'cech'],
  ['Łódź', 'lodz'],
  ['Søren', 'soren'],
  ['Œuvre', 'oeuvre'],
  ['Volume (m³)', 'volume_m3'],
  ['日本語', 'x'],
  ['Grabungsfläche', 'grabungsflaeche'], // "ä" as a + combining diaeresis
]
const wrong = SLUGS.filter(([name, slug]) => slugify(name) !== slug)
check(!wrong.length, `slugs: all ${SLUGS.length} names give the Studio's slug` +
  (wrong.length ? ` — differ: ${wrong.map(([n, s]) => `${n} -> ${slugify(n)} (Studio: ${s})`).join('; ')}` : ''))

check(typeKey('X', '') === 'X' && typeKey('X', '  ') === 'X', 'no Explorer name, no "#as:" — as in the Studio')
check(typeKey('X', '!!!') === 'X#as:x', 'a name of nothing but symbols becomes "x" — as in the Studio')

const DOT1 = [
  ['ueber', 'ueber', 'unter'],
  ['Über ', 'ueber', 'unter'],
  ['oeai:ueber', 'ueber', 'unter'],
  ['https://www.oeaw.ac.at/oeai/unter', 'unter', 'ueber'],
  ['https://www.oeaw.ac.at/oeai/Relationstyp_above', 'above', 'below'],
  ['your_prefix:above', 'above', 'below'],
  ['contemporary_with', 'contemporary with', 'contemporary with'],
  ['schneidet', 'schneidet', null],
]
const wrongDot1 = DOT1.filter(([v, canon, opp]) => canonicalDot1(v) !== canon || oppositeDot1(v) !== opp)
check(!wrongDot1.length, `dot-one values: all ${DOT1.length} read as the Studio's export reads them` +
  (wrongDot1.length ? ` — differ: ${wrongDot1.map(([v]) => `${v} -> ${canonicalDot1(v)}/${oppositeDot1(v)}`).join('; ')}` : ''))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — keys as in the Studio')
process.exit(failures ? 1 : 0)
