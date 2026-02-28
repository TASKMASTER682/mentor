import express from 'express';
import { authenticate } from '../middleware/auth.js';
import TestSeries from '../models/TestSeries.js';
import TestAttempt from '../models/TestAttempt.js';

const router = express.Router();
router.use(authenticate);

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/', async (req, res) => {
  try {
    const tests = await TestSeries.find({ userId: req.user._id });
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const test = new TestSeries({ userId: req.user._id, ...req.body });
    await test.save();
    res.status(201).json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/series-with-attempts', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const seriesList = await TestSeries.find({ userId }).lean();

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

router.delete('/:id', async (req, res) => {
  try {
    const series = await TestSeries.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!series) return res.status(404).json({ error: 'Series not found' });

    // Delete all attempts associated with this series
    await TestAttempt.deleteMany({ 
      userId: req.user.id,
      testSeriesId: req.params.id 
    });

    res.json({ message: 'Series and associated attempts deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/attempt', async (req, res) => {
  try {
    const test = await TestSeries.findOne({ _id: req.params.id, userId: req.user._id });
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
