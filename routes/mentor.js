import express from 'express';
import { authenticate } from '../middleware/auth.js';
import DailyTracker from '../models/DailyTracker.js';
import Mission from '../models/Mission.js';
import LibrarySource from '../models/LibrarySource.js';
import { aiService } from '../services/aiService.js';

const router = express.Router();
router.use(authenticate);
router.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    const user = req.user;
    
    const [recentEntries, activeMissions, sources] = await Promise.all([
      DailyTracker.find({ userId: user._id }).sort({ date: -1 }).limit(7),
      Mission.find({ userId: user._id, status: 'active' }),
      LibrarySource.find({ userId: user._id })
    ]);

    const response = await aiService.mentorChat({
      message,
      conversationHistory,
      user,
      context: { 
        recentEntries, 
        activeMissions, 
        sources 
      }
    });

    res.json({ response });
  } catch (err) {
    console.error('[Mentor] Chat Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to get response from mentor.' });
  }
});
router.get('/weekly-report', async (req, res) => {
  try {
    const user = req.user;
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [entries, missions] = await Promise.all([
      DailyTracker.find({ userId: user._id, date: { $gte: weekAgo } }),
      Mission.find({ userId: user._id, status: 'active' })
    ]);

    const report = await aiService.generateWeeklyReport({ 
      user, 
      entries, 
      missions 
    });

    res.json(report);
  } catch (err) {
    console.error('Weekly Report Error:', err);
    res.status(500).json({ error: 'Could not generate weekly report.' });
  }
});

export default router;
