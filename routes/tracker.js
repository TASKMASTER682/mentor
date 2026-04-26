import express from 'express';
import { authenticate } from '../middleware/auth.js';
import DailyTracker from '../models/DailyTracker.js';
import User from '../models/User.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    const entries = await DailyTracker.find({ userId: req.user._id, date: { $gte: since } }).sort({ date: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      tasks, habits, focusScore, energyLevel, mood,
      notesPrepared, topicsNotUnderstood, notes, totalStudyHours,
      date: dateStr, completionRate
    } = req.body;

    // Handle new habits format
    let safeTasks = [];
    if (Array.isArray(habits) && habits.length > 0) {
      safeTasks = habits.map((h) => ({
        name: h.type,
        status: h.completed ? 'completed' : 'pending',
        actualHours: h.hours || 0,
      }));
    } else if (Array.isArray(tasks)) {
      safeTasks = tasks;
    }

    const safeTopics = Array.isArray(topicsNotUnderstood)
      ? topicsNotUnderstood
      : typeof topicsNotUnderstood === 'string'
        ? topicsNotUnderstood.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
    const safeTotalStudyHours = Number(totalStudyHours);

    // Normalize date to UTC-midnight
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    targetDate.setUTCHours(0, 0, 0, 0);

    const completedTasks = safeTasks.filter((t) => t?.status === 'completed').length;
    const computedCompletionRate = safeTasks.length > 0 
      ? Math.round((completedTasks / safeTasks.length) * 100) 
      : (completionRate || 0);
    const computedStudyHours = safeTasks.reduce((sum, t) => sum + (Number(t?.actualHours) || 0), 0);

    let aiInsight = "Keep up the great work!";
    // AI insight disabled for faster response
    // Can be enabled later if needed

    const data = {
      tasks: safeTasks,
      focusScore,
      energyLevel,
      mood,
      notesPrepared: Boolean(notesPrepared),
      topicsNotUnderstood: safeTopics,
      notes,
      totalStudyHours: !isNaN(safeTotalStudyHours) ? safeTotalStudyHours : computedStudyHours,
      completionRate: computedCompletionRate,
      aiInsight
    };

    let entry = await DailyTracker.findOne({ userId: req.user._id, date: targetDate });

    if (entry) {
      Object.assign(entry, data);
    } else {
      entry = new DailyTracker({ userId: req.user._id, date: targetDate, ...data });
    }
    await entry.save();

    const user = await User.findById(req.user._id);
    const lastDate = user.stats.lastStudyDate;

    // Streak logic using UTC dates for consistency
    const yesterday = new Date(targetDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    if (computedCompletionRate > 30) {
      const lastDateObj = lastDate ? new Date(lastDate) : null;
      if (lastDateObj) lastDateObj.setUTCHours(0, 0, 0, 0);

      if (lastDateObj && lastDateObj.getTime() === yesterday.getTime()) {
        user.stats.studyStreak += 1;
      } else if (!lastDateObj || lastDateObj.getTime() !== targetDate.getTime()) {
        user.stats.studyStreak = 1;
      }

      user.stats.longestStreak = Math.max(user.stats.longestStreak, user.stats.studyStreak);
      user.stats.totalStudyDays += 1;
      user.stats.lastStudyDate = targetDate;
      await user.save();
    }

    res.json(entry);
  } catch (err) {
    console.error("Submission Route Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

export default router;
