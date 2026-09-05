import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.tsx', '.ts', '.mjs', '.js', '.jsx', '.json']
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true }
})
