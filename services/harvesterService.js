import { runHarvest, runYesterdayHarvest } from './harvester/index.js';
import { loadJson } from './harvester/jsonExporter.js';

export async function scrapeSource(source, mode) {
  const fn = mode === 'today' ? runHarvest : runYesterdayHarvest;
  if (typeof fn !== 'function') {
    return { success: false, error: `Harvest function '${mode}' not loaded.`, code: 'SCRAPER_NOT_LOADED' };
  }

  try {
    const stats = await fn(source);
    const data = await loadJson();
    return { success: true, stats, articles: data?.articles || [] };
  } catch (err) {
    const detail = err?.stack || err?.message || String(err);
    console.error(`[HarvesterService] ${mode} scrape error for ${source}:`, detail);
    return { success: false, error: err?.message || String(err), code: 'SCRAPER_ERROR' };
  }
}
