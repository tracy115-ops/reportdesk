import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  optimizeDeps: { include: ['exceljs', '@xmldom/xmldom', 'fflate', 'papaparse', 'docx', 'pptxgenjs', 'pdf-lib', 'pdfjs-dist/legacy/build/pdf.mjs'] },
  build: { target: 'chrome111', assetsInlineLimit: file => /\.(docx|xlsx)$/i.test(file) ? false : undefined },
  clearScreen: false,
});
