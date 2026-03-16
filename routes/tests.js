import express from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import TestSeries from '../models/TestSeries.js';
import TestAttempt from '../models/TestAttempt.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Public - Get all test series (admin + user's own)
router.get('/', async (req, res) => {
  try {
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);
    
    let filter = {};
    
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'upsc_secret_key');
        const currentUserId = decoded.userId;
        filter.$or = [
          { userId: { $in: adminUserIds } },
          { userId: currentUserId }
        ];
      } catch (e) {
        filter.userId = { $in: adminUserIds };
      }
    } else {
      filter.userId = { $in: adminUserIds };
    }

    const tests = await TestSeries.find(filter);
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticated - Create test series (for user's own tests)
router.post('/', authenticate, async (req, res) => {
  try {
    const test = new TestSeries({ userId: req.user._id, ...req.body });
    await test.save();
    res.status(201).json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticated - Get user's series with attempts
router.get('/series-with-attempts', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);
    
    const seriesList = await TestSeries.find({
      $or: [
        { userId: { $in: adminUserIds } },
        { userId }
      ]
    }).lean();

    const enrichedSeries = await Promise.all(seriesList.map(async (series) => {
      const seriesNamePattern = escapeRegex(series.name || '');

      const autoAttempts = await TestAttempt.find({
        userId,
        $or: [
          { testSeriesId: series._id },
          {
            testSeriesId: { $in: [null, undefined] },
            testName: { $regex: seriesNamePattern, $options: 'i' }
          }
        ]
      }).lean();


      const manualAttempts = series.attempts || [];

      const allAttempts = [...manualAttempts, ...autoAttempts].sort((a, b) =>
        new Date(a.date || a.submittedAt || a.createdAt || 0) -
        new Date(b.date || b.submittedAt || b.createdAt || 0)
      );

      return { ...series, attempts: allAttempts };
    }));

    res.json(enrichedSeries);
  } catch (error) {
    console.error('Error in series-with-attempts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin only - Delete test series
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const series = await TestSeries.findOneAndDelete({
      _id: req.params.id
    });

    if (!series) return res.status(404).json({ error: 'Series not found' });

    await TestAttempt.deleteMany({ 
      testSeriesId: req.params.id 
    });

    res.json({ message: 'Series and associated attempts deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Authenticated - Add attempt to test series
router.post('/:id/attempt', authenticate, async (req, res) => {
  try {
    const test = await TestSeries.findOne({ _id: req.params.id });
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const attempt = { ...req.body, date: new Date() };
    attempt.percentage = Math.round((attempt.score / attempt.totalMarks) * 100);
    test.attempts.push(attempt);

    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 7);
    test.nextRecommendedDate = nextDate;

    await test.save();
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
