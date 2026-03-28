import express from 'express';
import { requireAdmin, authenticate } from '../middleware/auth.js';
import MockTest from '../models/MockTest.js';
import TestSeries from '../models/TestSeries.js';
import Question from '../models/Question.js';
import TestAttempt from '../models/TestAttempt.js';
import User from '../models/User.js';

const router = express.Router();

router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  try {
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);

    const [
      totalTests,
      totalSeries,
      totalQuestions,
      totalUsers,
      testsByMode,
      testsBySubject
    ] = await Promise.all([
      MockTest.countDocuments({ userId: { $in: adminUserIds } }),
      TestSeries.countDocuments({ userId: { $in: adminUserIds } }),
      Question.countDocuments(),
      User.countDocuments(),
      MockTest.aggregate([
        { $match: { userId: { $in: adminUserIds } } },
        { $group: { _id: '$mode', count: { $sum: 1 } } }
      ]),
      MockTest.aggregate([
        { $match: { userId: { $in: adminUserIds } } },
        { $group: { _id: '$subject', count: { $sum: 1 } } }
      ])
    ]);

    res.json({
      totalTests,
      totalSeries,
      totalQuestions,
      totalUsers,
      testsByMode: testsByMode.reduce((acc, m) => ({ ...acc, [m._id]: m.count }), {}),
      testsBySubject: testsBySubject.reduce((acc, m) => ({ ...acc, [m._id]: m.count }), {})
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

export default router;
