/** The BDA protocol packages (protocols/*.zip) — what a project adds in the Navigator. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The packages are kept on this machine only, like the reference data: the checks that need them skip themselves. */
export const havePackages = fs.existsSync(path.join(root, 'protocols')) && fs.readdirSync(path.join(root, 'protocols')).some((f) => f.endsWith('.zip'))
export const SKIP_PACKAGES = 'skip  the BDA protocol packages (protocols/) are not in this copy — they are not distributed with the Navigator'

export async function bdaPackages() {
  if (!havePackages) return []
  const { packageFromFiles } = await import(pathToFileURL(path.join(root, 'src/lib/protocols.js')))
  return fs.readdirSync(path.join(root, 'protocols')).filter((f) => f.endsWith('.zip')).sort().map((f) => {
    const files = unzipSync(new Uint8Array(fs.readFileSync(path.join(root, 'protocols', f))))
    return { ...packageFromFiles(files), imported: true, files }
  })
}
