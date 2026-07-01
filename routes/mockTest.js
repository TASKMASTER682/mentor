import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { uploadPDFs } from '../middleware/upload.js';
import MockTest from '../models/MockTest.js';
import TestAttempt from '../models/TestAttempt.js';
import User from '../models/User.js';
import {
  streamPdfToResponse,
  uploadFileToUploadthing
} from '../services/pdfService.js';
import { aiService } from '../services/aiService.js';
import { calculateScore } from '../services/scoringService.js';
import { UTApi } from "uploadthing/server";
import Question from '../models/Question.js';
import { extractAnswersRegex, parseMarkers } from '../utils/parser.js';


const utapi = new UTApi({ token: process.env.UPLOADTHING_SECRET });

const router = express.Router();

const unlinkIfExists = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.access(filePath);
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`[MockTest] Failed to delete file "${filePath}":`, err.message);
    }
  }
};

router.get('/', async (req, res) => {
  try {
    const { subject, year, testType, mode } = req.query;
    const filter = {};

    if (subject) filter.subject = subject;
    if (year) filter.year = parseInt(year);
    if (testType) filter.testType = testType;
    if (mode) filter.mode = mode;

    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);
    
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'upsc_secret_key');
        const currentUserId = decoded.userId;
        filter.$or = [
          { userId: { $in: adminUserIds } },
          { userId: currentUserId }
        ];
      } catch (e) {
        filter.userId = { $in: adminUserIds };
      }
    } else {
      filter.userId = { $in: adminUserIds };
    }

    const tests = await MockTest.find(filter)
      .select('-answerKey')
      .sort({ createdAt: -1 });
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get unique subjects and years for filtering (public)
router.get('/metadata/filters', async (req, res) => {
  try {
    const adminUsers = await User.find({ role: 'admin' }).select('_id');
    const adminUserIds = adminUsers.map(u => u._id);
    
    let filter = { userId: { $in: adminUserIds } };
    
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'upsc_secret_key');
        filter.$or = [
          { userId: { $in: adminUserIds } },
          { userId: decoded.userId }
        ];
      } catch (e) {
        filter.userId = { $in: adminUserIds };
      }
    }

    const subjects = await MockTest.distinct('subject', filter);
    const years = await MockTest.distinct('year', filter);

    res.json({
      subjects: subjects.filter(Boolean).sort(),
      years: years.filter(Boolean).sort((a, b) => b - a)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public routes - view test details without authentication
router.get('/:id', async (req, res) => {
  try {
    const test = await MockTest.findById(req.params.id)
      .select('-answerKey')
      .populate('structuredQuestions');

    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const test = await MockTest.findById(req.params.id).select('testPdfPath mode');
    if (!test || !test.testPdfPath) {
      return res.status(404).json({ error: 'Test PDF not found' });
    }

    if (test.testPdfPath === 'NOT_APPLICABLE' || test.mode === 'structured') {
      return res.status(404).json({ error: 'No PDF — this is a structured question bank test. Questions are loaded directly.' });
    }

    return streamPdfToResponse(test.testPdfPath, req, res);
  } catch (err) {
    res.status(500).json({ error: "Could not retrieve PDF" });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const test = await MockTest.findById(req.params.id)
      .select('status processingError totalQuestions name answerKeyCount questionTextExtractionStatus userId');
    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json({
      status: test.status,
      error: test.processingError,
      answerKeyCount: test.answerKeyCount || 0,
      totalQuestions: test.totalQuestions,
      name: test.name,
      questionTextExtractionStatus: test.questionTextExtractionStatus || 'pending'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All routes below require authentication
router.use(authenticate);

router.get('/attempts/all/list', async (req, res) => {
  try {
    const limit = Number(req.query.limit);

    let query = TestAttempt.find({ userId: req.user._id })
      .populate('mockTestId', 'name testType totalQuestions durationMinutes markCorrect markWrong testSeriesId mode')
      .sort({ submittedAt: -1 });

    if (Number.isFinite(limit) && limit > 0) {
      query = query.limit(limit);
    }

    const attempts = await query;

    res.json(attempts);
  } catch (err) {
    console.error('Error fetching all attempts:', err);
    res.status(500).json({ error: err.message });
  }
});



router.post('/upload', uploadPDFs, async (req, res) => {
  let mockTest = null;
  try {
    // 1. Validation - now only requires test PDF
    if (!req.files?.testPdf?.[0]) {
      return res.status(400).json({ error: 'Test PDF is required' });
    }

    const testFile = req.files.testPdf[0];
    const answerKeyText = req.body.answerKeyText || '';
    const totalQ = Math.max(1, parseInt(req.body.totalQuestions) || 100);

    const topicsArray = req.body.topics
      ? req.body.topics.split(',').map(t => t.trim()).filter(t => t !== "")
      : [];

    // 2. Initial Create (Local Paths)
    mockTest = new MockTest({
      userId: req.user._id,
      testSeriesId: req.body.testSeriesId || null,
      name: req.body.name?.trim() || testFile.originalname.replace(/\.pdf$/i, ''),
      testType: req.body.testType || 'prelims_gs',
      subject: req.body.subject,
      year: req.body.year ? parseInt(req.body.year) : null,
      topics: topicsArray,
      totalQuestions: totalQ,
      durationMinutes: parseInt(req.body.durationMinutes) || 120,
      markCorrect: parseFloat(req.body.markCorrect) || 2.0,
      markWrong: parseFloat(req.body.markWrong) || -0.66,
      testPdfPath: testFile.path,
      solutionPdfPath: null,
      testPdfName: testFile.originalname,
      solutionPdfName: null,
      status: 'processing',
    });

    await mockTest.save();

    // 3. Simplified Processing for Fallback Mode (No OCR, No AI)
    processPdfWithoutAI(mockTest._id, testFile.path, answerKeyText, totalQ).catch(async (err) => {
      console.error(`[MockTest ${mockTest._id}] Processing Error:`, err.message);
      await MockTest.findByIdAndUpdate(mockTest._id, {
        status: 'error',
        processingError: String(err.message)
      });
    });

    res.status(201).json({
      mockTestId: mockTest._id,
      status: 'processing',
      name: mockTest.name
    });

  } catch (err) {
    console.error("Upload Route Error:", err.message);
    const fs = await import('fs');
    [req.files?.testPdf?.[0]?.path, req.files?.solutionPdf?.[0]?.path].forEach(p => {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    });
    res.status(500).json({ error: err.message });
  }
});



// POST /mock-tests/upload-structured-markers — Marker-based structured upload
router.post('/upload-structured-markers', requireAdmin, async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      name, subject, testType, totalQuestions, durationMinutes,
      markCorrect, markWrong, structuredText, testSeriesId, year, type
    } = req.body;

    if (!structuredText || !structuredText.trim()) {
      return res.status(400).json({ error: "Structured text is required" });
    }

    const parsedData = parseMarkers(structuredText);
    if (!parsedData || parsedData.length === 0) {
      return res.status(400).json({ error: "No questions could be parsed. Use markers like [Q], [O_a], [ANS], [EXP], [NEXT]" });
    }

    const validQuestions = [];
    for (const qData of parsedData) {
      const qText = qData.questionText?.trim();
      const qNum = qData.questionNumber;
      const qOpts = qData.options;
      const qCorrect = String(qData.correctAnswer || '').toUpperCase().trim();

      if (!qText || !qNum) {
        console.warn(`[Marker Structured] Skipping Q${qNum || '?'} — missing text`);
        continue;
      }
      if (!['A', 'B', 'C', 'D'].includes(qCorrect)) {
        console.warn(`[Marker Structured] Skipping Q${qNum} — invalid answer "${qCorrect}"`);
        continue;
      }

      const qSubject = qData.subject || subject || 'General Studies';
      validQuestions.push({
        questionNumber: qNum,
        text: qText,
        options: {
          a: qOpts.a || 'Option A',
          b: qOpts.b || 'Option B',
          c: qOpts.c || 'Option C',
          d: qOpts.d || 'Option D',
        },
        correctAnswer: qCorrect,
        explanation: (qData.explanation || '').trim(),
        structure: qData.structure || null,
        subject: qSubject,
        year: year || new Date().getFullYear(),
        type: type || ''
      });
    }

    if (validQuestions.length === 0) {
      return res.status(400).json({ error: "No valid questions with correct answers were found." });
    }

    const mockTest = new MockTest({
      userId: req.user._id,
      testSeriesId: testSeriesId || null,
      name: name || "Structured Test",
      testType: testType || 'prelims_gs',
      subject: subject || 'General Studies',
      year: year,
      totalQuestions: totalQuestions || validQuestions.length,
      durationMinutes: durationMinutes || 120,
      markCorrect: markCorrect || 2.0,
      markWrong: markWrong || -0.66,
      mode: 'structured',
      structuredQuestions: [],
      answerKey: {},
      answerKeyCount: 0,
      status: 'ready',
      questionTextExtractionStatus: 'completed',
      testPdfPath: "NOT_APPLICABLE"
    });
    await mockTest.save();

    const answerKeyObject = {};
    const bulkOps = validQuestions.map(q => ({
      updateOne: {
        filter: { text: q.text },
        update: {
          $setOnInsert: {
            questionNumber: q.questionNumber,
            text: q.text,
            options: q.options,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            structure: q.structure,
            subject: q.subject,
            year: q.year,
            type: q.type || type || '',
            mockTestId: mockTest._id
          }
        },
        upsert: true
      }
    }));

    await Question.bulkWrite(bulkOps, { ordered: false });

    const questionTexts = validQuestions.map(q => q.text);
    const savedQuestions = await Question.find({ text: { $in: questionTexts } }).select('_id text questionNumber');
    const textToQ = new Map(validQuestions.map(q => [q.text, q]));
    const questionIds = [];

    for (const savedQ of savedQuestions) {
      const original = textToQ.get(savedQ.text);
      if (original) {
        questionIds.push(savedQ._id);
        answerKeyObject[String(original.questionNumber)] = original.correctAnswer;
      }
    }

    await MockTest.findByIdAndUpdate(mockTest._id, {
      structuredQuestions: questionIds,
      answerKey: answerKeyObject,
      answerKeyCount: Object.keys(answerKeyObject).length
    });

    console.log(`[Marker Structured] DONE — ${validQuestions.length} questions, time: ${Date.now() - t0}ms`);

    res.status(201).json({
      mockTestId: mockTest._id,
      status: 'ready',
      name: mockTest.name,
      questionCount: validQuestions.length
    });

  } catch (err) {
    console.error("Marker Structured Upload Error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/attempts/:attemptId', async (req, res) => {
  try {
    const attempt = await TestAttempt.findOne({ _id: req.params.attemptId, userId: req.user._id })
      .populate('mockTestId', 'name testType totalQuestions markCorrect markWrong mode structuredQuestions');
    
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    
    // If options missing in userAnswers, try to get from structuredQuestions
    if (attempt.mockTestId?.structuredQuestions) {
      const structuredOpts = {};
      const structuredStructures = {};
      attempt.mockTestId.structuredQuestions.forEach((q) => {
        structuredOpts[q.questionNumber] = q.options;
        structuredStructures[q.questionNumber] = q.structure || null;
      });
      
      // Enrich userAnswers with options & structure if missing
      attempt.userAnswers = attempt.userAnswers.map((ua) => {
        const enriched = { ...ua };
        if (!ua.options && structuredOpts[ua.questionNumber]) {
          enriched.options = structuredOpts[ua.questionNumber];
        }
        if (!ua.structure && structuredStructures[ua.questionNumber]) {
          enriched.structure = structuredStructures[ua.questionNumber];
        }
        return enriched;
      });
    }
    res.json(attempt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/:id/submit', async (req, res) => {
  try {
    const { userAnswers, timeTakenMinutes } = req.body;

    const mockTest = await MockTest.findById(req.params.id);
    if (!mockTest) {
      console.error(`[Submission] Test not found: ${req.params.id} for user: ${req.user._id}`);
      return res.status(404).json({ error: 'Test not found' });
    }

    const markingScheme = {
      CORRECT: Number(mockTest.markCorrect) || 2,
      WRONG: Number(mockTest.markWrong) || -0.66,
      UNATTEMPTED: Number(mockTest.markUnattempted) || 0,
    };

    // Build question map
    const questionTextMap = new Map();
    const explanationMap = new Map();
    const optionsMap = new Map();
    const structureMap = new Map();

    if (mockTest.mode === 'structured') {
      const populatedTest = await MockTest.findById(mockTest._id).populate('structuredQuestions');
      
      populatedTest.structuredQuestions.forEach(q => {
        questionTextMap.set(q.questionNumber, q.text);
        explanationMap.set(q.questionNumber, q.explanation);
        optionsMap.set(q.questionNumber, q.options);
        structureMap.set(q.questionNumber, q.structure || null);
      });
    } else if (mockTest.questions) {
      mockTest.questions.forEach(q => {
        questionTextMap.set(q.questionNumber, q.text);
      });
    }

    const result = calculateScore(userAnswers, mockTest.answerKey, markingScheme);

    // Enrich results with text, explanations and options
    const enrichedUserAnswers = result.userAnswers.map(ans => ({
      ...ans,
      questionText: questionTextMap.get(ans.questionNumber) || "",
      explanation: explanationMap.get(ans.questionNumber) || "",
      options: optionsMap.get(ans.questionNumber) || null,
      structure: structureMap.get(ans.questionNumber) || null
    }));

    // No need to enrich with imageUrls
    const attempt = new TestAttempt({
      userId: req.user._id,
      mockTestId: mockTest._id,
      testName: mockTest.name,
      userAnswers: enrichedUserAnswers,
      score: result.score,
      maxScore: result.maxScore || 0,
      percentage: result.percentage || 0,
      correctCount: result.correctCount || 0,
      wrongCount: result.wrongCount || 0,
      unattemptedCount: result.unattemptedCount || 0,
      timeTakenMinutes: timeTakenMinutes || 0,
      testSeriesId: mockTest.testSeriesId, // Pass testSeriesId from mockTest
      feedbackStatus: 'pending' // Changed to 'pending' for proper polling
    });

    await attempt.save();

    // Background Process - Pass questions for targeted analysis
    generateAndSaveFeedback(attempt._id, attempt, mockTest, req.user)
      .catch(err => console.error("Background AI Error:", err));

    res.status(201).json({
      attemptId: attempt._id,
      ...result,
      pollingAI: true // Frontend ko bolo loader dikhaye
    });

  } catch (err) {
    console.error("Submission Route Error:", err);
    res.status(500).json({ error: err.message });
  }
});



router.put('/:id/answer-key', async (req, res) => {
  try {
    const test = await MockTest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const answerKeyData = req.body; // Expecting {"1": "A", "2": "B", ...}
    // Store as plain object instead of Map for consistency
    const answerKeyObject = {};
    Object.entries(answerKeyData).forEach(([k, v]) => {
      answerKeyObject[String(k)] = String(v).toUpperCase();
    });

    await MockTest.updateOne(
      { _id: req.params.id },
      {
        $set: {
          answerKey: answerKeyObject,
          answerKeyCount: Object.keys(answerKeyObject).length
        }
      }
    );

    res.json({ success: true, answerKeyCount: Object.keys(answerKeyObject).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin only - Delete any test
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const test = await MockTest.findById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const keysToDelete = [];
    if (test.testPdfKey) keysToDelete.push(test.testPdfKey);
    if (test.solutionPdfKey) keysToDelete.push(test.solutionPdfKey);

    if (keysToDelete.length > 0) {
      await utapi.deleteFiles(keysToDelete).catch(err => console.error("UT Delete Error:", err));
    }

    // Delete ALL structured questions linked to this test (no sharing check)
    if (test.mode === 'structured' && test.structuredQuestions && test.structuredQuestions.length > 0) {
      const questionIds = test.structuredQuestions.map(id => id.toString());
      await Question.deleteMany({ _id: { $in: questionIds } });
      console.log(`[Delete] Deleted ${questionIds.length} questions from Question collection`);
    }

    await MockTest.findByIdAndDelete(req.params.id);
    await TestAttempt.deleteMany({ mockTestId: req.params.id });

    res.json({ success: true, message: "Deleted from Cloud and DB" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin only - Cleanup orphaned questions (not linked to any mock test)
router.post('/cleanup-questions', requireAdmin, async (req, res) => {
  try {
    // Get all question IDs used in structuredQuestions arrays
    const allTests = await MockTest.find({ mode: 'structured' }).select('structuredQuestions');
    const usedQuestionIds = new Set();
    
    allTests.forEach(test => {
      if (test.structuredQuestions) {
        test.structuredQuestions.forEach(qId => {
          usedQuestionIds.add(qId.toString());
        });
      }
    });

    // Find questions NOT in any mock test
    const allQuestions = await Question.find({}).select('_id');
    const orphanedQuestions = allQuestions.filter(q => !usedQuestionIds.has(q._id.toString()));

    const orphanedCount = orphanedQuestions.length;
    
    if (orphanedCount > 0) {
      await Question.deleteMany({ _id: { $in: orphanedQuestions.map(q => q._id) } });
    }

    console.log(`[Cleanup] Deleted ${orphanedCount} orphaned questions`);
    res.json({ 
      success: true, 
      deletedCount: orphanedCount,
      remainingQuestions: allQuestions.length - orphanedCount
    });
  } catch (err) {
    console.error('[Cleanup] Error:', err);
    res.status(500).json({ error: err.message });
  }
});












async function generateAndSaveFeedback(attemptId, attempt, mockTest, user) {
  try {
    // console.log(`[Arjun AI] Starting Targeted Analysis for Attempt: ${attemptId}`);

    // --- STEP 1: Build question map from stored questions ---
    let questionMap = new Map();
    let questionTextMap = new Map();
    let questionImageMap = new Map();

    if (mockTest.questions && Array.isArray(mockTest.questions)) {
      mockTest.questions.forEach(q => {
        questionMap.set(q.questionNumber, q);
        questionTextMap.set(q.questionNumber, q.text);
        questionImageMap.set(q.questionNumber, q.imageUrl);
      });
    }

    const baseAnswers = Array.isArray(attempt.userAnswers) ? attempt.userAnswers : [];

    // Skip AI Feedback for PDF mode (Fallback requirement)
    if (mockTest.mode === 'pdf') {
      await TestAttempt.findByIdAndUpdate(attemptId, {
        feedbackStatus: 'completed',
        aiFeedback: { headline: "Result Calculated", summary: { strengths: ["Test submitted"], studyRecommendations: "Review the answers manually." } }
      });
      return;
    }

    // --- STEP 2: Identify WRONG questions ---
    const wrongQuestions = [];
    const allQuestions = baseAnswers.map(ans => {
      const qData = questionMap.get(ans.questionNumber);
      const correctAnswer = qData?.correctAnswer || ans.correctAnswer;
      const userAnswer = ans.answer;
      const isCorrect = correctAnswer && userAnswer &&
        String(correctAnswer).toUpperCase() === String(userAnswer).toUpperCase();

      // Get question text, imageUrl and topic from stored questions
      const storedQ = questionTextMap.get(ans.questionNumber);
      const questionText = storedQ || `Question ${ans.questionNumber}`;
      const imageUrl = questionImageMap.get(ans.questionNumber);
      const topic = qData?.topic || qData?.subject || 'General Studies';

      const qObj = {
        questionNumber: ans.questionNumber,
        questionText: questionText,
        imageUrl: imageUrl,
        questionImageUrl: imageUrl, // For targeted feedback
        topic: topic,
        userChoice: userAnswer ?? 'Unattempted',
        correctAnswer: correctAnswer ?? 'N/A',
        isCorrect: isCorrect
      };

      if (!isCorrect && userAnswer) {
        wrongQuestions.push(qObj);
      }

      return qObj;
    });

    // console.log(`[Arjun AI] Total: ${allQuestions.length}, Wrong: ${wrongQuestions.length}`);

    // --- STEP 3: Send to AI for analysis (OCR + Groq + NVIDIA done in aiService) ---
    const analysis = await aiService.generateTargetedFeedback({
      user,
      attempt,
      mockTest,
      wrongQuestions
    });

    // --- STEP 4: Update Database ---
    if (analysis) {
      const finalWeakAreas = Array.isArray(analysis.topicList) ? analysis.topicList : [];
      const finalDeepAnalysis = Array.isArray(analysis.deepAnalysis) ? analysis.deepAnalysis : [];

      await TestAttempt.findByIdAndUpdate(attemptId, {
        aiFeedback: analysis,
        weakAreas: finalWeakAreas,
        deepAnalysis: finalDeepAnalysis,
        feedbackStatus: 'completed'
      });

      console.log(`[Arjun AI] Analysis Completed - Weak Areas: ${finalWeakAreas.length}, Deep Analysis: ${finalDeepAnalysis.length}`);

    } else {
      console.error(`[Arjun AI] Analysis returned null for attempt: ${attemptId}`);
      await TestAttempt.findByIdAndUpdate(attemptId, { feedbackStatus: 'failed' });
    }

  } catch (err) {
    console.error("ARJUN ENGINE CRITICAL ERROR:", err);
    console.error("Stack trace:", err.stack);

    try {
      await TestAttempt.findByIdAndUpdate(attemptId, {
        feedbackStatus: 'failed',
        processingError: err.message
      });
    } catch (updateErr) {
      console.error("Failed to update attempt status:", updateErr.message);
    }
  }
}

async function processPdfWithoutAI(mockTestId, testPdfPath, answerKeyText, totalQ) {
  try {
    // 1. Just upload the PDF
    const testUpload = await uploadFileToUploadthing(testPdfPath, false);
    if (!testUpload?.url) throw new Error("PDF upload failed");

    // 2. Parse answer key using simple regex (No AI)
    const finalKey = extractAnswersRegex(answerKeyText);
    const answerKeyMap = new Map(Object.entries(finalKey));

    // 3. Save to DB without question images/texts (Fallback mode simplicity)
    await MockTest.findByIdAndUpdate(mockTestId, {
      testPdfPath: testUpload.url,
      testPdfKey: testUpload.key,
      answerKey: answerKeyMap,
      answerKeyCount: answerKeyMap.size,
      status: 'ready',
      mode: 'pdf'
    });

    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }
  } catch (err) {
    console.error("[Fallback PDF] Error:", err.message);
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }
    throw err;
  }
}

export default router;

