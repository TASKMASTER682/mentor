import express from 'express';
import { authenticate } from '../middleware/auth.js';
import Mission from '../models/Mission.js';
import LibrarySource from '../models/LibrarySource.js';
import User from '../models/User.js';
import { aiService } from '../services/aiService.js';

const router = express.Router();
router.use(authenticate);
router.get('/', async (req, res) => {
  try {
    const missions = await Mission.find({ userId: req.user._id }).sort({ priority: 1, deadline: 1 });
    res.json(missions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/', async (req, res) => {
  try {
    const { title, subject, deadline, description } = req.body;
    const user = req.user;
    const sources = await LibrarySource.find({ userId: user._id, subject });
    const allChapters = [];
    sources.forEach(src => {
      src.chapters.forEach(ch => {
        if (ch.status !== 'completed') allChapters.push({ title: ch.title, estimatedHours: ch.estimatedHours || 2, sourceId: src._id });
      });
    });

    const deadlineDate = new Date(deadline);
    const now = new Date();
    const daysAvailable = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));

    if (daysAvailable <= 0) return res.status(400).json({ error: 'Deadline must be in the future' });

    const totalHoursNeeded = allChapters.reduce((sum, ch) => sum + ch.estimatedHours, 0);
    const availableHoursPerDay = user.profile.dailyStudyHours * 0.4; // 40% of daily hours for mission
    const totalAvailableHours = availableHoursPerDay * daysAvailable;

    let warning = null;
    if (totalHoursNeeded > totalAvailableHours * 1.2) {
      warning = `This mission requires ~${totalHoursNeeded}h but only ~${Math.round(totalAvailableHours)}h available. Consider extending deadline to ${Math.ceil(totalHoursNeeded / availableHoursPerDay)} days.`;
    }
    const activeMissions = await Mission.countDocuments({ userId: user._id, status: 'active' });
    const strategy = await aiService.generateMissionStrategy({
      title, subject, chapters: allChapters, daysAvailable,
      dailyHours: availableHoursPerDay, userProfile: user.profile
    });
    const dailyPlan = [];
    let chapterQueue = [...allChapters];
    for (let i = 0; i < daysAvailable && chapterQueue.length > 0; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      const dayChapters = [];
      let dayHours = 0;
      while (chapterQueue.length > 0 && dayHours + chapterQueue[0].estimatedHours <= availableHoursPerDay) {
        const ch = chapterQueue.shift();
        dayChapters.push(ch.title);
        dayHours += ch.estimatedHours;
      }
      if (dayChapters.length > 0) dailyPlan.push({ date, chapters: dayChapters, estimatedHours: dayHours, completed: false });
    }

    const mission = new Mission({
      userId: user._id, title, subject, description, deadline: deadlineDate,
      totalChapters: allChapters.length, dailyPlan,
      totalHoursNeeded, dailyHoursRequired: availableHoursPerDay,
      priority: activeMissions + 1, warningIssued: !!warning,
      aiStrategy: strategy
    });

    await mission.save();
    res.status(201).json({ mission, warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch('/:id/progress', async (req, res) => {
  try {
    const { completedChapters, dayIndex, completed } = req.body;
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    if (completedChapters !== undefined) mission.completedChapters = completedChapters;
    if (dayIndex !== undefined && completed !== undefined) {
      mission.dailyPlan[dayIndex].completed = completed;
    }
    if (mission.completedChapters >= mission.totalChapters) {
      mission.status = 'completed';
      mission.completedAt = new Date();
      await User.findByIdAndUpdate(req.user._id, { $inc: { 'stats.confidenceScore': 5 } }, { returnDocument: 'after' });
    }

    await mission.save();
    res.json(mission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/:id/rebalance', async (req, res) => {
  try {
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    const now = new Date();
    const remainingChapters = mission.totalChapters - mission.completedChapters;
    const daysLeft = Math.ceil((mission.deadline - now) / (1000 * 60 * 60 * 24));
    const newDailyTarget = remainingChapters / Math.max(daysLeft, 1);

    mission.dailyHoursRequired = newDailyTarget * 2;
    mission.missedDays += 1;
    await mission.save();

    res.json({ mission, newDailyTarget: Math.ceil(newDailyTarget), daysLeft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    await Mission.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/toggle-task', async (req, res) => {
  try {
    const { date } = req.body;
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    const targetDate = new Date(date).toDateString();
    const day = mission.dailyPlan.find(d => new Date(d.date).toDateString() === targetDate);

    if (!day) return res.status(404).json({ error: 'Task for this date not found in mission' });
    const wasCompleted = day.completed;
    day.completed = !day.completed;
    const dayChaptersCount = day.chapters.length;
    
    if (day.completed) {
      mission.completedChapters += dayChaptersCount;
    } else {
      mission.completedChapters = Math.max(0, mission.completedChapters - dayChaptersCount);
    }
    if (mission.completedChapters >= mission.totalChapters) {
      mission.status = 'completed';
      mission.completedAt = new Date();
      await User.findByIdAndUpdate(req.user._id, { $inc: { 'stats.confidenceScore': 5 } });
    } else {
      mission.status = 'active'; // Agar wapas un-tick kiya to active kardo
    }

    await mission.save();
    res.json({ mission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;


