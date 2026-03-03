import express from 'express';
import { authenticate } from '../middleware/auth.js';
import DDayTarget from '../models/DDayTarget.js';

const router = express.Router();
router.use(authenticate);

const normalizeDateOnly = (raw) => {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const cleanupExpired = async (userId) => {
  const now = new Date();
  await DDayTarget.deleteMany({ userId, expiresAt: { $lte: now } });
};

const serialize = (doc) => ({
  _id: doc._id,
  targetName: doc.targetName,
  targetDate: doc.targetDate,
  expiresAt: doc.expiresAt,
});
router.get('/', async (req, res) => {
  try {
    await cleanupExpired(req.user._id);

    const targets = await DDayTarget.find({ userId: req.user._id })
      .sort({ targetDate: 1, createdAt: -1 });

    res.json(targets.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/current', async (req, res) => {
  try {
    await cleanupExpired(req.user._id);

    const target = await DDayTarget.findOne({ userId: req.user._id })
      .sort({ targetDate: 1, createdAt: -1 });

    if (!target) return res.json(null);
    res.json(serialize(target));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/', async (req, res) => {
  try {
    const targetName = String(req.body?.targetName || '').trim();
    const targetDate = normalizeDateOnly(req.body?.targetDate);

    if (!targetName) return res.status(400).json({ error: 'targetName is required' });
    if (!targetDate) return res.status(400).json({ error: 'targetDate is invalid' });

    const expiresAt = new Date(targetDate);
    expiresAt.setDate(expiresAt.getDate() + 1); // delete after D-Day ends

    const saved = await DDayTarget.create({
      userId: req.user._id,
      targetName,
      targetDate,
      expiresAt,
    });

    res.status(201).json(serialize(saved));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete('/current', async (req, res) => {
  try {
    const current = await DDayTarget.findOne({ userId: req.user._id })
      .sort({ targetDate: 1, createdAt: -1 });

    if (current) {
      await DDayTarget.deleteOne({ _id: current._id, userId: req.user._id });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await DDayTarget.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!deleted) return res.status(404).json({ error: 'Target not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

