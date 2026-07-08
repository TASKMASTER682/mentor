import pRetry from 'p-retry';
import * as cheerio from 'cheerio';
import { getBrowser, fetchPage } from '../../browser.js';
import { cleanHtml, htmlToText, wordCount } from '../../htmlCleaner.js';
import { buildArticle } from '../../articleBuilder.js';
import { normalizeDate } from '../../dateParser.js';
import logger from '../../logger.js';
import config from '../../config.js';

const SOURCE_ID = 'legacyias';
const BASE_URL  = 'https://www.legacyias.com';
const INDEX_URL = config.sources.legacyias.url;

export async function scrapeLegacyIas() {
  logger.info(`[LegacyIAS] Starting scrape → ${INDEX_URL}`);
  const browser  = await getBrowser();
  const articles = [];

  try {
    const indexHtml = await pRetry(
      () => fetchPage(browser, INDEX_URL),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[LegacyIAS] Index retry: ${e.message}`) }
    );

    const dailyUrl = extractFirstDailyUrl(indexHtml);
    if (!dailyUrl) {
      logger.warn('[LegacyIAS] No daily PIB summary card found.');
      return [];
    }

    logger.info(`[LegacyIAS] Fetching → ${dailyUrl}`);
    const pageHtml = await pRetry(
      () => fetchPage(browser, dailyUrl),
      { ...config.retry, onFailedAttempt: (e) => logger.warn(`[LegacyIAS] Page retry: ${e.message}`) }
    );

    const parsed = parseDailyPage(pageHtml, dailyUrl);
    if (parsed.articles.length === 0) {
      logger.warn(`[LegacyIAS] No articles found on page: ${dailyUrl}`);
      return [];
    }

    for (const a of parsed.articles) {
      const article = buildArticle({
        title:        a.title,
        html:         a.cleanedHtml,
        plain_text:   a.plainText,
        word_count:   a.wordCount,
        url:          a.articleUrl,
        published_at: parsed.date,
        category:     'PIB Summary',
      }, SOURCE_ID);
      articles.push(article);
      logger.article('SAVED', article.title, article.url);
    }
  } catch (err) {
    logger.error(`[LegacyIAS] Fatal: ${err.message}`);
  }

  logger.success(`[LegacyIAS] Done. ${articles.length} article(s) harvested.`);
  return articles;
}

function extractFirstDailyUrl(html) {
  const $ = cheerio.load(html);
  const firstLink = $('.elementor-grid-item').first().find('a[href*="pib-summaries"]').attr('href');
  if (!firstLink) return '';
  return firstLink.startsWith('http') ? firstLink : new URL(firstLink, BASE_URL).href;
}

function parseDailyPage(html, pageUrl) {
  const $ = cheerio.load(html);

  const dateEl = $('.cpe-cover-sub').first();
  const dateText = dateEl.text().trim();
  const date = normalizeDate(dateText) || '';

  const $wrap = $('.cpe-wrap');
  if (!$wrap.length) return { date, articles: [] };

  $wrap.find('.cpe-mcq-reveal').remove();

  const articles = [];
  const children = $wrap.children().toArray();
  let currentTitle = '';
  let currentContent = [];
  let inArticle = false;
  let articleIndex = 0;

  for (const el of children) {
    const $el = $(el);

    if ($el.is('.cpe-art-divider')) {
      if (currentTitle) {
        articles.push({ title: currentTitle, contentHtml: currentContent.join('\n'), index: articleIndex });
      }
      articleIndex++;
      currentTitle = '';
      currentContent = [];
      inArticle = true;
      continue;
    }

    if (!inArticle) continue;

    if ($el.is('h2.cpe-art-title')) {
      currentTitle = $el.text().trim();
      continue;
    }

    const htmlStr = $.html(el);
    if (!htmlStr || !htmlStr.replace(/<[^>]+>/g, '').trim()) continue;

    currentContent.push(htmlStr);
  }

  if (currentTitle) {
    articles.push({ title: currentTitle, contentHtml: currentContent.join('\n'), index: articleIndex });
  }

  for (const a of articles) {
    a.cleanedHtml = cleanHtml(a.contentHtml, pageUrl);
    a.plainText   = htmlToText(a.cleanedHtml);
    a.wordCount   = wordCount(a.plainText);
    a.articleUrl  = `${pageUrl}#article-${a.index}`;
    delete a.contentHtml;
    delete a.index;
  }

  return { date, articles };
}
