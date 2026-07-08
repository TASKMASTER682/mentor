import pLimit from 'p-limit';
import pRetry from 'p-retry';
import * as cheerio from 'cheerio';
import { getBrowser, fetchPage } from '../../browser.js';
import { extractReadable, extractBySelector } from '../../readability.js';
import { buildArticle } from '../../articleBuilder.js';
import { isToday, normalizeDate } from '../../dateParser.js';
import logger from '../../logger.js';
import config from '../../config.js';

const SOURCE_ID = 'pw';
const BASE_URL  = 'https://pwonlyias.com';
const INDEX_URL = config.sources.pw.url;

export async function scrapePw() {
  logger.info(`[PW] Starting scrape → ${INDEX_URL}`);
  const browser  = await getBrowser();
  const articles = [];

  try {
    const indexHtml = await pRetry(
      () => fetchPage(browser, INDEX_URL),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[PW] Index retry: ${e.message}`) }
    );

    const todayLinks = extractTodayCards(indexHtml);

    if (todayLinks.length === 0) {
      logger.warn("[PW] No today's editorial cards found.");
      return [];
    }
    logger.info(`[PW] Found ${todayLinks.length} today's editorial link(s).`);

    const limit   = pLimit(config.concurrency.pages);
    const tasks   = todayLinks.map(({ url, meta }) =>
      limit(() => scrapeArticle(browser, url, meta))
    );

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        articles.push(r.value);
        logger.article('SAVED', r.value.title, r.value.url);
      } else if (r.status === 'rejected') {
        logger.error(`[PW] Failed: ${r.reason?.message}`);
      }
    }
  } catch (err) {
    logger.error(`[PW] Fatal: ${err.message}`);
  }

  logger.success(`[PW] Done. ${articles.length} article(s) harvested.`);
  return articles;
}

function extractTodayCards(html) {
  const $ = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  const cards = $('div.col-md-4');

  for (const card of cards) {
    const $card = $(card);
    const text  = $card.text();

    const dateMatch = text.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2})\b/i);
    const dateText = dateMatch ? dateMatch[1] : '';
    const date = normalizeDate(dateText);

    if (!date || !isToday(date)) {
      logger.debug(`[PW] Stopping at non-today date: ${dateText || 'none'}`);
      break;
    }

    const linkEl = $card.find('a[href]').first();
    const href = resolveUrl(linkEl.attr('href') || '', BASE_URL);
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = $card.find('h2, h3, .title, [class*="title"]').first().text().trim()
      || linkEl.text().trim();

    links.push({
      url: href,
      meta: { title, published_at: date },
    });
  }

  return links;
}

async function scrapeArticle(browser, url, meta = {}) {
  const html = await pRetry(
    () => fetchPage(browser, url),
    { ...config.retry, onFailedAttempt: (e) => logger.warn(`[PW] Retry ${url}: ${e.message}`) }
  );

  const readable = extractReadable(html, url);
  const $ = cheerio.load(html);

  const canonicalUrl  = $('link[rel="canonical"]').attr('href') || url;
  const featuredImage = $('meta[property="og:image"]').attr('content') || '';
  const description   = $('meta[name="description"]').attr('content') || '';
  const publishedAt   =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    meta.published_at ||
    new Date().toISOString().split('T')[0];

  const content = (readable && readable.html) ? readable : extractBySelector(
    html,
    'div.desc:nth-child(4), .entry-content, .post-content, .pf-content, article, main, #content',
    url
  );

  if (!content || !content.html) {
    logger.warn(`[PW] No content extracted: ${url}`);
    return null;
  }

  return buildArticle({
    ...content,
    title:         readable?.title || meta.title || content.title || '',
    url,
    canonical_url: canonicalUrl,
    featured_image: featuredImage,
    description,
    published_at:  publishedAt,
    category:      'Editorial',
  }, SOURCE_ID);
}

function resolveUrl(href, base) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return new URL(href, base).href;
}
