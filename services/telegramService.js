import axios from 'axios';
import { chromium } from 'playwright';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

let urlCache = new Map();
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function parseTelegramUrl(url) {
  const patterns = [
    /https?:\/\/t\.me\/c\/(\d+)\/(\d+)/,
    /https?:\/\/t\.me\/([^\/]+)\/(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { channel: match[1], msgId: match[2] };
    }
  }
  return null;
}

function resolveChatId(channel) {
  if (/^-?\d+$/.test(channel)) return channel;
  if (/^\d+$/.test(channel) && !channel.startsWith('-100')) return `-100${channel}`;
  if (channel.startsWith('-100')) return channel;
  return channel.startsWith('@') ? channel : `@${channel}`;
}

async function getFileDownloadUrl(channel, msgId) {
  const cacheKey = `${channel}:${msgId}`;
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }

  try {
    return await getViaBotApi(channel, msgId, cacheKey);
  } catch (botErr) {
    console.warn(`Bot API failed for ${channel}/${msgId}, trying Playwright scrape:`, botErr.message);
    try {
      return await getViaPlaywright(channel, msgId, cacheKey);
    } catch (scrapeErr) {
      throw new Error(`Cannot fetch video: ${scrapeErr.message}`);
    }
  }
}

async function getViaBotApi(channel, msgId, cacheKey) {
  const chatId = resolveChatId(channel);

  const copyRes = await axios.post(`${API_BASE}/copyMessage`, {
    from_chat_id: chatId,
    message_id: parseInt(msgId),
    chat_id: CHANNEL_ID,
    protect_content: false,
  });

  const result = copyRes.data.result;
  const media = result.video || result.document || result.audio || result.animation;
  if (!media) {
    throw new Error('No media found in the message');
  }

  const copiedMsgId = result.message_id;

  const fileRes = await axios.get(`${API_BASE}/getFile`, {
    params: { file_id: media.file_id },
  });

  await axios.post(`${API_BASE}/deleteMessage`, {
    chat_id: CHANNEL_ID,
    message_id: copiedMsgId,
  }).catch(() => {});

  const filePath = fileRes.data.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

  urlCache.set(cacheKey, { url: downloadUrl, expires: Date.now() + 50 * 60 * 1000 });
  return downloadUrl;
}

async function getViaPlaywright(channel, msgId, cacheKey) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  // Intercept ALL telesco.pe requests (both requests & responses)
  const cdnUrls = new Set();
  page.on('request', (req) => {
    if (req.url().includes('telesco.pe')) {
      cdnUrls.add(req.url().split('?')[0]);
    }
  });
  page.on('response', (resp) => {
    const url = resp.url().split('?')[0];
    const ct = resp.headers()['content-type'] || '';
    if (url.includes('telesco.pe')) {
      cdnUrls.add(url);
    }
  });

  try {
    const webUrl = `https://t.me/${channel}/${msgId}`;
    await page.goto(webUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Try clicking any video/media area to trigger dynamic load
    try {
      const clickTargets = await page.$$('video, .tgme_widget_message_video_wrap, [class*="video"], [class*="media"], .tgme_widget_message_photo_wrap');
      for (const el of clickTargets.slice(0, 3)) {
        try { await el.click(); await page.waitForTimeout(2000); } catch {}
      }
    } catch {}

    // Also try keyboard "play" or scroll to trigger
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    let videoUrl = null;

    // 1) Check collected CDN URLs
    for (const url of cdnUrls) {
      try {
        const head = await axios.head(url, { timeout: 5000 });
        const ct = (head.headers['content-type'] || '').toLowerCase();
        if (ct.startsWith('video/') || ct.includes('octet-stream') || ct.includes('matroska')) {
          videoUrl = url;
          break;
        }
      } catch {}
    }

    // 2) Check DOM for video sources
    if (!videoUrl) {
      videoUrl = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) return v.currentSrc || v.src || null;
        const meta = document.querySelector('meta[property="og:video"]') ||
                     document.querySelector('meta[property="twitter:player:stream"]');
        if (meta) return meta.getAttribute('content');
        return null;
      });
    }

    // 3) Use og:image CDN URL as fallback (Telegram CDN serves original file)
    if (!videoUrl) {
      const ogImage = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:image"]');
        return m ? m.getAttribute('content') : null;
      });
      if (ogImage && ogImage.includes('telesco.pe')) {
        videoUrl = ogImage;
      }
    }

    // 4) Search entire page source for telesco.pe URLs
    if (!videoUrl) {
      const html = await page.content();
      const allMatches = html.matchAll(/https?:\/\/cdn\d?\.telesco\.pe\/file\/[^"'\s]+/g);
      for (const m of allMatches) {
        const cleanUrl = m[0].split('?')[0];
        try {
          const head = await axios.head(cleanUrl, { timeout: 5000 });
          const ct = (head.headers['content-type'] || '').toLowerCase();
          if (ct.startsWith('video/') || ct.includes('octet-stream') || ct.includes('matroska')) {
            videoUrl = cleanUrl;
            break;
          }
          if (!videoUrl) videoUrl = cleanUrl; // fallback
        } catch { if (!videoUrl) videoUrl = cleanUrl; }
      }
    }

    if (!videoUrl) {
      throw new Error('Could not extract video URL from Telegram page');
    }

    urlCache.set(cacheKey, { url: videoUrl, expires: Date.now() + 50 * 60 * 1000 });
    return videoUrl;
  } finally {
    await context.close();
  }
}

function parseTelegramUrlSafe(url) {
  try {
    return parseTelegramUrl(url);
  } catch {
    return null;
  }
}

export { getFileDownloadUrl, parseTelegramUrl, parseTelegramUrlSafe };
