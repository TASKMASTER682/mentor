import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ready = false;
let loadJson = null;
let runHarvest = null;
let runYesterdayHarvest = null;

try {
  const HARVESTER_SRC = path.resolve(__dirname, '../../upsc-harvester/src');
  const req = createRequire(import.meta.url);

  const { runHarvest: rh, runYesterdayHarvest: ryh } = req(path.join(HARVESTER_SRC, 'services/harvestService.js'));
  const { loadJson: lj } = req(path.join(HARVESTER_SRC, 'utils/jsonExporter.js'));

  runHarvest = rh;
  runYesterdayHarvest = ryh;
  loadJson = lj;
  ready = true;
} catch (err) {
  console.warn('[HarvesterService] upsc-harvester not available. Scraping disabled.', err.message);
}

export async function scrapeSource(source, mode) {
  if (!ready) {
    return { success: false, error: 'Scraper modules not available (upsc-harvester missing or incomplete).', code: 'SCRAPER_UNAVAILABLE' };
  }

  try {
    const fn = mode === 'today' ? runHarvest : runYesterdayHarvest;
    const stats = await fn(source);
    const data = await loadJson();
    return { success: true, stats, articles: data?.articles || [] };
  } catch (err) {
    return { success: false, error: err.message, code: 'SCRAPER_ERROR' };
  }
}
