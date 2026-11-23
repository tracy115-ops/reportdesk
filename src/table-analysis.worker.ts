import { analyzeTables } from './table-analysis';
import type { TableAnalysisSpec, WorkbookSheet } from './table-analysis';

self.addEventListener('message', ({ data }: MessageEvent<{ spec: TableAnalysisSpec; tables: WorkbookSheet[] }>) => {
  try { self.postMessage({ result: analyzeTables(data.spec, data.tables) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'analysis_failed' }); }
});
