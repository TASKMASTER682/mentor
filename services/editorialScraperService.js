import axios from 'axios';
import xml2js from 'xml2js';

import EditorialScrapeRun from '../models/EditorialScrapeRun.js';
import EditorialItem from '../models/EditorialItem.js';

const parser = new xml2js.Parser({
  explicitArray: false,
  mergeAttrs: true,
  trim: true
});

const clampStr = (s) => (typeof s === 'string' ? s.trim() : '');
const normalizeSpaces = (s) => clampStr(s).replace(/\s+/g, ' ');

const toDateKey = (d) => {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  // Keep as YYYY-MM-DD in server timezone (simpler + reliable)
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const safePick = (obj, path, fallback = '') => {
  try {
    return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? fallback;
  } catch {
    return fallback;
  }
};

const rssItemScoreHeuristics = ({ title, description }) => {
  const t = normalizeSpaces(title).toLowerCase();
  const d = normalizeSpaces(description).toLowerCase();
  const text = `${t}\n${d}`;

  // Lightweight UPSC editorial relevance heuristics (NOT full scraping)
  const keywords = [
    // polity / governance
    'supreme court', 'high court', 'judiciary', 'tribunal', 'constitution', 'fundamental rights',
    'article', 'fundamental duties', 'commission', 'cabinet', 'parliament', 'federal', 'federalism',
    // economy
    'inflation', 'rbi', 'monetary policy', 'fiscal', 'budget', 'gst', 'poverty', 'inequality', 'gdp', 'gva',
    // social / polity
    'human rights', 'gender', 'women', 'child', 'education', 'health', 'environment', 'biodiversity',
    // national security
    'security', 'cyber', 'terror', 'border', 'internal security'
  ];

  let score = 0;
  for (const k of keywords) {
    if (text.includes(k)) score += 8;
  }

  // editorial/opinion style hints
  const editorialHints = ['editorial', 'opinion', 'analysis', 'agenda', 'letter', 'explainer', 'interview', 'comment'];
  for (const h of editorialHints) {
    if (t.includes(h) || d.includes(h)) score += 6;
  }

  // Penalize pure news / announcements
  const newsHints = ['breaking', 'news', 'updates', 'press release', 'tender', 'event', 'vacancy'];
  for (const h of newsHints) {
    if (t.includes(h) || d.includes(h)) score -= 5;
  }

  // Prefer longer, info-rich descriptions
  score += Math.min(10, Math.floor(normalizeSpaces(description).length / 120));

  return Math.max(0, score);
};

// “UPSC oriented based on mains/prelims themes” filter.
// Since we are not scraping full article, this is intentionally conservative.
const isUPSCEditorialLikely = ({ title, description }) => {
  const t = normalizeSpaces(title).toLowerCase();
  const d = normalizeSpaces(description).toLowerCase();
  const text = `${t} ${d}`;

  const allowHints = [
    'editorial', 'opinion', 'analysis', 'explained', 'agenda', 'viewpoint',
    'supreme court', 'high court', 'judiciary', 'tribunal', 'constitution',
    'rbi', 'rbi issues', 'monetary', 'inflation', 'gdp', 'gva', 'budget',
    'niti', 'ayog', 'neeti', 'governance', 'welfare',
    'environment', 'biodiversity', 'climate', 'river', 'pollution'
  ];

  // If none of the editorial hints exist, drop aggressively.
  // (User can adjust sources/filters later.)
  for (const h of allowHints) {
    if (text.includes(h)) return true;
  }
  return false;
};

const DEFAULT_SOURCES = [
  // These are examples; user can add/adjust RSS URLs later.
  // The engine is built to accept configured RSS feeds.
  {
    sourceKey: 'thehindu',
    group: 'hindu',
    rssUrl: process.env.EDITORIAL_RSS_THEHINDU || ''
  },
  {
    sourceKey: 'greaterkashmir',
    group: 'kashmir',
    rssUrl: process.env.EDITORIAL_RSS_GREATER_KASHMIR || ''
  },
  {
    sourceKey: 'pib',
    group: 'govt',
    rssUrl: process.env.EDITORIAL_RSS_PIB || ''
  },
  {
    sourceKey: 'nitiayog',
    group: 'govt',
    rssUrl: process.env.EDITORIAL_RSS_NITI || ''
  },
  {
    sourceKey: 'rbi',
    group: 'govt',
    rssUrl: process.env.EDITORIAL_RSS_RBI || ''
  }
  // Add more govt RSS by environment variables later.
];

const pickItemsFromRss = async ({ rssUrl, sourceKey }) => {
  if (!rssUrl) return [];

  const res = await axios.get(rssUrl, { timeout: 30000, headers: { 'User-Agent': 'upsc-editorial-engine/1.0' } });
  const xml = res.data;

  const parsed = await parser.parseStringPromise(xml);

  // Common RSS shapes:
  // rss.channel.item[]
  // or atom.feed.entry[]
  const items = safePick(parsed, 'rss.channel.item', null)
    || safePick(parsed, 'feed.entry', null);

  if (!items) return [];

  const arr = Array.isArray(items) ? items : [items];

  return arr
    .map((it) => {
      const title = clampStr(safePick(it, 'title', ''));
      const description =
        clampStr(safePick(it, 'description', '')) ||
        clampStr(safePick(it, 'summary', '')) ||
        '';

      const link =
        clampStr(safePick(it, 'link.href', '')) ||
        clampStr(safePick(it, 'link', ''));

      const pubDate = clampStr(safePick(it, 'pubDate', '')) || clampStr(safePick(it, 'published', ''));

      return {
        sourceKey,
        title: normalizeSpaces(title),
        description: normalizeSpaces(description),
        link: clampStr(link),
        publishedAt: pubDate
      };
    })
    .filter((x) => x.title && x.link);
};

export const editorialScraperService = {
  async scrapeLatestDayForUser({
    userId,
    runDateKey,
    sources = DEFAULT_SOURCES,
    itemLimitTotal = 6
  }) {
    const sourcesFiltered = sources.filter(s => s.rssUrl && s.rssUrl.trim().length > 0);

    if (!runDateKey) throw new Error('runDateKey is required');

    const run = await EditorialScrapeRun.create({
      userId,
      runDateKey,
      sourcesKey: sourcesFiltered.map(s => s.sourceKey).sort().join('+'),
      itemLimitTotal
    });

    // “Latest day only”: use RSS pubDate dayKey === runDateKey
    const selectedItems = [];

    for (const s of sourcesFiltered) {
      const rawItems = await pickItemsFromRss({ rssUrl: s.rssUrl, sourceKey: s.sourceKey });

      const dayMatches = rawItems
        .map((it) => ({ ...it, pubDayKey: toDateKey(it.publishedAt) }))
        .filter((it) => it.pubDayKey === runDateKey);

      // UPSC relevance filter
      const upscLike = dayMatches.filter(isUPSCEditorialLikely);

      // Score and keep some per source
      const scored = upscLike
        .map((it) => ({ ...it, score: rssItemScoreHeuristics(it) }))
        .sort((a, b) => b.score - a.score);

      // Push top candidates; final cap is total 6
      selectedItems.push(...scored.slice(0, 8));
    }

    // The rule says: “daily me zada se zada 6 editorials honge The Hindu ke and govt sources ... combined”
    // So we keep Hindu + govt groups only when those groups are present.
    const hinduAndGovt = selectedItems.filter(it => {
      const src = sourcesFiltered.find(s => s.sourceKey === it.sourceKey);
      if (!src) return false;
      return src.group === 'hindu' || src.group === 'govt';
    });

    const finalSorted = hinduAndGovt.length > 0 ? hinduAndGovt : selectedItems;

    // De-dupe by fingerprint-like key (title+link)
    const seen = new Set();
    const unique = [];
    for (const it of finalSorted) {
      const fp = `${it.title}|${it.link}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      unique.push(it);
    }

    const toSave = unique.slice(0, itemLimitTotal);

    // Save
    let savedCount = 0;
    for (const it of toSave) {
      const exists = await EditorialItem.findOne({
        userId,
        runDateKey,
        sourceKey: it.sourceKey,
        link: it.link
      }).lean();

      if (exists) continue;

      await EditorialItem.create({
        userId,
        runDateKey,
        sourcesKey: run.sourcesKey,
        sourceKey: it.sourceKey,
        title: it.title,
        description: it.description,
        link: it.link,
        publishedAt: it.publishedAt ? new Date(it.publishedAt) : null,
        fingerprint: `${it.title}|${it.link}`.slice(0, 250)
      });
      savedCount += 1;
    }

    run.fetchedCount = selectedItems.length;
    run.savedCount = savedCount;
    await run.save();

    return {
      runDateKey,
      runId: run._id,
      savedCount,
      fetchedCount: run.fetchedCount
    };
  }
};
