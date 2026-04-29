import express from 'express';
import { authenticate } from '../middleware/auth.js';
import DailyPlan from '../models/DailyPlan.js';
import { eachDayOfInterval, format } from 'date-fns';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const plans = await DailyPlan.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const plan = await DailyPlan.findOne({ _id: req.params.id, userId: req.user._id });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { planName, startDate, endDate, tasks } = req.body;
    
    if (!planName || !startDate || !endDate || !tasks || !tasks.length) {
      return res.status(400).json({ error: 'Plan name, dates, and at least one task required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = eachDayOfInterval({ start, end });
    const totalDays = days.length;

    const logEntries = [];
    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      tasks.forEach(task => {
        logEntries.push({
          date: dateStr,
          taskId: task.taskId,
          taskName: task.taskName,
          status: 'pending',
          completedAt: null
        });
      });
    });

    const plan = new DailyPlan({
      userId: req.user._id,
      planName,
      startDate: start,
      endDate: end,
      tasks: tasks.map(t => ({ taskName: t.taskName, optionalTarget: t.optionalTarget || '' })),
      dailyLogs: logEntries
    });

    await plan.save();
    res.status(201).json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/toggle', async (req, res) => {
  try {
    const { date, taskId } = req.body;
    const plan = await DailyPlan.findOne({ _id: req.params.id, userId: req.user._id });
    
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const dateStr = date || format(new Date(), 'yyyy-MM-dd');
    const today = format(new Date(), 'yyyy-MM-dd');

    if (dateStr < today) {
      return res.status(403).json({ error: 'Cannot modify tasks for past days' });
    }
    
    const logEntry = plan.dailyLogs.find(
      l => l.date === dateStr && l.taskId === taskId
    );

    if (logEntry) {
      if (logEntry.status === 'completed') {
        logEntry.status = 'pending';
        logEntry.completedAt = null;
      } else {
        logEntry.status = 'completed';
        logEntry.completedAt = new Date();
      }
    } else {
      plan.dailyLogs.push({
        date: dateStr,
        taskId,
        taskName: plan.tasks.find(t => t._id.toString() === taskId)?.taskName || '',
        status: 'completed',
        completedAt: new Date()
      });
    }

    await plan.save();
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/logs', async (req, res) => {
  try {
    const plan = await DailyPlan.findOne({ _id: req.params.id, userId: req.user._id });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    
    const logs = {};
    plan.dailyLogs.forEach(log => {
      if (!logs[log.date]) logs[log.date] = [];
      logs[log.date].push({
        taskId: log.taskId,
        taskName: log.taskName,
        status: log.status,
        completedAt: log.completedAt
      });
    });

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/stats', async (req, res) => {
  try {
    const plan = await DailyPlan.findOne({ _id: req.params.id, userId: req.user._id });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const today = format(new Date(), 'yyyy-MM-dd');
    const start = new Date(plan.startDate);
    const end = new Date(plan.endDate);
    const totalTasks = plan.tasks.length;
    const totalDays = eachDayOfInterval({ start, end }).length;

    const completedDaysSet = new Set();
    let maxStreak = 0;
    let currentStreak = 0;

    const logByDate = {};
    plan.dailyLogs.forEach(log => {
      if (!logByDate[log.date]) logByDate[log.date] = { completed: 0, total: totalTasks };
      if (log.status === 'completed') {
        logByDate[log.date].completed++;
        completedDaysSet.add(log.date);
      }
    });

    const dates = eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'));
    
    dates.forEach(date => {
      const dayData = logByDate[date] || { completed: 0, total: totalTasks };
      const ratio = dayData.total > 0 ? dayData.completed / dayData.total : 0;

      if (date <= today && ratio >= 0.8) {
        currentStreak++;
        if (currentStreak > maxStreak) maxStreak = currentStreak;
      } else if (date <= today) {
        currentStreak = 0;
      }
    });

    const expectedDays = Math.min(
      Math.max(0, Math.ceil((new Date() - start) / (1000 * 60 * 60 * 24)) + 1),
      totalDays
    );
    const onTrackDays = [...completedDaysSet].filter(d => d <= today).length;
    const trackScore = expectedDays > 0 ? onTrackDays / expectedDays : 0;

    const todayData = logByDate[today] || { completed: 0, total: totalTasks };
    const todayRatio = totalTasks > 0 ? todayData.completed / totalTasks : 0;

    const graphData = dates.slice(0, dates.indexOf(today) + 1 || undefined).map(date => {
      const dayData = logByDate[date] || { completed: 0, total: totalTasks };
      return {
        date,
        completed: dayData.completed,
        total: totalTasks,
        ratio: totalTasks > 0 ? dayData.completed / totalTasks : 0
      };
    });

    res.json({
      totalTasks,
      totalDays,
      completedDays: completedDaysSet.size,
      streak: currentStreak,
      maxStreak,
      todayRatio,
      trackScore,
      onTrack: trackScore >= 0.8,
      graphData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await DailyPlan.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;