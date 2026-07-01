import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import Question from '../models/Question.js';

const router = Router();

// GET /api/quiz/generate — returns random questions
router.get('/generate', authenticate, async (req, res) => {
  try {
    let { count, subject, type } = req.query;
    count = parseInt(count) || 10;
    if (count < 1) count = 1;
    if (count > 30) count = 30;

    const filter = {};
    if (subject) filter.subject = subject;
    if (type) filter.type = type;

    const total = await Question.countDocuments(filter);
    if (total === 0) {
      return res.status(404).json({ error: 'No questions found for the given criteria' });
    }

    const actualCount = Math.min(count, total);
    const questions = await Question.aggregate([
      { $match: filter },
      { $sample: { size: actualCount } },
      { $project: { _id: 1, text: 1, options: 1, correctAnswer: 1, subject: 1, type: 1, explanation: 1, structure: 1 } }
    ]);

    res.json({ questions, total: actualCount });
  } catch (err) {
    console.error('Quiz generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
