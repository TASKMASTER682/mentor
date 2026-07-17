import express from 'express';
import { authenticate } from '../middleware/auth.js';
import PrelimsItem from '../models/PrelimsItem.js';
import { scrapeAndSavePrelims } from '../services/prelimsScraperService.js';

const router = express.Router();

// POST /api/prelims/load-today
router.post('/load-today', authenticate, async (req, res) => {
  try {
    const result = await scrapeAndSavePrelims('today', req.user._id);
    res.json(result);
  } catch (err) {
    console.error('[Prelims] load-today error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// POST /api/prelims/load-yesterday
router.post('/load-yesterday', authenticate, async (req, res) => {
  try {
    const result = await scrapeAndSavePrelims('yesterday', req.user._id);
    res.json(result);
  } catch (err) {
    console.error('[Prelims] load-yesterday error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/prelims/items — fetch prelims articles
router.get('/items', authenticate, async (req, res) => {
  try {
    const { dateKey, limit } = req.query;
    const filter = { userId: req.user._id };
    if (dateKey) filter.runDateKey = dateKey;
    const items = await PrelimsItem.find(filter)
      .sort({ runDateKey: -1, createdAt: -1 })
      .limit(parseInt(limit) || 50)
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/prelims/dates — get available dates with counts
router.get('/dates', authenticate, async (req, res) => {
  try {
    const dates = await PrelimsItem.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: '$runDateKey', count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
    ]);
    res.json({ dates });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
