/**
 * Project languages — the Studio's model, read and honoured here.
 *
 * Since Studio 3.1 a project has a primary language and possibly further ones
 * (`languages` in the project file). The plain fields — `labelColumn`,
 * `explorerLabel` — hold the primary language; the further ones sit in sibling
 * maps on the canvas node (`labelColumnI18n`, `explorerLabelI18n`). Same rule,
 * same names as the Studio's frontend/src/utils/languages.js.
 *
 * A project saved before 3.1 names no languages. Everything such a project
 * exported was tagged @en by a hard-coded tag — whatever language the text was
 * in. The Studio therefore opens it with its default primary language and says
 * so, rather than keep a tag that was never a decision. So does this tool.
 */

/** The Studio's default — DEFAULT_LANGUAGES in its utils/languages.js. */
export const DEFAULT_PRIMARY = 'de'

// Deliberately permissive: a BCP-47 tag is `de`, `en`, `de-AT`. Only what
// would break an RDF literal's language tag is rejected.
const LANG_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/

export const normalizeLangTag = (tag) => String(tag || '').trim().toLowerCase()
export const isValidLangTag = (tag) => LANG_TAG.test(String(tag || '').trim())

/** Non-empty primary, lower-case tags, no duplicates, primary not among the others. */
export function normalizeLanguages(raw) {
  const primary = normalizeLangTag(raw?.primary) || DEFAULT_PRIMARY
  const seen = new Set([primary])
  const additional = []
  for (const tag of Array.isArray(raw?.additional) ? raw.additional : []) {
    const t = normalizeLangTag(tag)
    if (!t || !isValidLangTag(t) || seen.has(t)) continue
    seen.add(t)
    additional.push(t)
  }
  return { primary, additional }
}

/** The languages a model works with: its own, or the Studio's default for an older file. */
export function languagesOf(model) {
  return model?.languages || { primary: DEFAULT_PRIMARY, additional: [] }
}

export const isMultilingual = (langs) => (langs?.additional?.length || 0) > 0

/** Primary first — the order every language list is shown in. */
export const allLanguages = (langs) => [langs.primary, ...langs.additional]
