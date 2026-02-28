

import express from 'express';
import { authenticate } from '../middleware/auth.js';
import DailyTracker from '../models/DailyTracker.js';
import User from '../models/User.js';
import { aiService } from '../services/aiService.js';

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
      tasks, focusScore, energyLevel, mood, 
      notesPrepared, topicsNotUnderstood, notes, totalStudyHours 
    } = req.body;
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    const safeTopics = Array.isArray(topicsNotUnderstood)
      ? topicsNotUnderstood
      : typeof topicsNotUnderstood === 'string'
        ? topicsNotUnderstood.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
    const safeTotalStudyHours = Number(totalStudyHours);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const completedTasks = safeTasks.filter(t => t?.status === 'completed').length;
    const completionRate = safeTasks.length > 0 ? Math.round((completedTasks / safeTasks.length) * 100) : 0;
    const computedStudyHours = safeTasks.reduce((sum, t) => sum + (Number(t?.actualHours) || 0), 0);
    let aiInsight = "Great effort today! ARJUN is tracking your progress.";
    try {
      const recentEntries = await DailyTracker.find({ userId: req.user._id }).sort({ date: -1 }).limit(7);
      aiInsight = await aiService.generateDailyInsight({ 
        tasks: safeTasks, focusScore, mood, energyLevel, 
        completionRate, notesPrepared, topicsNotUnderstood,
        recentEntries 
      });
    } catch (aiErr) {
      console.error("AI Insight Generation Failed:", aiErr.message);
    }

    const data = { 
      tasks: safeTasks,
      focusScore,
      energyLevel,
      mood,
      notesPrepared: Boolean(notesPrepared),
      topicsNotUnderstood: safeTopics,
      notes,
      totalStudyHours: !isNaN(safeTotalStudyHours) ? safeTotalStudyHours : computedStudyHours,
      completionRate,
      aiInsight 
    };
    let entry = await DailyTracker.findOne({ userId: req.user._id, date: today });

    if (entry) {
      Object.assign(entry, data);
    } else {
      entry = new DailyTracker({ userId: req.user._id, date: today, ...data });
    }
    await entry.save();
    const user = await User.findById(req.user._id); // Re-fetch to be safe
    const lastDate = user.stats.lastStudyDate;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (completionRate > 30) {
      if (lastDate && new Date(lastDate).toDateString() === yesterday.toDateString()) {
        user.stats.studyStreak += 1;
      } else if (!lastDate || new Date(lastDate).toDateString() !== today.toDateString()) {
        user.stats.studyStreak = 1;
      }
      
      user.stats.longestStreak = Math.max(user.stats.longestStreak, user.stats.studyStreak);
      user.stats.totalStudyDays += 1;
      user.stats.lastStudyDate = today;
      await user.save();
    }

    res.json(entry);
  } catch (err) {
    console.error("Submission Route Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

export default router;

