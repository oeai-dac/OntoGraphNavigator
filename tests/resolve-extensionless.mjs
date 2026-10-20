/**
 * Node resolve hook for Vite-style imports.
 *
 * The modules under src/lib import without a file extension (`from './keys'`),
 * which Vite resolves and Node does not. Rather than change project code to
 * suit the test runner, the runner adapts.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?js$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context)
    }
    throw err
  }
}
