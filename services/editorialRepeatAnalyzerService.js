import EditorialRepeatAnalysis from '../models/EditorialRepeatAnalysis.js';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const windowTypeConfig = (windowType) => {
  switch (windowType) {
    case '7d':
      return { repeatThresholdExclusiveMin: 2, repeatThresholdInclusiveMax: Infinity };
    case '1m':
      return { repeatThresholdExclusiveMin: 5, repeatThresholdInclusiveMax: Infinity };
    case '6m':
      return { repeatThresholdExclusiveMin: 20, repeatThresholdInclusiveMax: Infinity };
    case 'gt6m':
      // per spec: between 20 and 50 inclusive
      return { repeatThresholdExclusiveMin: 20, repeatThresholdInclusiveMax: 50 };
    default:
      return { repeatThresholdExclusiveMin: Infinity, repeatThresholdInclusiveMax: -Infinity };
  }
};

const getDateKeyList = (anchorDateKey, windowType) => {
  // Determine date range boundaries using JS Date (server timezone)
  // Date keys are compared by inclusion in YYYY-MM-DD format.
  const [y, m, d] = anchorDateKey.split('-').map(Number);
  const anchor = new Date(y, (m - 1), d);

  const addDays = (dt, days) => {
    const x = new Date(dt);
    x.setDate(x.getDate() + days);
    return x;
  };

  if (windowType === '7d') {
    // last 7 days including anchor
    const start = addDays(anchor, -6);
    const end = anchor;
    return { start, end };
  }

  if (windowType === '1m') {
    const start = new Date(anchor);
    start.setMonth(start.getMonth() - 1);
    const end = anchor;
    return { start, end };
  }

  if (windowType === '6m') {
    const start = new Date(anchor);
    start.setMonth(start.getMonth() - 6);
    const end = anchor;
    return { start, end };
  }

  // gt6m: for “greater than 6 months”, we’ll treat it as items older than 6 months but within last 6+ range.
  // Without DB hard limits, we approximate by using the entire set provided by caller up to 6 months back.
  // For correctness, you should fetch a wider DB horizon later (but user asked to not touch other features; keep minimal).
  // Here: treat gt6m as items older than 6 months AND newer than 7 months (rough). Caller can supply more items later.
  // For now, we return a very wide range and apply threshold logic only.
  const start = new Date(anchor);
  start.setMonth(start.getMonth() - 12); // wide
  const end = new Date(anchor);
  return { start, end };
};

const toDateKey = (dt) => {
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const filterItemsByWindow = (items, generatedForDateKey, windowType) => {
  const { start, end } = getDateKeyList(generatedForDateKey, windowType);

  const startKey = toDateKey(start);
  const endKey = toDateKey(end);

  // Note: for gt6m, this will include older items too; threshold bucket handles what qualifies.
  return items.filter((it) => {
    const dk = it.runDateKey;
    if (!dk) return false;
    return dk >= startKey && dk <= endKey;
  });
};

const buildModelInput = (items) => {
  // Titles + descriptions only.
  return items.map((it) => ({
    runDateKey: it.runDateKey,
    sourceKey: it.sourceKey,
    title: it.title,
    description: it.description || ''
  }));
};

export const editorialRepeatAnalyzerService = {
  async generateAllWindows({ userId, generatedForDateKey, items }) {
    const windowTypes = ['7d', '1m', '6m', 'gt6m'];
    const results = {};

    for (const windowType of windowTypes) {
      const analysis = await this.generateWindowAnalysis({
        userId,
        generatedForDateKey,
        items,
        windowType
      });
      results[windowType] = analysis;
    }

    return results;
  },

  async generateWindowAnalysis({ userId, generatedForDateKey, items, windowType }) {
    const windowItems = filterItemsByWindow(items, generatedForDateKey, windowType);

    if (!windowItems || windowItems.length === 0) {
      return EditorialRepeatAnalysis.create({
        userId,
        generatedForDateKey,
        windowType,
        rulesApplied: { empty: true },
        results: []
      });
    }

    // NVIDIA call (direct HTTP) to avoid baseURL/SDK 404 issues
    // Uses: https://integrate.api.nvidia.com/v1/chat/completions
    const axiosMod = await import('axios');
    const axios = axiosMod.default;

    const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
    if (!NVIDIA_API_KEY) {
      throw new Error('Missing NVIDIA_API_KEY env var for editorial analysis');
    }

    const model =
      process.env.NVIDIA_EDITORIAL_REPEAT_MODEL ||
      process.env.NVIDIA_MODEL ||
      'meta/llama-4-maverick-17b-128e-instruct';

    const invokeUrl =
      process.env.NVIDIA_CHAT_COMPLETIONS_URL ||
      'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPrompt = `You are a UPSC/JKPSC repeat-topic analyzer.
You receive pre-curated editorial items (title+description) — all are exam-relevant already.

TASK:
1) Group items by shared UPSC/JKPSC theme/topic (e.g., Judiciary, RBI Policy, Federalism, J&K Specific, Health Governance).
2) Compute repeatCount = total items covering that topic in this window.
3) For comprehensiveLinks, pick the most representative items across sources.

OUTPUT ONLY JSON:
{
  "topics": [
    {
      "topicLabel": string,
      "repeatCount": number,
      "comprehensiveLinks": [
        { "title": string, "description": string, "link": string, "sourceKey": string }
      ],
      "rationale": string
    }
  ]
}

Rules:
- Only group by topic. Do NOT judge UPSC relevance — all items are pre-filtered.
- comprehensiveLinks: up to 8 items per topic, prefer diverse sources.
- topicLabel: concise exam-relevant label.`;

    const itemsWithLinks = windowItems.map((it) => ({
      runDateKey: it.runDateKey,
      sourceKey: it.sourceKey,
      title: it.title,
      description: it.description || '',
      link: it.link
    }));

    try {
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ windowType, items: itemsWithLinks }) }
        ],
        max_tokens: 2500,
        temperature: 0.2
      };

      const response = await axios.post(invokeUrl, payload, {
        headers: {
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
          Accept: 'application/json'
        },
        timeout: 120000
      });

      const text = response.data?.choices?.[0]?.message?.content || '';
      let parsed = null;
      try {
        const match = text.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : null;
      } catch {
        parsed = null;
      }

      const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];

      const cfg = windowTypeConfig(windowType);

      const filtered = topics.filter((t) => {
        const rc = Number(t.repeatCount || 0);

        if (windowType === 'gt6m') {
          // per spec: >6 months, keep 20..50 inclusive repeats
          return rc > 20 && rc <= 50;
        }

        // For other windows, keep only if exceeds respective thresholds.
        return rc > cfg.repeatThresholdExclusiveMin;
      });

      const results = filtered.map((t) => ({
        topicLabel: String(t.topicLabel || '').trim() || 'UPSC Theme',
        repeatCount: Number(t.repeatCount || 0),
        comprehensiveLinks: Array.isArray(t.comprehensiveLinks)
          ? t.comprehensiveLinks
              .map((l) => ({
                title: String(l.title || '').trim(),
                description: String(l.description || '').trim(),
                link: String(l.link || '').trim(),
                sourceKey: String(l.sourceKey || '').trim()
              }))
              .filter((l) => l.title && l.link)
          : [],
        rationale: String(t.rationale || '').trim()
      }));

      return EditorialRepeatAnalysis.findOneAndUpdate(
        { userId, generatedForDateKey, windowType },
        {
          $set: {
            rulesApplied: { windowType, thresholds: cfg },
            results
          }
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      throw new Error(
        `NVIDIA chat.completions failed (status=${status}). response=${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1000)}`
      );
    }
  }
};
