import pRetry from 'p-retry';
import * as cheerio from 'cheerio';
import { getBrowser, fetchPage } from '../../browser.js';
import { extractReadable, extractBySelector } from '../../readability.js';
import { buildArticle } from '../../articleBuilder.js';
import { isToday, normalizeDate, todayString } from '../../dateParser.js';
import logger from '../../logger.js';
import config from '../../config.js';

const SOURCE_ID   = 'greaterkashmir';
const BASE_URL    = 'https://www.greaterkashmir.com';
const OPINION_URL = config.sources.greaterkashmir.opinionUrl;

export async function scrapeGreaterKashmir() {
  logger.info(`[GK] Fetching opinion page → ${OPINION_URL}`);
  const browser  = await getBrowser();
  const articles = [];

  try {
    const html = await pRetry(
      () => fetchPage(browser, OPINION_URL, 'div.gh-archive-page-post', { waitForNetworkIdle: true }),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[GK] Retry: ${e.message}`) }
    );

    const cards = extractTodayCards(html);

    if (cards.length === 0) {
      logger.warn('[GK] No today opinion articles found.');
      return [];
    }
    logger.info(`[GK] Found ${cards.length} today opinion article(s).`);

    for (const card of cards) {
      const article = await openArticle(browser, card.url, card.date);
      if (article === 'stop') {
        logger.info('[GK] Reached older article. Stopping.');
        break;
      }
      if (article) {
        articles.push(article);
        logger.article('SAVED', article.title, article.url);
      }
    }
  } catch (err) {
    logger.error(`[GK] Fatal: ${err.message}`);
  }

  logger.success(`[GK] Done. ${articles.length} article(s) harvested.`);
  return articles;
}

function extractTodayCards(html) {
  const $ = cheerio.load(html);
  const cards = [];

  $('div.gh-archive-page-post').each(function () {
    const $card = $(this);
    const text  = $card.text();

    let dateStr = '';
    $card.find('time').each(function () {
      const d = $(this).attr('datetime') || $(this).text().trim();
      if (d) dateStr = d;
    });
    if (!dateStr) {
      dateStr = normalizeDate(text);
    }
    const date = dateStr ? normalizeDate(dateStr) : null;

    if (!date) return;

    if (!isToday(date)) {
      const refStr = todayString();
      const cardDate = new Date(date);
      const refDate  = new Date(refStr);
      if (cardDate > refDate) {
        return;
      }
      logger.debug(`[GK] Stopping at non-today date: ${dateStr}`);
      return false;
    }

    const linkEl = $card.find('h2 a[href]').first();
    const href = resolveUrl(linkEl.attr('href') || '', BASE_URL);
    if (!href) return;

    cards.push({ url: href, date });
  });

  return cards;
}

async function openArticle(browser, url, publishedDate) {
  const html = await pRetry(
    () => fetchPage(browser, url),
    { ...config.retry, onFailedAttempt: (e) => logger.warn(`[GK] Retry ${url}: ${e.message}`) }
  );

  const $ = cheerio.load(html);

  const articleDate =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    '';
  const normDate = normalizeDate(articleDate);
  if (normDate && !isToday(normDate)) return 'stop';

  const title = $('h1').first().text().trim() || $('title').text().trim();

  $('article.gh-post-page__article > div:nth-child(n+5)').remove();
  const cleanedHtml = $.html();

  const readable = extractReadable(html, url);
  const content  = (readable && readable.html) ? readable : extractBySelector(
    cleanedHtml,
    '.gh-post-page__article, .post-content, .gh-post-page__content, .entry-content, main, article',
    url
  );

  if (!content || !content.html) {
    logger.warn(`[GK] No content at ${url}`);
    return null;
  }

  return buildArticle({
    ...content,
    title,
    url,
    canonical_url: $('link[rel="canonical"]').attr('href') || url,
    published_at:  normDate || publishedDate,
    category:      'Opinion',
  }, SOURCE_ID);
}

function resolveUrl(href, base) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return ''; }
}
