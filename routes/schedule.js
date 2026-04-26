import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { schedulerService } from '../services/schedulerService.js';

const router = express.Router();
router.use(authenticate);

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

router.get('/plan', async (req, res) => {
  try {
    const { hours } = req.query;
    const availableHours = Number(hours) || 4;
    
    const plan = await schedulerService.generateDailyPlan(req.user._id, availableHours);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
