import express from 'express';
import { authenticate } from '../middleware/auth.js';
import Mission from '../models/Mission.js';
import { schedulerService } from '../services/schedulerService.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const missions = await Mission.find({ userId: req.user._id }).sort({ priority: 1, endDate: 1 });
    const missionsWithStats = missions.map(m => {
      const missionObj = m.toObject();
      return {
        ...missionObj,
        ...schedulerService.getMissionStats(m)
      };
    });
    res.json(missionsWithStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, targetType, totalTarget, startDate, endDate } = req.body;
    
    if (!name || !totalTarget || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const now = new Date();

    if (end <= start) return res.status(400).json({ error: 'End date must be after start date' });
    if (end < now) return res.status(400).json({ error: 'End date must be in the future' });

    const activeCount = await Mission.countDocuments({ userId: req.user._id, status: 'active' });

    const mission = new Mission({
      userId: req.user._id,
      name,
      targetType: targetType || 'hours',
      totalTarget,
      completedValue: 0,
      startDate: start,
      endDate: end,
      priority: activeCount + 1
    });

    await mission.save();
    res.status(201).json(mission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/progress', async (req, res) => {
  try {
    const { value, type } = req.body;
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    const inputValue = Number(value);
    if (!inputValue || inputValue <= 0) {
      return res.status(400).json({ error: 'Invalid progress value' });
    }

    const completedValue = type === 'hours' ? inputValue : inputValue;
    mission.completedValue += completedValue;

    if (mission.completedValue >= mission.totalTarget) {
      mission.status = 'completed';
      mission.completedAt = new Date();
    }

    await mission.save();
    res.json({
      ...mission.toObject(),
      ...schedulerService.getMissionStats(mission)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/pause', async (req, res) => {
  try {
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    mission.status = 'paused';
    await mission.save();
    res.json(mission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/resume', async (req, res) => {
  try {
    const mission = await Mission.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    mission.status = 'active';
    await mission.save();
    res.json(mission);
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

router.post('/generate-plan', async (req, res) => {
  try {
    const { availableHours } = req.body;
    
    if (!availableHours || availableHours <= 0) {
      return res.status(400).json({ error: 'Invalid available hours' });
    }

    const plan = await schedulerService.generateDailyPlan(req.user._id, availableHours);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;