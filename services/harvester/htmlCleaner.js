import * as cheerio from 'cheerio';

const ALLOWED_TAGS = new Set([
  'h1','h2','h3','h4','h5','h6',
  'p','strong','em','b','i','u','s',
  'ul','ol','li',
  'table','thead','tbody','tfoot','tr','th','td',
  'blockquote','pre','code',
  'hr','br','span',
  'div',
]);

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', 'header', 'footer',
  '.navbar', '.nav', '.header', '.footer',
  '.ad', '.ads', '.advertisement', '.adsbygoogle',
  '.popup', '.modal', '.overlay',
  '.share', '.share-buttons', '.social-share', '.social-icons',
  '.newsletter', '.subscribe',
  '.related', '.related-posts', '.recommended',
  '.author-widget', '.author-bio', '.author-box',
  '.breadcrumb', '.breadcrumbs',
  '.cookie', '.cookie-banner', '.cookie-notice',
  '.comment', '.comments', '.comment-section',
  '.sidebar', '.widget', '.widgets',
  '[class*="sticky"]', '[class*="float"]',
  '[class*="tracking"]', '[class*="analytics"]',
  '[id*="sidebar"]', '[id*="header"]', '[id*="footer"]',
  '[id*="nav"]', '[id*="ad"]', '[id*="popup"]',
  'figure.wp-block-embed',
  '.ghost-css-exclusion-classes',
  '.audio-player-title',
  '.gh-post-page__more',
  '.gh-post-page__more-title',
  '.publive-slot-span',
  '.publive-dynamic-container',
  '.read-more-article-box',
];

export function cleanHtml(rawHtml, baseUrl = '') {
  if (!rawHtml) return '';
  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  NOISE_SELECTORS.forEach((sel) => {
    try { $(sel).remove(); } catch {}
  });

  $('*').each(function () {
    const el = $(this);
    const cls = (el.attr('class') || '').toLowerCase();
    const id  = (el.attr('id') || '').toLowerCase();
    const noiseWords = [
      'menu','nav','header','footer','sidebar','widget',
      'advert','sponsor','promo','banner','popup','modal',
      'social','share','comment','related','author','bio',
      'breadcrumb','cookie','subscribe','newsletter','tracking',
      'sticky','floating','overlay','publive',
    ];
    if (noiseWords.some((w) => cls.includes(w) || id.includes(w))) {
      el.remove();
    }
  });

  $('*').each(function () {
    const el    = $(this);
    const tag   = this.tagName?.toLowerCase();
    if (!tag) return;

    const attribs = Object.keys(el.attr() || {});
    attribs.forEach((attr) => {
      const keep =
        (tag === 'a'   && (attr === 'href' || attr === 'title')) ||
        (tag === 'img' && (attr === 'src'  || attr === 'alt' || attr === 'width' || attr === 'height')) ||
        (tag === 'td'  && (attr === 'colspan' || attr === 'rowspan')) ||
        (tag === 'th'  && (attr === 'colspan' || attr === 'rowspan'));
      if (!keep) el.removeAttr(attr);
    });
  });

  if (baseUrl) {
    $('img').each(function () {
      const src = $(this).attr('src') || '';
      if (src && !src.startsWith('http') && !src.startsWith('data:')) {
        try {
          $(this).attr('src', new URL(src, baseUrl).href);
        } catch {}
      }
    });
  }

  $('img, figure, figcaption, button, iframe, video, audio, canvas, svg').remove();

  $('div, span, a').each(function () {
    $(this).replaceWith($(this).html() || '');
  });

  $('p, li, h1, h2, h3, h4, h5, h6, td, th').each(function () {
    if ($(this).text().trim() === '' && $(this).find('img').length === 0) {
      $(this).remove();
    }
  });

  $('br + br').each(function () { $(this).remove(); });

  let html = $.html('body') || $.html();

  html = html
    .replace(/^<body[^>]*>/i, '')
    .replace(/<\/body>$/i, '')
    .trim();

  html = html
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '>\n<')
    .trim();

  return html;
}

export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(html, { decodeEntities: true });

  $('h1,h2,h3,h4,h5,h6,p,li,blockquote,tr,br,hr').each(function () {
    $(this).append('\n');
  });

  let text = $('body').text() || $.text();
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .trim();

  return text;
}

export function wordCount(text) {
  return (text.match(/\b\w+\b/g) || []).length;
}

export function readingTime(wc) {
  const mins = Math.ceil(wc / 200);
  return `${mins} min read`;
}
