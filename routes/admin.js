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
import EditorialRepeatAnalysis from '../models/EditorialRepeatAnalysis.js';
import { editorialRepeatAnalyzerService } from '../services/editorialRepeatAnalyzerService.js';
import { scrapeSource } from '../services/harvesterService.js';
import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';

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

router.post('/auto-generate-test', async (req, res) => {
  try {
    const { totalQuestions, subjectDistribution, dateFrom, dateTo, name, testType, year, durationMinutes, markCorrect, markWrong, testSeriesId, subject } = req.body;
    const total = parseInt(totalQuestions);
    if (!total || total < 1) return res.status(400).json({ error: 'Invalid question count' });

    // Build base filter
    const filter = {};
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    // For each subject with a percentage, compute target count and fetch random questions
    const selectedQuestionIds = [];
    const subjects = Object.keys(subjectDistribution || {});
    const subjectAllQuestions = {};

    // Fetch pool per subject (date-filtered)
    for (const sub of subjects) {
      const pct = parseFloat(subjectDistribution[sub]) || 0;
      if (pct <= 0) continue;
      const subFilter = { ...filter, subject: sub };
      const pool = await Question.find(subFilter).select('_id').lean();
      if (pool.length > 0) subjectAllQuestions[sub] = pool;
    }

    // If no subject distribution, use all questions matching the date filter
    if (Object.keys(subjectAllQuestions).length === 0) {
      const pool = await Question.find(filter).select('_id').lean();
      if (pool.length === 0) return res.status(400).json({ error: 'No questions found matching criteria' });
      // Shuffle and pick
      const shuffled = pool.sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, Math.min(total, shuffled.length));
      selectedQuestionIds.push(...picked.map(q => q._id.toString()));
    } else {
      // Calculate count per subject based on percentages
      const totalPct = subjects.reduce((sum, s) => sum + (parseFloat(subjectDistribution[s]) || 0), 0);
      let remaining = total;
      for (const sub of subjects) {
        const pct = parseFloat(subjectDistribution[sub]) || 0;
        if (pct <= 0) continue;
        let count = Math.round((pct / totalPct) * total);
        count = Math.min(count, subjectAllQuestions[sub]?.length || 0);
        const shuffled = (subjectAllQuestions[sub] || []).sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, count).map(q => q._id.toString());
        selectedQuestionIds.push(...picked);
        remaining -= picked.length;
      }
      // Distribute remaining questions among subjects that still have pool left
      if (remaining > 0) {
        for (const sub of subjects) {
          if (remaining <= 0) break;
          const unused = (subjectAllQuestions[sub] || []).filter(q => !selectedQuestionIds.includes(q._id.toString()));
          const add = Math.min(remaining, unused.length);
          selectedQuestionIds.push(...unused.slice(0, add).map(q => q._id.toString()));
          remaining -= add;
        }
      }
    }

    if (selectedQuestionIds.length === 0) {
      return res.status(400).json({ error: 'No questions could be selected' });
    }

    // Fetch full question docs
    const questions = await Question.find({ _id: { $in: selectedQuestionIds } });

    const mockTest = new MockTest({
      userId: req.user._id,
      testSeriesId: testSeriesId || null,
      name: name || `Auto Test - ${new Date().toLocaleDateString()}`,
      testType: testType || 'sectional',
      subject: subject || 'General Studies',
      year: year || new Date().getFullYear(),
      topics: [],
      totalQuestions: questions.length,
      durationMinutes: durationMinutes || 60,
      markCorrect: markCorrect || 2.0,
      markWrong: markWrong || -0.66,
      testPdfPath: 'NOT_APPLICABLE',
      mode: 'structured',
      status: 'ready',
      structuredQuestions: questions.map(q => q._id),
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
      message: `Auto-generated test with ${questions.length} questions`
    });
  } catch (err) {
    console.error('Auto-generate test error:', err);
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
  try {
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
        description: description || (typeof a?.plain_text === 'string' ? a.plain_text.slice(0, 500) : '') || '',
        link,
        keyPointersContent,
        publishedAt: publishedAt ? new Date(publishedAt) : null,
        fingerprint: `${title}|${link}`.slice(0, 250),
      });
      savedCount++;
    }

    return { success: true, savedCount, runDateKey };
  } catch (err) {
    console.error(`[scrapeAndSave] ${mode} error for ${source}:`, err?.stack || err?.message || err);
    return { success: false, error: err?.message || String(err), code: 'SCRAPE_SAVE_ERROR' };
  }
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

router.post('/articles/run-analysis', async (req, res) => {
  try {
    const now = new Date();
    const allItems = await EditorialItem.find({
      userId: req.user._id,
      runDateKey: { $gte: new Date(new Date(now).setMonth(now.getMonth() - 6)).toISOString().slice(0, 10) },
    }).lean();

    if (!allItems.length) {
      return res.json({ success: true, message: 'No articles to analyze' });
    }

    const latestKey = allItems.reduce((max, it) => it.runDateKey > max ? it.runDateKey : max, '');
    const analysis = await editorialRepeatAnalyzerService.generateAllWindows({
      userId: req.user._id,
      generatedForDateKey: latestKey,
      items: allItems,
    });

    const total = Object.values(analysis).reduce((sum, a) => sum + (a?.results?.length || 0), 0);
    res.json({ success: true, topicsFound: total, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Extract h2/h3 headings from HTML */
function extractH2H3(html) {
  if (!html) return '';
  try {
    const $ = cheerio.load(html);
    return $('h2, h3').map((_, el) => $(el).text().trim()).get().join(' | ');
  } catch { return ''; }
}

/* Get non-overlapping date windows */
function getWindows(anchorDate) {
  const d = (offset) => { const x = new Date(anchorDate); x.setDate(x.getDate() + offset); return x; };
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  return {
    '7d':   { start: fmt(d(-6)),   end: fmt(d(0)) },
    '1m':   { start: fmt(d(-30)),  end: fmt(d(-7))  },
    '6m':   { start: fmt(d(-180)), end: fmt(d(-31)) },
    'gt6m': { start: '2000-01-01', end: fmt(d(-181)) },
  };
}

// POST /api/admin/articles/export-analysis — download Excel + prompt
router.post('/articles/export-analysis', async (req, res) => {
  try {
    const now = new Date();
    const allItems = await EditorialItem.find({
      userId: req.user._id,
      runDateKey: { $gte: '2000-01-01' },
    }).sort({ runDateKey: -1, createdAt: -1 }).lean();

    if (!allItems.length) return res.status(400).json({ error: 'No articles found' });

    const requestedWindows = req.body.windows || ['7d', '1m', '6m', 'gt6m'];
    const windows = getWindows(now);
    const workbook = new ExcelJS.Workbook();
    const CATEGORIES = [
      'Agriculture & Rural', 'Banking & Finance', 'Constitutional Developments',
      'Culture & Heritage', 'Defense & Security', 'Disaster Management',
      'Economy & Finance', 'Education & Health', 'Elections & Political',
      'Energy & Resources', 'Environment & Climate', 'Federalism & States',
      'Governance', 'Industry & Trade', 'International Relations',
      'Jammu & Kashmir', 'Judiciary & Legal', 'Science & Tech',
      'Social Issues', 'Transportation', 'Urban Infrastructure', 'Water Resources',
    ];

    const colDefs = [
      { header: '_id', key: '_id', width: 28 },
      { header: 'runDateKey', key: 'runDateKey', width: 14 },
      { header: 'title', key: 'title', width: 50 },
      { header: 'headings (h2/h3)', key: 'headings', width: 70 },
    ];

    for (const wt of requestedWindows) {
      const range = windows[wt];
      if (!range) continue;
      const ws = workbook.addWorksheet(wt);
      ws.columns = colDefs;
      ws.getRow(1).font = { bold: true };

      const filtered = allItems.filter(it => it.runDateKey >= range.start && it.runDateKey <= range.end);
      for (const it of filtered) {
        ws.addRow({
          _id: it._id?.toString() || '',
          runDateKey: it.runDateKey || '',
          title: it.title || '',
          headings: extractH2H3(it.keyPointersContent),
        });
      }
    }

    /* Prompt sheet */
    const promptSheet = workbook.addWorksheet('Prompt');
    const promptLines = [
      '=== UPSC EDITORIAL ANALYSIS — INSTRUCTIONS ===',
      '',
      `Today's date: ${now.toISOString().slice(0, 10)}`,
      '',
      'You are a UPSC topic classifier. For each article below (identified by _id), read its title and h2/h3 headings, then assign:',
      '',
      '1. category — ONE broad UPSC topic from this list:',
      ...CATEGORIES.map(c => `   - ${c}`),
      '',
      '2. topicLabel — concise 2-5 word sub-topic (e.g., "Smart Cities Mission", "NDRF Modernization")',
      '',
      '3. rationale — 1-sentence explanation of why this topic repeats in UPSC editorial coverage',
      '',
      'Return ONLY a JSON array:',
      '[',
      '  {"_id": "...", "category": "Urban Infrastructure", "topicLabel": "Smart Cities Mission", "rationale": "..."},',
      '  {"_id": "...", "category": "Disaster Management", "topicLabel": "NDRF Modernization", "rationale": "..."}',
      ']',
      '',
      'IMPORTANT: Group semantically similar articles together under the same topic.',
      '',
      '1. category — ONE broad UPSC topic (you can invent any meaningful category)',
      '',
      '2. topicLabel — concise 3-8 word topic name (e.g., "Digital Public Infrastructure and E-Governance")',
      '',
      '3. subTopics — array of 2-5 word sub-topic strings covered in these articles',
      '',
      '4. frequency — number of articles in this group',
      '',
      '5. rationale — 1-sentence trend insight',
      '',
      'Return ONLY a JSON array where each entry groups related articles by _id:',
      '[',
      '  {',
      '    "_id": ["id1", "id2", "id3"],',
      '    "category": "Governance & Economy",',
      '    "topicLabel": "Digital Public Infrastructure",',
      '    "subTopics": ["Ayushman Bharat", "SHE-LEAPS"],',
      '    "frequency": 3,',
      '    "rationale": "..."',
      '  }',
      ']',
      '',
      'IMPORTANT:',
      '- Group related articles under one _id array — do NOT repeat the same topic',
      '- Use exact _id strings from the sheets above',
      '- Include ALL articles — no article should be left out',
      '- Return this JSON via the import endpoint on the admin panel',
    ];
    promptSheet.columns = [{ header: 'Instructions', key: 'text', width: 120 }];
    for (const line of promptLines) {
      promptSheet.addRow({ text: line });
    }

    /* Write to buffer */
    const buf = await workbook.xlsx.writeBuffer();

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="upsc-analysis-export-${now.toISOString().slice(0, 10)}.xlsx"`,
    });
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// POST /api/admin/articles/import-analysis — accept external AI JSON (grouped format)
router.post('/articles/import-analysis', async (req, res) => {
  try {
    const { results, windowType } = req.body;
    if (!Array.isArray(results) || !results.length) {
      return res.status(400).json({ error: 'results array required' });
    }
    const validWindows = ['7d', '1m', '6m', 'gt6m'];
    const wt = validWindows.includes(windowType) ? windowType : '7d';

    const userId = req.user._id;
    const now = new Date();
    const latestKey = now.toISOString().slice(0, 10);

    /* Fetch all articles to map _id -> article */
    const allItems = await EditorialItem.find({
      userId,
      runDateKey: { $gte: new Date(new Date(now).setMonth(now.getMonth() - 6)).toISOString().slice(0, 10) },
    }).lean();
    const idToArticle = {};
    for (const it of allItems) idToArticle[it._id?.toString()] = it;

    /* Build topics from grouped external AI format */
    const topics = [];
    const allArticleIds = new Set();

    for (const entry of results) {
      const ids = Array.isArray(entry._id) ? entry._id : [entry._id];
      const articles = ids.map(id => idToArticle[id]).filter(Boolean);
      if (!articles.length) continue;

      ids.forEach(id => allArticleIds.add(id));

      topics.push({
        topicLabel: entry.topicLabel || entry.category || 'UPSC Topic',
        category: entry.category || 'General Studies',
        subTopics: entry.subTopics || [],
        repeatCount: entry.frequency || articles.length,
        rationale: entry.rationale || `Group of ${articles.length} articles on ${entry.topicLabel || entry.category}`,
        comprehensiveLinks: articles.slice(0, 10).map(a => ({
          _id: a._id,
          title: a.title,
          link: a.link,
          sourceKey: a.sourceKey,
        })),
      });
    }

    if (!topics.length) return res.status(400).json({ error: 'No articles matched the given _ids' });

    /* Save only to the specified window */
    await EditorialRepeatAnalysis.findOneAndUpdate(
      { userId, generatedForDateKey: latestKey, windowType: wt },
      {
        $set: {
          rulesApplied: {
            windowType: wt, method: 'external-ai-import',
            totalArticles: allArticleIds.size, algorithmVersion: '3.0',
          },
          results: topics,
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    res.json({
      success: true,
      message: `Imported ${topics.length} topic groups covering ${allArticleIds.size} articles for ${wt}`,
      topicsFound: topics.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
