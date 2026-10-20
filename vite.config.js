import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 3002: the Studio runs on 3000, the GraphExplorer on 3001, HME on 3000.
// All four are meant to be open at once.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    open: true,
    proxy: {
      // The vocabulary server sends no Access-Control-Allow-Origin header, so a
      // browser refuses to read it directly. Forwarding through the dev server
      // makes the request same-origin. See src/lib/thesaurusSources.js.
      '/vocabs': {
        target: 'https://vocabs-downloads.acdh.oeaw.ac.at',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/vocabs/, ''),
      },
    },
  },
})
