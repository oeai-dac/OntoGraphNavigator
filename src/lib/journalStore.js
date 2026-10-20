/**
 * Where the journal is kept between one keystroke and the next.
 *
 * IndexedDB, not `localStorage`. HME gets away with `localStorage` because its
 * projects are a few hundred kilobytes; here the tables alone are around 11 MB
 * and the 5 MB quota would be reached in the middle of a session, silently.
 *
 * The only module in the project that touches browser storage, so everything
 * else stays testable under Node.
 */

const DB_NAME = 'ontographnavigator'
const DB_VERSION = 2
const ENTRIES = 'entries'
const SESSIONS = 'sessions'
const SNAPSHOTS = 'snapshots'
const PACKAGES = 'packages' // protocol packages imported by the user, as their files

export const available = () => typeof indexedDB !== 'undefined'

function open() {
  return new Promise((resolve, reject) => {
    if (!available()) {
      reject(new Error('This browser has no IndexedDB, so nothing can be saved between reloads.'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const store = db.createObjectStore(ENTRIES, { keyPath: ['session', 'seq'] })
        store.createIndex('session', 'session')
      }
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'session' })
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'session' })
      if (!db.objectStoreNames.contains(PACKAGES)) db.createObjectStore(PACKAGES, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function run(store, mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const result = work(tx.objectStore(store))
        tx.oncomplete = () => {
          db.close()
          resolve(result)
        }
        tx.onerror = () => {
          db.close()
          reject(tx.error)
        }
      })
  )
}

/** Record the session header — author, start time, which files were loaded. */
export function saveSession(journal) {
  const { session, author, startedAt, inputs } = journal
  return run(SESSIONS, 'readwrite', (store) => store.put({ session, author, startedAt, inputs, savedAt: new Date().toISOString() }))
}

/**
 * Append entries.
 *
 * Appending rather than rewriting is the point: a crash costs at most the
 * entries since the last call, and the store never has to hold two copies of
 * a long history.
 */
export function appendEntries(session, entries) {
  if (!entries.length) return Promise.resolve()
  return run(ENTRIES, 'readwrite', (store) => {
    for (const entry of entries) store.put({ ...entry, session })
  })
}

export function loadEntries(session) {
  return run(ENTRIES, 'readonly', (store) => {
    const index = store.index('session')
    const request = index.getAll(session)
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.seq - b.seq))
    })
  }).then((promise) => promise)
}

export function listSessions() {
  return run(SESSIONS, 'readonly', (store) => {
    const request = store.getAll()
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)))
    })
  }).then((promise) => promise)
}

/**
 * The tables as they currently stand, so a reload does not have to replay a
 * whole session. Kept separately from the entries because it is large and
 * rewritten wholesale.
 */
export function saveSnapshot(session, payload) {
  return run(SNAPSHOTS, 'readwrite', (store) =>
    store.put({ session, savedAt: new Date().toISOString(), payload })
  )
}

export function loadSnapshot(session) {
  return run(SNAPSHOTS, 'readonly', (store) => {
    const request = store.get(session)
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || null)
    })
  }).then((promise) => promise)
}

export function forgetSession(session) {
  return Promise.all([
    run(SESSIONS, 'readwrite', (store) => store.delete(session)),
    run(SNAPSHOTS, 'readwrite', (store) => store.delete(session)),
    run(ENTRIES, 'readwrite', (store) => {
      const index = store.index('session')
      const request = index.getAllKeys(session)
      request.onsuccess = () => {
        for (const key of request.result) store.delete(key)
      }
    }),
  ])
}

// ---- protocol packages ------------------------------------------------------------

/** Keep an imported protocol package: its files by name. */
export function savePackageFiles(id, files) {
  return run(PACKAGES, 'readwrite', (store) => store.put({ id, savedAt: new Date().toISOString(), files }))
}

/** Every kept package: [{ id, files }]. */
export function loadPackageFiles() {
  return run(PACKAGES, 'readonly', (store) => {
    const request = store.getAll()
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || [])
    })
  }).then((promise) => promise)
}

export function forgetPackage(id) {
  return run(PACKAGES, 'readwrite', (store) => store.delete(id))
}
