import pLimit from 'p-limit';
import { scrapeVajiram } from './scrapers/vajiram/index.js';
import { scrapePw } from './scrapers/pw/index.js';
import { scrapeLegacyIas } from './scrapers/legacyias/index.js';
import { scrapeGreaterKashmir } from './scrapers/greaterkashmir/index.js';
import { saveJson } from './jsonExporter.js';
import { todayString, yesterdayString, setReferenceDate } from './dateParser.js';
import { closeBrowser } from './browser.js';
import logger from './logger.js';
import config from './config.js';

let harvestState = {
  running:   false,
  type:      null,
  startedAt: null,
  finishedAt: null,
  stats:     null,
};

export async function runHarvest(source) {
  if (harvestState.running) {
    throw new Error('Harvest already in progress');
  }

  harvestState.running   = true;
  harvestState.type      = 'today';
  harvestState.startedAt = Date.now();
  harvestState.finishedAt = null;
  harvestState.stats     = null;

  let stats = await doRun(todayString(), source);

  if (!source && stats.articles_found === 0) {
    logger.divider();
    logger.warn('No articles found for today. Falling back to yesterday...');
    logger.divider();
    stats = await doRun(yesterdayString());
  }

  harvestState.running    = false;
  harvestState.finishedAt = Date.now();
  harvestState.stats      = stats;

  try { await closeBrowser(); } catch {}

  return stats;
}

export async function runYesterdayHarvest(source) {
  if (harvestState.running) {
    throw new Error('Harvest already in progress');
  }

  harvestState.running   = true;
  harvestState.type      = 'yesterday';
  harvestState.startedAt = Date.now();
  harvestState.finishedAt = null;
  harvestState.stats     = null;

  try {
    const stats = await doRun(yesterdayString(), source);
    harvestState.stats = stats;
    return stats;
  } catch (err) {
    console.error('[runYesterdayHarvest] Error:', err?.stack || err?.message || err);
    throw err;
  } finally {
    harvestState.running  = false;
    harvestState.finishedAt = Date.now();
    try { await closeBrowser(); } catch {}
  }
}

async function doRun(harvestDate, source) {
  setReferenceDate(harvestDate);

  logger.divider();
  const sourceLabel = source ? `source: ${source}` : 'all sources';
  logger.info(`Harvest started — target date: ${harvestDate} (${sourceLabel})`);
  logger.divider();

  const sourceMap = {
    vajiram:       { fn: scrapeVajiram,        cfg: config.sources.vajiram },
    pw:            { fn: scrapePw,             cfg: config.sources.pw },
    legacyias:     { fn: scrapeLegacyIas,      cfg: config.sources.legacyias },
    greaterkashmir: { fn: scrapeGreaterKashmir, cfg: config.sources.greaterkashmir },
  };

  let entries = Object.entries(sourceMap);
  if (source) {
    if (!sourceMap[source]) {
      throw new Error(`Unknown source '${source}'. Valid sources: ${Object.keys(sourceMap).join(', ')}`);
    }
    entries = [[source, sourceMap[source]]];
  }

  const enabledSources = entries.filter(([, v]) => v.cfg.enabled);
  const disabledSources = entries.filter(([, v]) => !v.cfg.enabled);
  for (const [id, { cfg }] of disabledSources) {
    logger.info(`[Harvest] Source '${id}' (${cfg.name}) disabled — skipping.`);
  }
  const allArticles    = [];
  const sourceStats    = {};

  const limit = pLimit(config.concurrency.sources);
  const sourceTasks = enabledSources.map(([id, { fn }]) =>
    limit(async () => {
      const start = Date.now();
      try {
        const articles = await fn();
        sourceStats[id] = {
          status:   'success',
          count:    articles.length,
          duration: `${((Date.now() - start) / 1000).toFixed(1)}s`,
        };
        return articles;
      } catch (err) {
        logger.error(`[Harvest] Source '${id}' threw: ${err.message}`);
        sourceStats[id] = {
          status:   'error',
          count:    0,
          error:    err.message,
          duration: `${((Date.now() - start) / 1000).toFixed(1)}s`,
        };
        return [];
      }
    })
  );

  const results = await Promise.allSettled(sourceTasks);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      allArticles.push(...r.value);
    }
  }

  const seenUrls   = new Set();
  const seenTitles = new Set();
  const unique     = [];
  let   duplicates = 0;

  for (const article of allArticles) {
    const url   = article.url?.toLowerCase().trim();
    const title = article.title?.toLowerCase().trim();

    if (!url && !title) { duplicates++; continue; }
    if (url   && seenUrls.has(url))    { logger.article('DUPLICATE', article.title, article.url); duplicates++; continue; }
    if (title && seenTitles.has(title)) { logger.article('DUP TITLE', article.title, article.url); duplicates++; continue; }

    if (url)   seenUrls.add(url);
    if (title) seenTitles.add(title);
    unique.push(article);
  }

  let stats;
  try {
    const outputPath = await saveJson(unique, harvestDate);
    stats = {
      harvest_date:      harvestDate,
      total_sources:     enabledSources.length,
      articles_found:    allArticles.length,
      articles_saved:    unique.length,
      duplicates_removed: duplicates,
      runtime:           `${((Date.now() - harvestState.startedAt) / 1000).toFixed(1)}s`,
      output_location:   outputPath,
      sources:           sourceStats,
    };
  } catch (err) {
    console.error('[doRun] saveJson failed:', err?.stack || err?.message || err);
    throw err;
  }

  logger.summary({
    'Harvest Date':       stats.harvest_date,
    'Total Sources':      stats.total_sources,
    'Articles Found':     stats.articles_found,
    'Articles Saved':     stats.articles_saved,
    'Duplicates Removed': stats.duplicates_removed,
    'Runtime':            stats.runtime,
    'Output':             stats.output_location,
  });

  setReferenceDate(null);
  return stats;
}

export function getHarvestState() {
  return { ...harvestState };
}
