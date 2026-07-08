import { chromium } from 'playwright';
import randomUserAgent from 'random-useragent';
import config from './config.js';
import logger from './logger.js';

let _browser = null;

export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  logger.info('[Browser] Launching Chromium...');
  const launchOpts = { headless: config.browser.headless, args: config.browser.args };
  if (config.browser.executablePath) launchOpts.executablePath = config.browser.executablePath;
  _browser = await chromium.launch(launchOpts);
  logger.info('[Browser] Chromium launched.');
  return _browser;
}

async function newPage(browser) {
  const ctx  = await browser.newContext({
    userAgent:         randomUserAgent.getRandom(),
    viewport:          { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    bypassCSP:         true,
  });

  const page = await ctx.newPage();

  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  page.setDefaultTimeout(config.timeout.navigation);
  page.setDefaultNavigationTimeout(config.timeout.navigation);
  return page;
}

export async function fetchPage(browser, url, waitForSelector = null, opts = {}) {
  const page = await newPage(browser);
  try {
    const waitUntil = opts.waitForNetworkIdle ? 'networkidle' : 'domcontentloaded';
    await page.goto(url, { waitUntil, timeout: config.timeout.navigation });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: config.timeout.selector }).catch(() => {});
    }

    const html = await page.content();
    return html;
  } finally {
    await page.context().close();
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
