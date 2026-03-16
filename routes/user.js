import express from 'express';
import { authenticate } from '../middleware/auth.js';
import User from '../models/User.js';
import DailyTracker from '../models/DailyTracker.js';

const router = express.Router();
router.use(authenticate);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

router.get('/profile', async (req, res) => {
  try {
    const user = req.user;
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, profile: user.profile, stats: user.stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/profile', async (req, res) => {
  try {
    const { profile } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { profile: { ...req.user.profile.toObject(), ...profile } },
      { returnDocument: 'after' }
    );
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, profile: user.profile, stats: user.stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const user = req.user;

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const confidenceWindowStart = new Date();
    confidenceWindowStart.setDate(confidenceWindowStart.getDate() - 14);

    const [weekEntries, confidenceEntries] = await Promise.all([
      DailyTracker.find({ userId: user._id, date: { $gte: weekAgo } }),
      DailyTracker.find({ userId: user._id, date: { $gte: confidenceWindowStart } }),
    ]);

    const weeklyProductivity = weekEntries.length > 0
      ? Math.round(weekEntries.reduce((sum, e) => sum + (Number(e.completionRate) || 0), 0) / weekEntries.length)
      : 0;

    const confidenceScore = confidenceEntries.length > 0
      ? Math.round(
          confidenceEntries.reduce((sum, e) => {
            const completion = clamp(Number(e.completionRate) || 0, 0, 100);
            const focusAsPercent = clamp((Number(e.focusScore) || 0) * 10, 0, 100);
            return sum + (completion * 0.6) + (focusAsPercent * 0.4);
          }, 0) / confidenceEntries.length
        )
      : clamp(Number(user?.stats?.confidenceScore) || 50, 0, 100);

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        'stats.weeklyProductivity': weeklyProductivity,
        'stats.confidenceScore': confidenceScore,
      },
      { returnDocument: 'after' }
    );

    res.json({
      ...updatedUser.stats.toObject(),
      weeklyProductivity,
      confidenceScore,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
