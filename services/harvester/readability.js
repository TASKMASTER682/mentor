import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { cleanHtml, htmlToText, wordCount, readingTime } from './htmlCleaner.js';

function stripNoise(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

export function extractReadable(rawHtml, url) {
  try {
    const cleaned = stripNoise(rawHtml);
    const dom     = new JSDOM(cleaned, { url });
    const reader  = new Readability(dom.window.document, {
      keepClasses: false,
      disableJSONLD: false,
    });
    const article = reader.parse();

    if (!article) return null;

    const cleanedHtml = cleanHtml(article.content || '', url);
    const plainText   = htmlToText(cleanedHtml);
    const wc          = wordCount(plainText);

    return {
      title:       article.title        || '',
      byline:      article.byline       || '',
      html:        cleanedHtml,
      plainText,
      wordCount:   wc,
      readingTime: readingTime(wc),
      excerpt:     article.excerpt      || '',
      lang:        article.lang         || 'en',
      siteName:    article.siteName     || '',
    };
  } catch (err) {
    return null;
  }
}

export function extractBySelector(rawHtml, selectors, url) {
  try {
    const cleaned = stripNoise(rawHtml);
    const dom  = new JSDOM(cleaned, { url });

    const list = typeof selectors === 'string' ? selectors.split(',').map(s => s.trim()) : [selectors];
    for (const sel of list) {
      const el = dom.window.document.querySelector(sel);
      if (!el) continue;

      const cleanedHtml = cleanHtml(el.innerHTML, url);
      const plainText   = htmlToText(cleanedHtml);
      const wc          = wordCount(plainText);
      if (wc < 50) continue;

      return {
        title:       dom.window.document.title || '',
        byline:      '',
        html:        cleanedHtml,
        plainText,
        wordCount:   wc,
        readingTime: readingTime(wc),
        excerpt:     (plainText || '').slice(0, 200),
        lang:        'en',
        siteName:    '',
      };
    }

    for (const sel of list) {
      const el = dom.window.document.querySelector(sel);
      if (el) {
        const cleanedHtml = cleanHtml(el.innerHTML, url);
        const plainText   = htmlToText(cleanedHtml);
        const wc          = wordCount(plainText);
        return {
          title:       dom.window.document.title || '',
          byline:      '',
          html:        cleanedHtml,
          plainText,
          wordCount:   wc,
          readingTime: readingTime(wc),
          excerpt:     (plainText || '').slice(0, 200),
          lang:        'en',
          siteName:    '',
        };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}
