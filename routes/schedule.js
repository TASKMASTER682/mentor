import express from 'express';
import { authenticate } from '../middleware/auth.js';
import Schedule from '../models/Schedule.js';
import { schedulerService } from '../services/schedulerService.js';

const router = express.Router();
router.use(authenticate);

router.get('/today', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let schedule = await Schedule.findOne({ userId: req.user._id, date: today });

    if (!schedule) {
      schedule = await schedulerService.generateScheduleForUser(req.user);
    }
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/date/:date', async (req, res) => {
  try {
    const date = new Date(req.params.date);
    date.setHours(0, 0, 0, 0);
    const schedule = await Schedule.findOne({ userId: req.user._id, date });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const now = new Date();
    const startMinutes = (now.getHours() * 60) + now.getMinutes();
    if (startMinutes >= (23 * 60)) {
      return res.status(400).json({ error: 'Schedule can be generated only before 11:00 PM for today.' });
    }
    const roundedStart = Math.min(23 * 60, Math.ceil(startMinutes / 15) * 15);
    const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    const schedule = await schedulerService.generateScheduleForUser(req.user, {
      resetRefinements: true,
      scheduleWindow: {
        startTime: toHHMM(roundedStart),
        endTime: '23:00',
      },
    });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refine', async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) {
      return res.status(400).json({ error: 'Instruction is required' });
    }

    const schedule = await schedulerService.refineTodayScheduleForUser(req.user, instruction);
    res.json(schedule);
  } catch (err) {
    if (err?.code === 'REFINEMENT_LIMIT') {
      return res.status(400).json({ error: 'You can refine today\'s schedule only 2 times.' });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
