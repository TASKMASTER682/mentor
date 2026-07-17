import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import PrelimsItem from '../models/PrelimsItem.js';

const BASE_URL = 'https://vajiramandravi.com/current-affairs/upsc-prelims-current-affairs/';

async function getDateTarget(mode) {
  const now = new Date();
  const target = new Date(now);
  if (mode === 'yesterday') target.setDate(target.getDate() - 1);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const day = target.getDate();
  const month = months[target.getMonth()];
  const year = target.getFullYear();
  return `${month} ${day}, ${year}`;
}

async function scrapePrelims(mode) {
  const userId = null; // will be set by caller
  const dateLabel = await getDateTarget(mode);
  const runDateKey = new Date().toISOString().slice(0, 10);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // Block images/media/fonts for speed
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    console.log(`[Prelims] Navigating to ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.prelims-pointers-column', { timeout: 15000 }).catch(() => {});

    // Find the date link matching our target
    const linkClicked = await page.evaluate((label) => {
      const links = document.querySelectorAll('div.lcontainer div.lcolumn.prelims-pointers-column div.items-grid div.item a');
      for (const a of links) {
        const span = a.querySelector('span');
        if (span && span.textContent.trim().includes(label)) {
          a.click();
          return true;
        }
      }
      return false;
    }, dateLabel);

    if (!linkClicked) {
      throw new Error(`Date "${dateLabel}" not found on prelims page`);
    }

    // Wait for navigation after click
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const articles = [];
    const seenUrls = new Set();

    // Each h2 represents a new article
    $('article').each((i, articleEl) => {
      const $art = $(articleEl);
      const h2 = $art.find('h2').first();
      if (!h2.length) return;

      const title = h2.text().trim();
      if (!title) return;

      // Strip inline styles from all elements in this article
      $art.find('[style]').removeAttr('style');
      $art.find('[class]').removeAttr('class');

      // Get the article content (all content within the article tag)
      let contentHtml = '';
      $art.find('*').each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (['h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'table', 'div'].includes(tag)) {
          const outer = $.html(el);
          if (outer) contentHtml += outer + '\n';
        }
      });

      // Try to find a link
      const link = $art.find('a').first().attr('href') || '';

      if (!seenUrls.has(link || title)) {
        seenUrls.add(link || title);
        articles.push({
          title,
          description: $art.find('p').first().text().trim().slice(0, 300),
          link,
          contentHtml,
        });
      }
    });

    console.log(`[Prelims] Scraped ${articles.length} articles for ${dateLabel}`);
    return { articles, dateLabel, runDateKey };
  } finally {
    await browser.close();
    console.log('[Prelims] Browser closed');
  }
}

export async function scrapeAndSavePrelims(mode, userId) {
  const { articles, dateLabel, runDateKey } = await scrapePrelims(mode);

  // Delete existing items for this user and date
  await PrelimsItem.deleteMany({ userId, runDateKey });

  // Save each article
  let savedCount = 0;
  for (const art of articles) {
    await PrelimsItem.create({
      userId,
      runDateKey,
      title: art.title,
      description: art.description,
      link: art.link,
      sourceKey: 'vajiram-prelims',
      contentHtml: art.contentHtml,
    });
    savedCount++;
  }

  return { success: true, savedCount, dateLabel, runDateKey };
}
