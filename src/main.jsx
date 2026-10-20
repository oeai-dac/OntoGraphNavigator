import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
// The page side of the link to QGIS and Blender — the GraphExplorer's, from the
// views (npm run sync-views). Silent until a plugin connects; the small bar at
// the bottom left connects one. The API it uses is set up in ViewsHost.
import './views/bridge/explorer-bridge.js'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
