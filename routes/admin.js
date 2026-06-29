import express from 'express';
import { requireAdmin, authenticate } from '../middleware/auth.js';
import MockTest from '../models/MockTest.js';
import TestSeries from '../models/TestSeries.js';
import Question from '../models/Question.js';
import TestAttempt from '../models/TestAttempt.js';
import User from '../models/User.js';
import UserSubscription from '../models/UserSubscription.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import UserCourseEnrollment from '../models/UserCourseEnrollment.js';
import EditorialItem from '../models/EditorialItem.js';
import { editorialRepeatAnalyzerService } from '../services/editorialRepeatAnalyzerService.js';
import { scrapeSource } from '../services/harvesterService.js';

const router = express.Router();

router.use(requireAdmin);

import os from 'os';

const VALID_SOURCES = ['vajiram', 'pw', 'legacyias', 'greaterkashmir'];

const toRunDateKey = (d) => {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);

    const [
      totalTests,
      testsThisMonth,
      testsLastMonth,
      totalSeries,
      seriesThisMonth,
      totalQuestions,
      totalUsers,
      usersToday,
      totalEnrollments,
      enrollmentsToday,
      testsByMode,
      testsBySubject
    ] = await Promise.all([
      MockTest.countDocuments({ userId: { $in: adminUserIds } }),
      MockTest.countDocuments({ userId: { $in: adminUserIds }, createdAt: { $gte: firstDayThisMonth } }),
      MockTest.countDocuments({ userId: { $in: adminUserIds }, createdAt: { $gte: firstDayLastMonth, $lt: firstDayThisMonth } }),
      TestSeries.countDocuments({ userId: { $in: adminUserIds } }),
      TestSeries.countDocuments({ userId: { $in: adminUserIds }, createdAt: { $gte: firstDayThisMonth } }),
      Question.countDocuments(),
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      UserCourseEnrollment.countDocuments({ status: 'completed' }),
      UserCourseEnrollment.countDocuments({ status: 'completed', createdAt: { $gte: startOfToday } }),
      MockTest.aggregate([
        { $match: { userId: { $in: adminUserIds } } },
        { $group: { _id: '$mode', count: { $sum: 1 } } }
      ]),
      MockTest.aggregate([
        { $match: { userId: { $in: adminUserIds } } },
        { $group: { _id: '$subject', count: { $sum: 1 } } }
      ])
    ]);

    // Calculate trends
    const testTrend = testsLastMonth === 0 ? 100 : Math.round(((testsThisMonth - testsLastMonth) / testsLastMonth) * 100);
    
    // System Metrics
    const cpuLoad = Math.round(os.loadavg()[0] * 10); // Simplified
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);

    res.json({
      totalTests,
      testTrend: testTrend >= 0 ? `+${testTrend}% this month` : `${testTrend}% this month`,
      totalSeries,
      seriesTrend: `+${seriesThisMonth} new this month`,
      totalQuestions,
      totalUsers,
      usersToday: `+${usersToday} today`,
      totalEnrollments,
      enrollmentsTrend: `+${enrollmentsToday} today`,
      testsByMode: testsByMode.reduce((acc, m) => ({ ...acc, [m._id]: m.count }), {}),
      testsBySubject: testsBySubject.reduce((acc, m) => ({ ...acc, [m._id]: m.count }), {}),
      system: {
        cpu: `${cpuLoad}%`,
        memory: `${memUsage}%`,
        latency: `${Math.floor(Math.random() * 20) + 20}ms`, // Simulating real-time latency
        memRaw: `${Math.round((totalMem - freeMem) / (1024 * 1024 * 1024) * 10) / 10}GB`
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== QUESTIONS ====================

router.get('/questions', async (req, res) => {
  try {
    const { page = 1, limit = 20, subject, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const filter = {};
    
    if (subject) filter.subject = subject;
    if (search) {
      filter.$or = [
        { text: { $regex: search, $options: 'i' } },
        { explanation: { $regex: search, $options: 'i' } }
      ];
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const questions = await Question.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Question.countDocuments(filter);

    res.json({
      questions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/questions', async (req, res) => {
  try {
    const { questionNumber, text, options, correctAnswer, explanation, subject, year, topics } = req.body;
    
    const question = new Question({
      questionNumber,
      text,
      options,
      correctAnswer: correctAnswer.toUpperCase(),
      explanation,
      subject,
      year,
      topics: topics || []
    });

    await question.save();
    res.status(201).json(question);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/questions/bulk', async (req, res) => {
  try {
    const { questions } = req.body;
    
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    const validQuestions = questions.map(q => ({
      questionNumber: q.questionNumber,
      text: q.text,
      options: {
        a: q.options.a || 'Option A',
        b: q.options.b || 'Option B',
        c: q.options.c || 'Option C',
        d: q.options.d || 'Option D'
      },
      correctAnswer: String(q.correctAnswer).toUpperCase(),
      explanation: q.explanation || '',
      subject: q.subject || 'General Studies',
      year: q.year || new Date().getFullYear(),
      topics: q.topics || []
    }));

    const result = await Question.insertMany(validQuestions, { ordered: false });
    res.status(201).json({ inserted: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/questions/:id', async (req, res) => {
  try {
    const { questionNumber, text, options, correctAnswer, explanation, subject, year, topics, isActive } = req.body;
    
    const question = await Question.findByIdAndUpdate(
      req.params.id,
      {
        ...(questionNumber && { questionNumber }),
        ...(text && { text }),
        ...(options && { options }),
        ...(correctAnswer && { correctAnswer: correctAnswer.toUpperCase() }),
        ...(explanation !== undefined && { explanation }),
        ...(subject && { subject }),
        ...(year && { year }),
        ...(topics && { topics }),
        ...(isActive !== undefined && { isActive })
      },
      { new: true }
    );

    if (!question) return res.status(404).json({ error: 'Question not found' });
    res.json(question);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/questions/:id', async (req, res) => {
  try {
    const question = await Question.findByIdAndDelete(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    res.json({ message: 'Question deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Mock Test from selected questions
router.post('/create-test-from-questions', async (req, res) => {
  try {
    const { name, subject, testType, year, questionIds, testSeriesId, durationMinutes, markCorrect, markWrong } = req.body;
    
    if (!questionIds || questionIds.length === 0) {
      return res.status(400).json({ error: 'Please select at least one question' });
    }

    const questions = await Question.find({ _id: { $in: questionIds } });
    if (questions.length === 0) {
      return res.status(400).json({ error: 'No valid questions found' });
    }

    // Create structured mock test with linked questions
    const mockTest = new MockTest({
      userId: req.user._id,
      testSeriesId: testSeriesId || null,
      name: name || `Test - ${subject} - ${new Date().toLocaleDateString()}`,
      testType: testType || 'sectional',
      subject: subject,
      year: year || new Date().getFullYear(),
      topics: [],
      totalQuestions: questions.length,
      durationMinutes: durationMinutes || 60,
      markCorrect: markCorrect || 2.0,
      markWrong: markWrong || -0.66,
      testPdfPath: 'NOT_APPLICABLE',
      mode: 'structured',
      status: 'ready',
      structuredQuestions: questionIds,
      questions: questions.map(q => ({
        questionNumber: q.questionNumber,
        text: q.text,
        subject: q.subject,
        topic: q.topics?.[0] || null,
        correctAnswer: q.correctAnswer,
        status: 'active'
      }))
    });

    await mockTest.save();

    // Build answer key from questions - store as plain object
    const answerKeyObject = {};
    questions.forEach((q, index) => {
      answerKeyObject[String(index + 1)] = String(q.correctAnswer).toUpperCase();
    });
    mockTest.answerKey = answerKeyObject;
    mockTest.answerKeyCount = Object.keys(answerKeyObject).length;
    await mockTest.save();

    res.status(201).json({ 
      test: mockTest, 
      questionsCount: questions.length,
      message: `Test created with ${questions.length} questions`
    });
  } catch (err) {
    console.error('Create test from questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEST SERIES ====================

router.get('/series', async (req, res) => {
  try {
    const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc', search } = req.query;
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);

    const filter = { userId: { $in: adminUserIds } };
    
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    // Build sort object
    const sort = {};
    const sortField = sortBy || 'createdAt';
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    sort[sortField] = sortDirection;

    const series = await TestSeries.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await TestSeries.countDocuments(filter);

    res.json({
      series,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/series', async (req, res) => {
  try {
    const { name, provider, type, totalTests } = req.body;
    
    const series = new TestSeries({
      userId: req.user._id,
      name,
      provider,
      type,
      totalTests
    });

    await series.save();
    res.status(201).json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/series/:id', async (req, res) => {
  try {
    const { name, provider, type, totalTests, isActive } = req.body;
    
    const series = await TestSeries.findByIdAndUpdate(
      req.params.id,
      {
        ...(name && { name }),
        ...(provider !== undefined && { provider }),
        ...(type && { type }),
        ...(totalTests !== undefined && { totalTests }),
        ...(isActive !== undefined && { isActive })
      },
      { new: true }
    );

    if (!series) return res.status(404).json({ error: 'Series not found' });
    res.json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/series/:id', async (req, res) => {
  try {
    const series = await TestSeries.findByIdAndDelete(req.params.id);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    
    await MockTest.deleteMany({ testSeriesId: req.params.id });
    await TestAttempt.deleteMany({ testSeriesId: req.params.id });
    
    res.json({ message: 'Series and related tests deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== MOCK TESTS ====================

router.get('/tests', async (req, res) => {
  try {
    const { page = 1, limit = 20, subject, testType, mode, status } = req.query;
    const filter = {};
    
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);
    filter.userId = { $in: adminUserIds };

    if (subject) filter.subject = subject;
    if (testType) filter.testType = testType;
    if (mode) filter.mode = mode;
    if (status) filter.status = status;

    const tests = await MockTest.find(filter)
      .populate('testSeriesId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await MockTest.countDocuments(filter);

    res.json({
      tests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/tests/:id', async (req, res) => {
  try {
    const { 
      name, testType, subject, year, topics, totalQuestions, 
      durationMinutes, markCorrect, markWrong, status, isActive 
    } = req.body;
    
    const test = await MockTest.findByIdAndUpdate(
      req.params.id,
      {
        ...(name && { name }),
        ...(testType && { testType }),
        ...(subject && { subject }),
        ...(year && { year }),
        ...(topics && { topics }),
        ...(totalQuestions && { totalQuestions }),
        ...(durationMinutes && { durationMinutes }),
        ...(markCorrect && { markCorrect }),
        ...(markWrong && { markWrong }),
        ...(status && { status }),
        ...(isActive !== undefined && { isActive })
      },
      { new: true }
    );

    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/tests/:id/answer-key', async (req, res) => {
  try {
    const { answerKey } = req.body;
    // Store as plain object for consistency
    const answerKeyObject = {};
    Object.entries(answerKey).forEach(([k, v]) => {
      answerKeyObject[String(k)] = String(v).toUpperCase();
    });

    const test = await MockTest.findByIdAndUpdate(
      req.params.id,
      {
        answerKey: answerKeyObject,
        answerKeyCount: Object.keys(answerKeyObject).length,
        status: 'ready'
      },
      { new: true }
    );

    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== USERS ====================

router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const filter = {};
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await User.countDocuments(filter);

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select('-password');

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SUBJECTS ====================

router.get('/subjects', async (req, res) => {
  try {
    const subjects = await Question.distinct('subject');
    res.json(subjects.filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SUBSCRIPTIONS ====================

router.get('/subscription/plans', async (req, res) => {
  try {
    const plans = await SubscriptionPlan.find().sort({ price: 1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subscription/plans', async (req, res) => {
  try {
    const { name, duration, durationUnit, price, isActive } = req.body;
    
    if (!name || !duration || !durationUnit || !price) {
      return res.status(400).json({ error: 'All fields required' });
    }
    
    const plan = new SubscriptionPlan({
      name,
      duration,
      durationUnit,
      price,
      isActive: isActive !== false
    });
    
    await plan.save();
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/subscription/plans/:id', async (req, res) => {
  try {
    const { name, duration, durationUnit, price, isActive } = req.body;
    
    const plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { name, duration, durationUnit, price, isActive },
      { new: true }
    );
    
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/subscription/plans/:id', async (req, res) => {
  try {
    const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/subscriptions', async (req, res) => {
  try {
    const { page = 1, limit = 15, status, search } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { 'userId.name': { $regex: search, $options: 'i' } },
        { 'userId.email': { $regex: search, $options: 'i' } }
      ];
    }
    
    const subscriptions = await UserSubscription.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await UserSubscription.countDocuments(filter);
    
    // Get subscription stats
    const [activeCount, expiredCount] = await Promise.all([
      UserSubscription.countDocuments({ status: 'active' }),
      UserSubscription.countDocuments({ status: 'expired' })
    ]);
    
    res.json({
      subscriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      },
      stats: {
        active: activeCount,
        expired: expiredCount,
        total
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/subscriptions/:id', async (req, res) => {
  try {
    const { status, endDate } = req.body;
    
    const update = {};
    if (status) update.status = status;
    if (endDate) update.endDate = new Date(endDate);
    
    const subscription = await UserSubscription.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    ).populate('userId', 'name email');
    
    if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
    
    // Update user's subscription status in User model
    const user = await User.findById(subscription.userId._id);
    if (user) {
      user.subscription = {
        status: subscription.status,
        planName: subscription.planName,
        planId: subscription.planId,
        endDate: subscription.endDate
      };
      await user.save();
    }
    
    res.json(subscription);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subscriptions/:userId/activate', async (req, res) => {
  try {
    const { planId, durationDays } = req.body;
    
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    let plan = null;
    if (planId) {
      plan = await SubscriptionPlan.findById(planId);
    }
    
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + (durationDays || 30));
    
    const subscription = new UserSubscription({
      userId: user._id,
      planId: plan?._id,
      planName: plan?.name || 'Custom',
      status: 'active',
      startDate: new Date(),
      endDate,
      paymentId: 'admin-activated',
      amount: plan?.price || 0
    });
    
    await subscription.save();
    
    user.subscription = {
      status: 'active',
      planName: subscription.planName,
      planId: subscription.planId,
      endDate: subscription.endDate
    };
    await user.save();
    
    res.json(subscription);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/subscription/stats', async (req, res) => {
  try {
    const totalSubscriptions = await UserSubscription.countDocuments();
    const activeSubscriptions = await UserSubscription.countDocuments({ status: 'active' });
    const expiredSubscriptions = await UserSubscription.countDocuments({ status: 'expired' });
    
    const totalRevenue = await UserSubscription.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    res.json({
      total: totalSubscriptions,
      active: activeSubscriptions,
      expired: expiredSubscriptions,
      revenue: totalRevenue[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ARTICLES (Scraper Integration) ====================

async function scrapeAndSave(source, mode, userId) {
  const result = await scrapeSource(source, mode);

  if (!result.success) {
    return { success: false, error: result.error, code: result.code || 'SCRAPER_ERROR' };
  }

  const articles = result.articles;
  const runDateKey = result.stats?.harvest_date || new Date().toISOString().slice(0, 10);

  if (!articles || articles.length === 0) {
    return { success: true, savedCount: 0, runDateKey, analysis: null };
  }

  await EditorialItem.deleteMany({ userId, sourceKey: source, runDateKey });

  let savedCount = 0;
  for (const a of articles) {
    const title = (a?.title || '').toString().trim();
    const description = (a?.description || '').toString().trim();
    const link = (a?.url || '').toString().trim();
    const keyPointersContent = (a?.html || a?.content || '').toString().trim();
    const publishedAt = toRunDateKey(a?.published_at || runDateKey);

    if (!title || !link) continue;

    await EditorialItem.create({
      userId,
      runDateKey,
      sourcesKey: source,
      sourceKey: source,
      title,
      description: description || a?.plain_text?.slice(0, 500) || '',
      link,
      keyPointersContent,
      publishedAt: publishedAt ? new Date(publishedAt) : null,
      fingerprint: `${title}|${link}`.slice(0, 250),
    });
    savedCount++;
  }

  const now = new Date();
  const allItems = await EditorialItem.find({
    userId,
    runDateKey: { $gte: new Date(new Date(now).setMonth(now.getMonth() - 6)).toISOString().slice(0, 10) },
  }).lean();

  const analysis = await editorialRepeatAnalyzerService.generateAllWindows({
    userId,
    generatedForDateKey: runDateKey,
    items: allItems,
  });

  return { success: true, savedCount, runDateKey, analysis };
}

router.post('/articles/load-today/:source', async (req, res) => {
  try {
    const { source } = req.params;
    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: `Invalid source '${source}'. Valid: ${VALID_SOURCES.join(', ')}` });
    }

    const result = await scrapeAndSave(source, 'today', req.user._id);

    if (!result.success) {
      return res.status(503).json({ error: result.error, code: result.code });
    }

    res.json({ success: true, source, mode: 'today', savedCount: result.savedCount, runDateKey: result.runDateKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/articles/load-yesterday/:source', async (req, res) => {
  try {
    const { source } = req.params;
    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: `Invalid source '${source}'. Valid: ${VALID_SOURCES.join(', ')}` });
    }

    const result = await scrapeAndSave(source, 'yesterday', req.user._id);

    if (!result.success) {
      return res.status(503).json({ error: result.error, code: result.code });
    }

    res.json({ success: true, source, mode: 'yesterday', savedCount: result.savedCount, runDateKey: result.runDateKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
