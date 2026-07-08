import * as cheerio from 'cheerio';
import EditorialRepeatAnalysis from '../models/EditorialRepeatAnalysis.js';
import OpenAI from 'openai';

let nvClient = null;
const getNVClient = () => {
  if (!nvClient) {
    nvClient = new OpenAI({
      baseURL: process.env.NVIDIA_API_URL,
      apiKey: process.env.NVIDIA_API_KEY,
    });
  }
  return nvClient;
};

/* ---------- algorithmic core ---------- */

const STOPWORDS = new Set([
  'the','a','an','in','of','to','and','is','for','on','it','as','by','with','at','from',
  'this','that','are','was','were','been','be','has','have','had','do','does','did',
  'will','would','could','should','may','might','can','shall','not','no','nor',
  'but','or','if','because','so','than','too','very','just','about','into','over',
  'after','before','between','under','above','below','up','down','out','off',
  'all','each','every','both','few','more','most','some','any','such','only',
  'own','same','here','there','when','where','why','how','what','which','who',
  'whom','whose','being','having','doing','its','their','them','they','his','her',
  'our','your','my','me','we','us','he','she','it','i','you',
  '&','and','via','new','one','two','three',
]);

function extractHeadings(html) {
  if (!html) return [];
  try {
    const $ = cheerio.load(html);
    return $('h2, h3').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  } catch { return []; }
}

function tokenize(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
  )];
}

function extractKeywords(headings, title) {
  return tokenize([...headings, title].filter(Boolean).join(' '));
}

/* Jaccard similarity between two keyword sets */
function jaccard(a, b) {
  const setA = new Set(a), setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

/* Group articles using greedy clique merging via Jaccard */
function groupByJaccard(articles, threshold = 0.25) {
  const n = articles.length;
  const simMatrix = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      simMatrix[i][j] = simMatrix[j][i] = jaccard(articles[i].keywords, articles[j].keywords);

  const used = new Set();
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    used.add(i);
    for (let j = i + 1; j < n; j++) {
      if (used.has(j)) continue;
      if (cluster.reduce((s, ci) => s + simMatrix[ci][j], 0) / cluster.length >= threshold) {
        cluster.push(j);
        used.add(j);
      }
    }
    if (cluster.length >= 2) groups.push(cluster.map(idx => articles[idx]));
  }
  return groups;
}

/* Trend scores for a topic group */
function computeTrend(articles, allDateKeys) {
  const sortedKeys = [...new Set(allDateKeys)].sort();
  const perWindow = sortedKeys.map(dk => articles.filter(a => a.runDateKey === dk).length);
  const total = articles.length;
  const n = perWindow.length || 1;
  const sumX = perWindow.reduce((s, v, i) => s + i * v, 0);
  const sumY = perWindow.reduce((s, v) => s + v, 0);
  const slope = n > 1 ? (sumX - (sumY * (n - 1) / 2)) / (n * (n + 1) / 2) : 0;
  const firstIdx = Math.min(...articles.map(a => sortedKeys.indexOf(a.runDateKey)));
  const lastIdx = Math.max(...articles.map(a => sortedKeys.indexOf(a.runDateKey)));
  const span = Math.max(lastIdx - firstIdx + 1, 1);
  const consistency = total / span;
  const mean = sumY / n;
  const volatility = Math.sqrt(perWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return {
    slope: Math.round(slope * 100) / 100,
    consistency: Math.round(consistency * 100) / 100,
    volatility: Math.round(volatility * 100) / 100,
    heatScore: Math.round(total * (1 + consistency)),
  };
}

/* ---------- AI per-article categorization ---------- */

const UPSC_CATEGORIES = [
  'Agriculture & Rural', 'Banking & Finance', 'Constitutional Developments',
  'Culture & Heritage', 'Defense & Security', 'Disaster Management',
  'Economy & Finance', 'Education & Health', 'Elections & Political',
  'Energy & Resources', 'Environment & Climate', 'Federalism & States',
  'Governance', 'Industry & Trade', 'International Relations',
  'Jammu & Kashmir', 'Judiciary & Legal', 'Science & Tech',
  'Social Issues', 'Transportation', 'Urban Infrastructure', 'Water Resources',
];

function buildCategorizationPrompt(articleData) {
  const items = articleData.map((a, i) => {
    const headings = a.headings?.length ? `headings: ${a.headings.join(' | ')}` : '';
    return `[${a.batchIdx}] title: "${a.title}"${headings ? ` | ${headings}` : ''}`;
  }).join('\n');

  return `You are a UPSC editorial classifier. For each article below, read its h2/h3 headings and title, then assign:

1. category — choose ONE from: ${UPSC_CATEGORIES.join(', ')}
2. topicLabel — concise 2-5 word sub-topic name (e.g., "Smart Cities Mission")

Return EACH result on one line in this exact format (same order as input):
batchIdx | category | topicLabel

Example:
0 | Urban Infrastructure | Smart Cities Mission
1 | Disaster Management | NDRF Modernization
2 | Science & Tech | AI in Governance

Articles:
${items}`;
}

const BATCH_SIZE = 15;

async function callNVIDIA(model, messages, timeoutMs) {
  const url = process.env.NVIDIA_API_URL
    ? `${process.env.NVIDIA_API_URL.replace(/\/+$/, '')}/chat/completions`
    : 'https://integrate.api.nvidia.com/v1/chat/completions';
  const key = process.env.NVIDIA_API_KEY;

  const { default: axios } = await import('axios');
  const res = await axios.post(url, {
    model,
    messages,
    temperature: 0.05,
    max_tokens: 2000,
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });
  return res.data;
}

async function categorizeArticlesWithAI(articleData) {
  if (!articleData.length) return [];
  const primaryModel = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash';
  const fallbackModel = 'meta/llama-4-maverick-17b-128e-instruct';
  const TIMEOUT = 300_000;

  /* Chunk into batches */
  const batches = [];
  for (let i = 0; i < articleData.length; i += BATCH_SIZE) {
    const slice = articleData.slice(i, i + BATCH_SIZE);
    slice.forEach((a, idx) => a.batchIdx = i + idx);
    batches.push(slice);
  }

  console.log(`[RepeatAnalysis] AI categorizing ${articleData.length} articles in ${batches.length} sequential batches of ${BATCH_SIZE}...`);

  /* Sequential batches — avoids rate-limit surges */
  const results = {};
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const prompt = buildCategorizationPrompt(batch);

    async function tryModel(model, label) {
      console.log(`[RepeatAnalysis] Batch ${b + 1}/${batches.length} → ${label}`);
      const messages = [
        { role: 'system', content: 'You output plain text only. Each line: idx | category | topicLabel' },
        { role: 'user', content: prompt },
      ];
      return callNVIDIA(model, messages, TIMEOUT);
    }

    let data;
    try {
      data = await tryModel(primaryModel, primaryModel);
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || String(err);
      const status = err?.response?.status;

      if (status === 503 || msg.includes('503')) {
        console.warn(`[RepeatAnalysis]  503, fallback → ${fallbackModel}`);
        try { data = await tryModel(fallbackModel, fallbackModel); } catch (e2) {
          console.error(`[RepeatAnalysis]  Fallback failed: ${e2.message}`);
          continue;
        }
      } else if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
        console.error(`[RepeatAnalysis]  Timed out after ${TIMEOUT / 1000}s — skipping batch`);
        continue;
      } else {
        console.error(`[RepeatAnalysis]  Failed: ${msg}`);
        continue;
      }
    }

    if (!data) continue;

    const text = data?.choices?.[0]?.message?.content || '';
    const lines = text.split('\n').filter(l => l.includes('|'));
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim());
      const idx = parseInt(parts[0]);
      if (!isNaN(idx) && parts[1] && parts[2]) {
        results[idx] = { index: idx, category: parts[1], topicLabel: parts[2] };
      }
    }
    console.log(`[RepeatAnalysis]  Batch ${b + 1} done: ${Object.keys(results).length} total categorized so far`);
  }

  const out = Object.values(results).sort((a, b) => a.index - b.index);
  console.log(`[RepeatAnalysis] AI categorized ${out.length}/${articleData.length} articles`);
  return out.length ? out : null;
}

/* ---------- hybrid window analysis ---------- */

async function runWindowAnalysis(windowItems, perArticleCategory) {
  if (!windowItems.length) { console.log('[RepeatAnalysis] 0 items — skipping'); return []; }

  console.log(`[RepeatAnalysis] Extracting keywords from ${windowItems.length} articles...`);
  const articleData = windowItems.map(it => ({
    _id: it._id?.toString(),
    title: it.title,
    description: it.description || '',
    link: it.link,
    sourceKey: it.sourceKey || '',
    runDateKey: it.runDateKey,
    keywords: extractKeywords(extractHeadings(it.keyPointersContent), it.title),
    category: perArticleCategory?.[it._id?.toString()]?.category || null,
    aiLabel: perArticleCategory?.[it._id?.toString()]?.topicLabel || null,
  }));

  const withKeywords = articleData.filter(a => a.keywords.length >= 2);
  if (withKeywords.length < 2) return [];

  const allDateKeys = windowItems.map(i => i.runDateKey).filter(Boolean);

  /* Group by AI category first, then sub-group by Jaccard within each category */
  const groupedByCategory = {};
  for (const ad of withKeywords) {
    const cat = ad.category || 'Uncategorized';
    if (!groupedByCategory[cat]) groupedByCategory[cat] = [];
    groupedByCategory[cat].push(ad);
  }

  console.log(`[RepeatAnalysis] Categories found: ${Object.keys(groupedByCategory).join(', ')}`);

  const finalGroups = [];
  for (const [category, catArticles] of Object.entries(groupedByCategory)) {
    console.log(`[RepeatAnalysis]  Category "${category}": ${catArticles.length} articles`);

    if (catArticles.length < 2) {
      /* Single article in category — still include it with the aiLabel */
      finalGroups.push({
        articles: catArticles,
        category,
        label: catArticles[0].aiLabel || buildTopicLabel(catArticles[0].keywords),
        rationale: '',
      });
      continue;
    }

    /* Within each category, Jaccard sub-grouping */
    const subGroups = groupByJaccard(catArticles, 0.2);
    console.log(`[RepeatAnalysis]   → ${subGroups.length} sub-groups via Jaccard`);

    if (!subGroups.length) {
      /* All articles in category are too different — keep as one group */
      const allKWs = [...new Set(catArticles.flatMap(a => a.keywords))];
      finalGroups.push({
        articles: catArticles,
        category,
        label: catArticles[0].aiLabel || buildTopicLabel(allKWs),
        rationale: '',
      });
      continue;
    }

    for (const sg of subGroups) {
      const allKWs = [...new Set(sg.flatMap(a => a.keywords))];
      const label = sg[0]?.aiLabel || buildTopicLabel(allKWs);
      finalGroups.push({ articles: sg, category, label, rationale: '' });
    }
  }

  if (!finalGroups.length) return [];

  console.log(`[RepeatAnalysis] Computing trends for ${finalGroups.length} groups...`);
  return finalGroups.map(g => ({
    topicLabel: g.label,
    category: g.category,
    repeatCount: g.articles.length,
    trend: g.articles.length >= 2 ? computeTrend(g.articles, allDateKeys) : null,
    rationale: g.rationale || `Articles in this ${g.category} category appeared ${g.articles.length} times across ${new Set(g.articles.map(a => a.runDateKey)).size} different dates.`,
    comprehensiveLinks: g.articles.slice(0, 10).map(a => ({
      _id: a._id,
      title: a.title,
      description: a.description,
      link: a.link,
      sourceKey: a.sourceKey,
    })),
  }));
}

function buildTopicLabel(keywords) {
  if (!keywords?.length) return 'UPSC Theme';
  return keywords.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(', ');
}

/* ---------- thresholds / window helpers ---------- */

const windowTypeConfig = (windowType) => {
  switch (windowType) {
    case '7d':  return { repeatThresholdExclusiveMin: 2 };
    case '1m':  return { repeatThresholdExclusiveMin: 5 };
    case '6m':  return { repeatThresholdExclusiveMin: 20 };
    case 'gt6m': return { repeatThresholdExclusiveMin: 20, repeatThresholdInclusiveMax: 50 };
    default:    return { repeatThresholdExclusiveMin: Infinity };
  }
};

const getDateKeyList = (anchorDateKey, windowType) => {
  const [y, m, d] = anchorDateKey.split('-').map(Number);
  const anchor = new Date(y, m - 1, d);
  const addDays = (dt, days) => { const x = new Date(dt); x.setDate(x.getDate() + days); return x; };
  switch (windowType) {
    case '7d':  return { start: addDays(anchor, -6), end: anchor };
    case '1m':  { const s = new Date(anchor); s.setMonth(s.getMonth() - 1); return { start: s, end: anchor }; }
    case '6m':  { const s = new Date(anchor); s.setMonth(s.getMonth() - 6); return { start: s, end: anchor }; }
    default:    { const s = new Date(anchor); s.setMonth(s.getMonth() - 12); return { start: s, end: anchor }; }
  }
};

const toDateKey = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

const filterItemsByWindow = (items, generatedForDateKey, windowType) => {
  const { start, end } = getDateKeyList(generatedForDateKey, windowType);
  const startKey = toDateKey(start), endKey = toDateKey(end);
  return items.filter(it => it.runDateKey && it.runDateKey >= startKey && it.runDateKey <= endKey);
};

/* ---------- service export ---------- */

export const editorialRepeatAnalyzerService = {
  async generateAllWindows({ userId, generatedForDateKey, items }) {
    const windowTypes = ['7d', '1m', '6m', 'gt6m'];
    console.log(`[RepeatAnalysis] Starting all windows (${items.length} total items, date ${generatedForDateKey})`);

    /* 1. Extract keywords and headings for all items (once) */
    const allData = items.map(it => ({
      _id: it._id?.toString(),
      title: it.title,
      keywords: extractKeywords(extractHeadings(it.keyPointersContent), it.title),
      headings: extractHeadings(it.keyPointersContent),
    }));
    const withKeywords = allData.filter(a => a.keywords.length >= 2);

    /* 2. AI per-article categorization (once) — feed it h2/h3 headings */
    let perArticleCategory = null;
    if (withKeywords.length >= 2) {
      console.log(`[RepeatAnalysis] Running AI categorization on ${withKeywords.length} articles...`);
      const aiResult = await categorizeArticlesWithAI(withKeywords);
      if (aiResult) {
        perArticleCategory = {};
        for (const entry of aiResult) {
          const art = withKeywords[entry.index];
          if (art) perArticleCategory[art._id] = { category: entry.category, topicLabel: entry.topicLabel };
        }
        console.log(`[RepeatAnalysis] AI categorized ${Object.keys(perArticleCategory).length} articles`);
      } else {
        console.log('[RepeatAnalysis] AI categorization failed — falling back to algorithmic-only');
      }
    }

    /* 3. Run each window with pre-computed AI data */
    const results = {};
    for (const wt of windowTypes) {
      const start = Date.now();
      const windowItems = filterItemsByWindow(items, generatedForDateKey, wt);
      console.log(`[RepeatAnalysis] ${wt}: ${windowItems.length} articles in window`);
      const topics = await runWindowAnalysis(windowItems, perArticleCategory);
      const cfg = windowTypeConfig(wt);
      const threshold = cfg.repeatThresholdExclusiveMin || 0;
      const filtered = topics.filter(t => {
        if (wt === 'gt6m') return t.repeatCount > 20 && t.repeatCount <= 50;
        return t.repeatCount > threshold;
      });
      console.log(`[RepeatAnalysis] ${wt}: ${filtered.length}/${topics.length} topics (${(Date.now() - start) / 1000}s)`);

      results[wt] = await EditorialRepeatAnalysis.findOneAndUpdate(
        { userId, generatedForDateKey, windowType: wt },
        {
          $set: {
            rulesApplied: {
              windowType: wt, thresholds: cfg,
              method: 'hybrid-ai-categorize-then-jaccard',
              totalArticles: windowItems.length,
              algorithmVersion: '3.0',
              aiCategorizationApplied: !!perArticleCategory,
            },
            results: filtered,
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
    }

    return results;
  },

  /* Kept for backward compatibility — delegates to generateAllWindows with single-window items */
  async generateWindowAnalysis({ userId, generatedForDateKey, items, windowType }) {
    const result = await this.generateAllWindows({ userId, generatedForDateKey, items });
    return result[windowType] || { results: [] };
  },
};
