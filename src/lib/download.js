/** Hand content (text or bytes) to the browser as a download. No server involved. */
export function download(name, mime, content) {
  const type = typeof content === 'string' ? `${mime};charset=utf-8` : mime
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick: Safari needs the object to still exist at click time.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
