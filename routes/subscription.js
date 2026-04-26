import express from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import User from '../models/User.js';
import UserSubscription from '../models/UserSubscription.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import UserSession from '../models/UserSession.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

router.get('/plans', async (req, res) => {
  try {
    const plans = await SubscriptionPlan.find({ isActive: true }).sort({ price: 1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', authenticate, async (req, res) => {
  try {
    const subscription = await UserSubscription.findOne({ 
      userId: req.user._id,
      status: 'active'
    }).sort({ createdAt: -1 });

    const isSubscribed = req.user.isSubscribed();
    
    res.json({
      hasSubscription: isSubscribed,
      status: req.user.subscription?.status || 'none',
      planName: subscription?.planName || req.user.subscription?.planName || '',
      endDate: subscription?.endDate || req.user.subscription?.endDate || null,
      daysRemaining: subscription?.daysRemaining || 0,
      subscription: subscription || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/purchase', authenticate, async (req, res) => {
  try {
    const { planId, paymentId } = req.body;
    
    const plan = await SubscriptionPlan.findById(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    
    let durationMs;
    switch (plan.durationUnit) {
      case 'days':
        durationMs = plan.duration * 24 * 60 * 60 * 1000;
        break;
      case 'years':
        durationMs = plan.duration * 365 * 24 * 60 * 60 * 1000;
        break;
      default:
        durationMs = plan.duration * 30 * 24 * 60 * 60 * 1000;
    }
    
    const endDate = new Date(Date.now() + durationMs);
    
    const existing = await UserSubscription.findOne({ 
      userId: req.user._id,
      status: 'active'
    });
    
    if (existing) {
      const newEndDate = new Date(existing.endDate.getTime() + durationMs);
      existing.planId = plan._id;
      existing.planName = plan.name;
      existing.endDate = newEndDate;
      existing.amount = plan.price;
      existing.paymentId = paymentId;
      existing.updatedAt = new Date();
      await existing.save();
    } else {
      const subscription = new UserSubscription({
        userId: req.user._id,
        planId: plan._id,
        planName: plan.name,
        status: 'active',
        startDate: new Date(),
        endDate: endDate,
        amount: plan.price,
        paymentId: paymentId
      });
      await subscription.save();
    }
    
    req.user.subscription = {
      hasSubscription: true,
      planName: plan.name,
      status: 'active',
      endDate: endDate
    };
    await req.user.save();
    
    res.json({
      success: true,
      message: 'Subscription activated successfully',
      subscription: {
        planName: plan.name,
        endDate: endDate,
        status: 'active'
      }
    });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancel', authenticate, async (req, res) => {
  try {
    const subscription = await UserSubscription.findOneAndUpdate(
      { userId: req.user._id, status: 'active' },
      { status: 'cancelled', autoRenew: false },
      { new: true }
    );
    
    if (subscription) {
      req.user.subscription.status = 'expired';
      await req.user.save();
    }
    
    res.json({ success: true, message: 'Subscription cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', authenticate, async (req, res) => {
  try {
    const subscriptions = await UserSubscription.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json(subscriptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/verify', authenticate, async (req, res) => {
  try {
    const isSubscribed = req.user.isSubscribed();
    res.json({ 
      isSubscribed,
      userId: req.user._id,
      email: req.user.email,
      user: { role: req.user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const userAgent = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    await UserSession.deleteMany({ userId: req.user._id });
    
    const session = new UserSession({
      userId: req.user._id,
      token: token,
      deviceInfo: {
        userAgent: userAgent,
        platform: userAgent.includes('Mobile') ? 'Mobile' : 'Desktop'
      },
      ipAddress: ip,
      lastActive: new Date()
    });
    await session.save();
    
    res.json({ success: true, sessionId: session._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/active', authenticate, async (req, res) => {
  try {
    const sessions = await UserSession.find({ userId: req.user._id })
      .sort({ lastActive: -1 });
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sessions/:sessionId', authenticate, async (req, res) => {
  try {
    await UserSession.findOneAndDelete({ 
      _id: req.params.sessionId, 
      userId: req.user._id 
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sessions', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    await UserSession.deleteMany({ 
      userId: req.user._id,
      token: { $ne: token }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/seed-plans', requireAdmin, async (req, res) => {
  try {
    const plans = [
      {
        name: 'Monthly',
        description: 'Access all courses for 1 month',
        price: 999,
        duration: 1,
        durationUnit: 'months',
        features: [
          'Access to all premium courses',
          'HD video streaming',
          'Progress tracking',
          'Email support'
        ],
        isActive: true
      },
      {
        name: 'Quarterly',
        description: 'Access all courses for 3 months',
        price: 2499,
        duration: 3,
        durationUnit: 'months',
        features: [
          'Access to all premium courses',
          'HD video streaming',
          'Progress tracking',
          'Priority email support',
          'Save 17% vs monthly'
        ],
        isActive: true
      },
      {
        name: 'Yearly',
        description: 'Access all courses for 12 months',
        price: 7999,
        duration: 12,
        durationUnit: 'months',
        features: [
          'Access to all premium courses',
          'HD video streaming',
          'Progress tracking',
          'Priority support',
          'Download resources',
          'Save 33% vs monthly'
        ],
        isActive: true
      }
    ];
    
    await SubscriptionPlan.deleteMany({});
    const created = await SubscriptionPlan.insertMany(plans);
    res.json({ success: true, plans: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await UserSubscription.find()
      .populate('userId', 'name email')
      .populate('planId')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(subscriptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const { action, planId, duration } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (action === 'activate') {
      const plan = planId ? await SubscriptionPlan.findById(planId) : null;
      const planName = plan?.name || 'Admin Granted';
      const endDate = duration ? new Date(Date.now() + duration * 24 * 60 * 60 * 1000) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      
      user.subscription = {
        hasSubscription: true,
        planName: planName,
        status: 'active',
        endDate: endDate
      };
      await user.save();
      
      const sub = new UserSubscription({
        userId: user._id,
        planId: plan?._id,
        planName: planName,
        status: 'active',
        startDate: new Date(),
        endDate: endDate,
        amount: plan?.price || 0
      });
      await sub.save();
      
      res.json({ success: true, message: 'Subscription activated for user' });
    } else if (action === 'deactivate') {
      user.subscription = {
        hasSubscription: false,
        planName: '',
        status: 'none',
        endDate: null
      };
      await user.save();
      await UserSubscription.updateMany(
        { userId: user._id, status: 'active' },
        { status: 'cancelled' }
      );
      res.json({ success: true, message: 'Subscription deactivated for user' });
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;