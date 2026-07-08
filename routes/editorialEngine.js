import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { editorialScraperService } from '../services/editorialScraperService.js';
import EditorialItem from '../models/EditorialItem.js';
import EditorialRepeatAnalysis from '../models/EditorialRepeatAnalysis.js';
import { editorialRepeatAnalyzerService } from '../services/editorialRepeatAnalyzerService.js';
import * as cheerio from 'cheerio';

const router = express.Router();

// Public endpoint — no auth. Returns latest editorial per source (max 4).
router.get('/public/latest', async (req, res) => {
  try {
    const items = await EditorialItem.aggregate([
      { $sort: { runDateKey: -1, createdAt: -1 } },
      { $group: { _id: '$sourceKey', doc: { $first: '$$ROOT' } } },
      { $limit: 4 },
      { $replaceRoot: { newRoot: '$doc' } },
      { $project: { title: 1, description: 1, sourceKey: 1, runDateKey: 1, publishedAt: 1, link: 1 } },
    ]);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.use(authenticate);

const toRunDateKey = (d) => {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

// POST /api/editorial-engine/run-today (RSS-based)
router.post('/run-today', async (req, res) => {
  try {
    const userId = req.user._id;

    const now = new Date();
    const runDateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD (pubDate dayKey will be compared to this)

    // Scrape + save up to 6 items (The Hindu + govt combined)
    const scrapeResult = await editorialScraperService.scrapeLatestDayForUser({
      userId,
      runDateKey,
      itemLimitTotal: 6
    });

    // Gather last 6 months anchor items for analysis windows (we will analyze from DB)
    const allItems = await EditorialItem.find({
      userId,
      runDateKey: { $gte: new Date(new Date(now).setMonth(new Date(now).getMonth() - 6)).toISOString().slice(0, 10) },
    }).lean();

    const analysis = await editorialRepeatAnalyzerService.generateAllWindows({
      userId,
      generatedForDateKey: runDateKey,
      items: allItems
    });

    res.json({
      success: true,
      scrape: scrapeResult,
      analysis
    });
  } catch (err) {
    console.error('upload-day error:', err);
    res.status(500).json({ 
      error: err?.message || String(err),
      stack: err?.stack || null
    });
  }
});

// POST /api/editorial-engine/upload-day (Admin JSON-based)
router.post('/upload-day', async (req, res) => {
  try {
    const userId = req.user._id;

    const payload = req.body || {};
    const runDateKey = toRunDateKey(payload.last_updated || payload.generation_date);

    const articles = Array.isArray(payload.articles) ? payload.articles : [];
    if (articles.length === 0) {
      return res.status(400).json({ error: 'Invalid payload: articles array is required' });
    }

    // Clear all items for this date before re-uploading
    await EditorialItem.deleteMany({ userId, runDateKey });

    // Save items (NO scraping; just map provided objects)
    let savedCount = 0;

    // Keep a reasonable cap to prevent huge uploads; you can raise later.
    const itemLimitTotal = typeof payload.total_articles === 'number'
      ? Math.max(1, payload.total_articles)
      : articles.length;

    const toSave = articles.slice(0, itemLimitTotal);

    for (const a of toSave) {
      const title = (a?.title || '').toString().trim();
      const description = (a?.description || '').toString().trim();
      const link = (a?.link || a?.url || '').toString().trim();
      const source = (a?.source || '').toString().trim();
      // Try multiple common field names for the full HTML content
      const keyPointersContent = (a?.html || a?.content || a?.body || a?.htmlContent || a?.fullContent || '').toString().trim();

      if (!title || !link) continue;

      // sourceKey: use provided source name normalized, fallback to 'admin_json'
      const sourceKey = source
        ? source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        : 'admin_json';

      const publishedAtKey = toRunDateKey(a?.published_at || runDateKey);
      const fingerprint = `${title}|${link}`.slice(0, 250);

      await EditorialItem.create({
        userId,
        runDateKey,
        sourcesKey: 'admin_json',
        sourceKey,
        title,
        description,
        link,
        keyPointersContent,
        publishedAt: publishedAtKey ? new Date(a?.published_at || new Date().toISOString()) : null,
        fingerprint
      });

      savedCount += 1;
    }

    // Analyze windows using DB items for last 6 months
    const now = new Date();
    const allItems = await EditorialItem.find({
      userId,
      runDateKey: { $gte: new Date(new Date(now).setMonth(new Date(now).getMonth() - 6)).toISOString().slice(0, 10) },
    }).lean();

    const analysis = await editorialRepeatAnalyzerService.generateAllWindows({
      userId,
      generatedForDateKey: runDateKey,
      items: allItems
    });

    res.json({
      success: true,
      upload: {
        runDateKey,
        receivedCount: articles.length,
        savedCount
      },
      analysis
    });
  } catch (err) {
    console.error('editorial-engine upload-day failed:', err);
    res.status(500).json({
      error: err?.message || String(err),
      stack: err?.stack || null
    });
  }
});

// GET helper: latest analysis for a window
router.get('/analysis/:windowType', async (req, res) => {
  try {
    const userId = req.user._id;
    const { windowType } = req.params;

    const analysis = await EditorialRepeatAnalysis.findOne({
      userId,
      windowType,
      generatedForDateKey: { $exists: true }
    }).sort({ createdAt: -1 });

    res.json({ analysis: analysis || null });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/items/today — fetch latest day's saved items
router.get('/items/today', async (req, res) => {
  try {
    const userId = req.user._id;
    const todayKey = new Date().toISOString().slice(0, 10);

    let items = await EditorialItem.find({
      userId,
      runDateKey: todayKey
    }).sort({ sourceKey: 1, createdAt: -1 }).lean();

    // If nothing for today, fallback to most recent date with data
    if (items.length === 0) {
      const latest = await EditorialItem.findOne({ userId })
        .sort({ runDateKey: -1 })
        .select('runDateKey')
        .lean();

      if (latest?.runDateKey) {
        items = await EditorialItem.find({
          userId,
          runDateKey: latest.runDateKey
        }).sort({ sourceKey: 1, createdAt: -1 }).lean();

        return res.json({ items, dateKey: latest.runDateKey });
      }
    }

    res.json({ items, dateKey: todayKey });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/items?dateKey=YYYY-MM-DD — fetch items by date
// Also supports ?createdDate=YYYY-MM-DD to filter by creation/upload date
router.get('/items', async (req, res) => {
  try {
    const userId = req.user._id;
    const { dateKey, sourceKey, createdDate, limit } = req.query;

    const filter = { userId };
    if (dateKey) filter.runDateKey = dateKey;
    if (sourceKey) filter.sourceKey = sourceKey;
    if (createdDate) {
      const start = new Date(createdDate + 'T00:00:00+05:30');
      const end = new Date(createdDate + 'T23:59:59.999+05:30');
      filter.createdAt = { $gte: start, $lte: end };
    }

    const items = await EditorialItem.find(filter)
      .sort({ runDateKey: -1, sourceKey: 1, createdAt: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200))
      .lean();

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/items/jk — J&K related articles sorted by date
router.get('/items/jk', async (req, res) => {
  try {
    const userId = req.user._id;
    const items = await EditorialItem.find({ userId }).sort({ runDateKey: -1, createdAt: -1 }).lean();

    const jkPattern = /\b(jammu|kashmir|j&k|jammu\s*(and|&)\s*kashmir|ladakh|article\s*370|azad\s*kashmir|kargil|srinagar|kashmiri)\b/i;

    const jkItems = items.filter(it => {
      if (jkPattern.test(it.title)) return true;
      if (it.keyPointersContent) {
        try {
          const $ = cheerio.load(it.keyPointersContent);
          const headings = $('h2, h3').map((_, el) => $(el).text()).get();
          if (headings.some(h => jkPattern.test(h))) return true;
        } catch { /* skip */ }
      }
      if (it.description && jkPattern.test(it.description)) return true;
      return false;
    });

    res.json({ items: jkItems, count: jkItems.length });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/runs — latest scrape run records
router.get('/runs', async (req, res) => {
  try {
    const userId = req.user._id;
    const EditorialScrapeRun = (await import('../models/EditorialScrapeRun.js')).default;

    const runs = await EditorialScrapeRun.find({ userId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/dates — list distinct runDateKeys with count
router.get('/dates', async (req, res) => {
  try {
    const userId = req.user._id;

    const dates = await EditorialItem.distinct('runDateKey', { userId });
    const dateCounts = await EditorialItem.aggregate([
      { $match: { userId: userId } },
      { $group: { _id: '$runDateKey', count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 60 }
    ]);

    res.json({ dates: dateCounts.map(d => ({ dateKey: d._id, count: d.count })) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/editorial-engine/items/:id — fetch single item with content
router.get('/items/:id', async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await EditorialItem.findOne({ _id: req.params.id, userId }).lean();
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// PUT /api/editorial-engine/items/:id/content — save speech & key pointers HTML
router.put('/items/:id/content', async (req, res) => {
  try {
    const userId = req.user._id;
    const { speechContent, keyPointersContent } = req.body;

    const item = await EditorialItem.findOneAndUpdate(
      { _id: req.params.id, userId },
      { speechContent: speechContent || '', keyPointersContent: keyPointersContent || '' },
      { new: true }
    ).lean();

    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// POST /api/editorial-engine/items/:id/generate-speech — AI generates speech from keyPointersContent
router.post('/items/:id/generate-speech', async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await EditorialItem.findOne({ _id: req.params.id, userId }).lean();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const htmlContent = item.keyPointersContent || '';
    if (!htmlContent) return res.status(400).json({ error: 'No keyPointersContent to generate speech from' });

    const axiosMod = await import('axios');
    const axios = axiosMod.default;

    const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
    if (!NVIDIA_API_KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY not configured' });

    const model = process.env.NVIDIA_MODEL || 'meta/llama-4-maverick-17b-128e-instruct';
    const invokeUrl = process.env.NVIDIA_CHAT_COMPLETIONS_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPrompt = `You are a UPSC speech-composer. Convert the given editorial HTML content into a structured speech that a student reads aloud for speaking practice.

STRICT FORMAT — output ONLY valid HTML with these tags (no markdown, no JSON, no extra text):
- <p> for each spoken paragraph
- <h2> for section headings (Opening, Background, Main Issue, etc.)

SPEECH STRUCTURE (follow this order exactly):
1. Opening / Context: Start with <p>Good morning. Today, I would like to talk about <topic>.</p>
2. Background: <p>Why the issue exists — necessary context.</p>
3. Main Problem / Core Issue: <p>The central concern.</p>
4. Causes / Reasons: <p>Why the problem exists.</p>
5. Impact / Significance: <p>Why it matters for India — society, economy, governance, security, etc.</p>
6. Challenges / Counter Arguments: <p>Present the other side if relevant.</p>
7. Solutions / Way Forward: <p>Practical reforms and suggestions.</p>
8. Personal Opinion: <p>In my opinion... (balanced UPSC-style view)</p>
9. Conclusion: <p>To conclude... (summarize positively)</p>

WRITING STYLE:
- Natural, conversational tone — as if speaking to an audience
- Sound like a UPSC candidate explaining an issue, NOT reading an article
- Avoid robotic language
- Avoid excessive facts, dates, statistics, jargon unless necessary
- Smooth transitions between ideas

LENGTH: Concise — roughly 300–500 words total.`;

    const response = await axios.post(invokeUrl, {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Convert this editorial HTML into structured speech HTML:\n\n${htmlContent.slice(0, 15000)}` }
      ],
      max_tokens: 3000,
      temperature: 0.3
    }, {
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        Accept: 'application/json'
      },
      timeout: 120000
    });

    const speechText = response.data?.choices?.[0]?.message?.content?.trim() || '';

    await EditorialItem.updateOne(
      { _id: item._id },
      { speechContent: speechText }
    );

    res.json({ success: true, speechContent: speechText });
  } catch (err) {
    console.error('generate-speech error:', err);
    res.status(500).json({ error: err.message || String(err), stack: err.stack });
  }
});

// DELETE /api/editorial-engine/items/:id — delete a single item
router.delete('/items/:id', async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await EditorialItem.findOneAndDelete({ _id: req.params.id, userId });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// DELETE /api/editorial-engine/items — wipe all editorial data for the current user
router.delete('/items', async (req, res) => {
  try {
    const userId = req.user._id;

    const EditorialScrapeRun = (await import('../models/EditorialScrapeRun.js')).default;

    const delItems = await EditorialItem.deleteMany({ userId });
    const delAnalysis = await EditorialRepeatAnalysis.deleteMany({ userId });
    const delRuns = await EditorialScrapeRun.deleteMany({ userId });

    res.json({
      success: true,
      deleted: {
        items: delItems.deletedCount,
        analysis: delAnalysis.deletedCount,
        runs: delRuns.deletedCount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
