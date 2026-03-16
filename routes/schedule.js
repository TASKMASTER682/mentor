import express from 'express';
import { authenticate } from '../middleware/auth.js';
import Schedule from '../models/Schedule.js';
import { schedulerService } from '../services/schedulerService.js';

const router = express.Router();
router.use(authenticate);

router.get('/today', async (req, res) => {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let schedule = await Schedule.findOne({ userId: req.user._id, date: today });

    if (!schedule) {
      schedule = await schedulerService.generateScheduleForUser(req.user, { date: today });
    }
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/date/:date', async (req, res) => {
  try {
    const date = new Date(req.params.date);
    date.setUTCHours(0, 0, 0, 0);
    const schedule = await Schedule.findOne({ userId: req.user._id, date });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const dateStr = req.body?.date;
    const now = new Date();
    const startMinutes = (now.getHours() * 60) + now.getMinutes();
    console.log('[Schedule Generate] Current time minutes:', startMinutes, '| Date:', dateStr);
    if (startMinutes >= (23 * 60 + 45)) {
      return res.status(400).json({ error: 'Schedule can be generated only before 11:45 PM for today.' });
    }
    const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    const targetDate = dateStr ? new Date(dateStr) : new Date();
    targetDate.setUTCHours(0, 0, 0, 0);

    // Use reasonable window - if current time is after 10 PM, use next day's early window logic
    // For now, always use a fixed window from 9 AM to 11 PM for scheduling
    const windowStart = 6 * 60;  // 6 AM
    const windowEnd = 23 * 60;  // 11 PM

    const schedule = await schedulerService.generateScheduleForUser(req.user, {
      resetRefinements: true,
      date: targetDate,
      scheduleWindow: {
        startTime: toHHMM(windowStart),
        endTime: toHHMM(windowEnd),
      },
    });
    res.json(schedule);
  } catch (err) {
    console.error('[Schedule Generate Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/refine', async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || '').trim();
    const dateStr = req.body?.date;
    if (!instruction) {
      return res.status(400).json({ error: 'Instruction is required' });
    }

    const targetDate = dateStr ? new Date(dateStr) : new Date();
    targetDate.setUTCHours(0, 0, 0, 0);

    const schedule = await schedulerService.refineTodayScheduleForUser(req.user, instruction, targetDate);
    res.json(schedule);
  } catch (err) {
    if (err?.code === 'REFINEMENT_LIMIT') {
      return res.status(400).json({ error: 'You can refine today\'s schedule only 2 times.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.patch('/block/:blockIndex/complete', async (req, res) => {
  try {
    const { blockIndex } = req.params;
    const { timeSpent } = req.body; // minutes spent
    
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    const schedule = await Schedule.findOne({ userId: req.user._id, date: today });
    if (!schedule) {
      return res.status(404).json({ error: 'No schedule found for today' });
    }
    
    const index = parseInt(blockIndex);
    if (isNaN(index) || index < 0 || index >= schedule.blocks.length) {
      return res.status(400).json({ error: 'Invalid block index' });
    }
    
    schedule.blocks[index].completed = true;
    schedule.blocks[index].completedAt = new Date();
    if (timeSpent) {
      schedule.blocks[index].timeSpent = timeSpent;
    }
    
    await schedule.save();
    
    res.json({
      success: true,
      block: schedule.blocks[index],
      completedCount: schedule.blocks.filter(b => b.completed).length,
      totalBlocks: schedule.blocks.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/block/:blockIndex/incomplete', async (req, res) => {
  try {
    const { blockIndex } = req.params;
    
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    const schedule = await Schedule.findOne({ userId: req.user._id, date: today });
    if (!schedule) {
      return res.status(404).json({ error: 'No schedule found for today' });
    }
    
    const index = parseInt(blockIndex);
    if (isNaN(index) || index < 0 || index >= schedule.blocks.length) {
      return res.status(400).json({ error: 'Invalid block index' });
    }
    
    schedule.blocks[index].completed = false;
    schedule.blocks[index].completedAt = null;
    schedule.blocks[index].timeSpent = 0;
    schedule.blocks[index].timerStartedAt = null;
    
    await schedule.save();
    
    res.json({
      success: true,
      block: schedule.blocks[index],
      completedCount: schedule.blocks.filter(b => b.completed).length,
      totalBlocks: schedule.blocks.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/block/:blockIndex/timer', async (req, res) => {
  try {
    const { blockIndex } = req.params;
    const { action } = req.body; // 'start' or 'stop'
    
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    const schedule = await Schedule.findOne({ userId: req.user._id, date: today });
    if (!schedule) {
      return res.status(404).json({ error: 'No schedule found for today' });
    }
    
    const index = parseInt(blockIndex);
    if (isNaN(index) || index < 0 || index >= schedule.blocks.length) {
      return res.status(400).json({ error: 'Invalid block index' });
    }
    
    const block = schedule.blocks[index];
    
    if (action === 'start') {
      block.timerStartedAt = new Date();
    } else if (action === 'stop') {
      if (block.timerStartedAt) {
        const elapsed = Math.round((new Date().getTime() - block.timerStartedAt.getTime()) / 60000);
        block.timeSpent = (block.timeSpent || 0) + elapsed;
        block.timerStartedAt = null;
      }
    }
    
    await schedule.save();
    
    res.json({
      success: true,
      block,
      elapsedMinutes: block.timerStartedAt 
        ? Math.round((new Date().getTime() - new Date(block.timerStartedAt).getTime()) / 60000)
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
