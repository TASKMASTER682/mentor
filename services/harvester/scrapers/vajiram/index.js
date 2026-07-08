import pRetry from 'p-retry';
import * as cheerio from 'cheerio';
import { getBrowser, fetchPage } from '../../browser.js';
import { buildArticle } from '../../articleBuilder.js';
import { cleanHtml, htmlToText, wordCount, readingTime } from '../../htmlCleaner.js';
import { todayParts, todayString } from '../../dateParser.js';
import logger from '../../logger.js';
import config from '../../config.js';

const SOURCE_ID = 'vajiram';
const BASE_URL  = 'https://vajiramandravi.com';
const ARCHIVE   = `${BASE_URL}/current-affairs/daily-editorial-analysis/`;

export async function scrapeVajiram() {
  const browser  = await getBrowser();
  const articles = [];

  try {
    const todayUrl = await findTodayUrl(browser);
    if (!todayUrl) {
      logger.warn('[Vajiram] No editorial found for today on archive page.');
      return [];
    }

    logger.info(`[Vajiram] Fetching → ${todayUrl}`);
    const html = await pRetry(
      () => fetchPage(browser, todayUrl),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[Vajiram] Retry: ${e.message}`) }
    );

    articles.push(...extractArticlesFromPage(html, todayUrl));
  } catch (err) {
    logger.error(`[Vajiram] Fatal: ${err.message}`);
  }

  logger.success(`[Vajiram] Done. ${articles.length} article(s) harvested.`);
  return articles;
}

async function findTodayUrl(browser) {
  const { day, month, year } = todayParts();
  const dateStr = `${day}-${month}-${year}`;
  const search = `daily-editorial-analysis-${dateStr}`;
  const direct = `${BASE_URL}/current-affairs/${search}/`;

  try {
    const html = await pRetry(
      () => fetchPage(browser, direct),
      { ...config.retry, onFailedAttempt: () => {} }
    );
    if (!html.includes('Page Not Found') && !html.includes('error404')) {
      return direct;
    }
  } catch {}

  try {
    const html = await pRetry(
      () => fetchPage(browser, ARCHIVE),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[Vajiram] Archive retry: ${e.message}`) }
    );
    const $ = cheerio.load(html);
    let found = '';
    $(`a[href*="${search}"]`).each(function () {
      found = $(this).attr('href') || '';
    });
    if (found) return found.startsWith('http') ? found : `${BASE_URL}${found}`;
  } catch {}

  return null;
}

function extractArticlesFromPage(html, url) {
  const $ = cheerio.load(html);
  const articles = [];

  $('nav,header,footer,.sidebar,.ads,.share,.related,script,style,noscript,iframe').remove();

  let container = $('.audio').first();
  if (!container.length) {
    container = $('.entry-content').first();
  }
  if (!container.length) {
    logger.warn('[Vajiram] No content container found on page.');
    return articles;
  }

  const headings = container.find('h2');

  if (headings.length === 0) {
    const cleaned = cleanHtml(container.html() || '', url);
    const plain   = htmlToText(cleaned);
    const wc      = wordCount(plain);
    if (plain.length >= 100) {
      articles.push(buildArticle({
        title:       $('h1').first().text().trim() || 'Editorial',
        html:        cleaned,
        plain_text:  plain,
        word_count:  wc,
        reading_time: readingTime(wc),
        url,
        published_at: todayISO(),
        category:    'Editorial',
        lang:        'en',
      }, SOURCE_ID));
    }
    return articles;
  }

  const children = container.contents().toArray();
  let currentParts = [];
  let currentTitle = '';
  let articleNum = 0;

  for (const node of children) {
    const $node = $(node);
    if (node.type === 'tag' && node.name === 'h2') {
      if (currentTitle && currentParts.length > 0) {
        articleNum++;
        const sectionHtml = currentParts.join('\n');
        const cleaned     = cleanHtml(sectionHtml, url);
        const plain       = htmlToText(cleaned);
        const wc          = wordCount(plain);
        if (plain.length >= 100) {
          articles.push(buildArticle({
            title:       currentTitle,
            html:        cleaned,
            plain_text:  plain,
            word_count:  wc,
            reading_time: readingTime(wc),
            url:         `${url}#article-${articleNum}`,
            published_at: todayISO(),
            category:    'Editorial',
            lang:        'en',
          }, SOURCE_ID));
        }
      }
      currentTitle = $node.text().trim();
      currentParts = [$node.toString()];
    } else if (currentTitle) {
      currentParts.push($node.toString());
    }
  }

  if (currentTitle && currentParts.length > 0) {
    articleNum++;
    const sectionHtml = currentParts.join('\n');
    const cleaned     = cleanHtml(sectionHtml, url);
    const plain       = htmlToText(cleaned);
    const wc          = wordCount(plain);
    if (plain.length >= 100) {
      articles.push(buildArticle({
        title:       currentTitle,
        html:        cleaned,
        plain_text:  plain,
        word_count:  wc,
        reading_time: readingTime(wc),
        url:         `${url}#article-${articleNum}`,
        published_at: todayISO(),
        category:    'Editorial',
        lang:        'en',
      }, SOURCE_ID));
    }
  }

  return articles;
}

function todayISO() {
  return todayString();
}
