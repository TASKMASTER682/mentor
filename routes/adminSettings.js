import express from 'express';
import { SystemSettings } from '../models/SystemSettings.js';
import { Announcement } from '../models/Announcement.js';
import { Course } from '../models/Course.js';
import UserCourseEnrollment from '../models/UserCourseEnrollment.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Get current system settings
router.get('/config', authenticate, async (req, res) => {
  try {
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = await SystemSettings.create({ 
        paymentMethod: 'manual',
        telegramHandle: '@admin',
        telegramLink: 'https://t.me/admin'
      });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update system settings (Admin Only)
router.put('/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await SystemSettings.findOneAndUpdate(
      {},
      { ...req.body, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manage Announcements
router.get('/announcements', async (req, res) => {
  try {
    const announcements = await Announcement.find({ isActive: true }).sort({ createdAt: -1 });
    res.json(announcements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/announcements', authenticate, requireAdmin, async (req, res) => {
  try {
    const announcement = await Announcement.create(req.body);
    res.json(announcement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/announcements/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual Enrollment (Admin Only)
router.post('/manual-enroll', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, courseId, amount } = req.body;
    
    // Check if already enrolled
    const existing = await UserCourseEnrollment.findOne({ userId, courseId });
    if (existing) return res.status(400).json({ error: 'User already enrolled' });

    const enrollment = await UserCourseEnrollment.create({
      userId,
      courseId,
      pricePaid: amount,
      status: 'completed',
      paymentId: 'MANUAL_ADMIN_' + Date.now()
    });

    res.json(enrollment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
