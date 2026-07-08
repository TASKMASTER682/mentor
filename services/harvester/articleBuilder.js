import { v4 as uuidv4 } from 'uuid';
import * as cheerio from 'cheerio';
import { normalizeDate } from './dateParser.js';

export function buildArticle(raw, sourceId) {
  const publishedAt = normalizeDate(raw.published_at || raw.pubDate || '') || '';
  const scrapedAt   = new Date().toISOString();

  const $ = cheerio.load(raw.html || '');
  const images = [];
  $('img').each(function () {
    const src = $(this).attr('src');
    if (src && !images.includes(src)) images.push(src);
  });

  return {
    id:             uuidv4(),
    source:         sourceId,
    title:          (raw.title || '').trim(),
    subtitle:       (raw.subtitle || '').trim(),
    author:         (raw.author || raw.byline || '').trim(),
    category:       (raw.category || 'Editorial').trim(),
    tags:           Array.isArray(raw.tags) ? raw.tags : [],
    published_at:   publishedAt,
    updated_at:     normalizeDate(raw.updated_at || '') || publishedAt,
    scraped_at:     scrapedAt,
    url:            (raw.url || '').trim(),
    canonical_url:  (raw.canonical_url || raw.url || '').trim(),
    description:    (raw.description || raw.excerpt || '').slice(0, 300).trim(),
    language:       (raw.language || raw.lang || 'en').trim(),
    reading_time:   raw.reading_time || '',
    featured_image: raw.featured_image || images[0] || '',
    images,
    html:           (raw.html || '').trim(),
    plain_text:     (raw.plain_text || '').trim(),
    word_count:     typeof raw.word_count === 'number' ? raw.word_count : (typeof raw.wordCount === 'number' ? raw.wordCount : 0),
  };
}
