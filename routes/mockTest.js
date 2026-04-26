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
  extractUPSCVisualMap,
  streamPdfToResponse,
  extractAnswerKeyFromSolutionPdf,
  extractQuestionPaperMap,
  uploadFileToUploadthing,
  extractAndStoreQuestionText,
  processTestPaperImages
} from '../services/pdfService.js';
import { aiService } from '../services/aiService.js';
import { calculateScore } from '../services/scoringService.js';
import { UTApi } from "uploadthing/server";
import Question from '../models/Question.js';
import { parseQuestions, parseSolutions, mapQuestionsAndSolutions, extractAnswersRegex } from '../utils/parser.js';


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

// Admin only - Structured upload
router.post('/upload-structured', requireAdmin, async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      name, subject, testType, totalQuestions, durationMinutes,
      markCorrect, markWrong, questionPaperText, solutionText, testSeriesId, year
    } = req.body;

    if (!questionPaperText || !solutionText) {
      return res.status(400).json({ error: "Question paper and solution text are required" });
    }

    const parsedQuestions = await parseQuestions(questionPaperText);
    const parsedSolutions = parseSolutions(solutionText);
    let mappedData = mapQuestionsAndSolutions(parsedQuestions, parsedSolutions);

    if (!mappedData || mappedData.length === 0) {
      return res.status(400).json({ error: "No questions could be parsed. Please check the format (Q.1) ... a) b) c) d))" });
    }

    // 2. Validate & normalize all questions
    const validQuestions = [];
    for (const qData of mappedData) {
      const qText = (qData.questionText || qData.question || '').trim();
      const qNum = qData.questionNumber;
      const qOpts = qData.options;
      const qCorrect = String(qData.correctAnswer || '').toUpperCase().trim();

      if (!qText || !qOpts || !qNum) {
        console.warn(`[Structured Upload] Skipping Q${qNum || '?'} — missing text/options. qText:`, !!qText, "qOpts:", !!qOpts, "qNum:", qNum);
        continue;
      }
      if (!['A', 'B', 'C', 'D'].includes(qCorrect)) {
        console.warn(`[Structured Upload] Skipping Q${qNum} — invalid answer "${qCorrect}"`);
        continue;
      }

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
        explanation: (qData.explanation || qData.solution || '').trim(),
        subject: subject || 'General Studies',
        year: year || new Date().getFullYear()
      });
    }

    if (validQuestions.length === 0) {
      console.log("[Structured Upload] No valid questions after validation");
      return res.status(400).json({ error: "No valid questions with correct answers were found." });
    }
    
    console.log("[Structured Upload] Valid questions:", validQuestions.length);

    // 3. First create MockTest to get its ID (needed for question linking)
    const answerKeyObject = {};
    const mockTest = new MockTest({
      userId: req.user._id,
      testSeriesId: testSeriesId || null,
      name: name || "Structured Test",
      testType: testType || 'prelims_gs',
      subject,
      year,
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
    
    const mockTestId = mockTest._id;

    // 4. BULK UPSERT — single MongoDB call with mockTestId linking
    const t1 = Date.now();
    const bulkOps = validQuestions.map(q => ({
      updateOne: {
        filter: { text: q.text },           // find by exact text (dedup)
        update: {
          $setOnInsert: {           // only insert if new
            questionNumber: q.questionNumber,
            text: q.text,
            options: q.options,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            subject: q.subject,
            year: q.year,
            mockTestId: mockTestId
          }
        },
        upsert: true
      }
    }));

    await Question.bulkWrite(bulkOps, { ordered: false });

    // 5. Fetch the IDs (both new and existing)
    const questionTexts = validQuestions.map(q => q.text);
    const savedQuestions = await Question.find({ text: { $in: questionTexts } }).select('_id text questionNumber');

    // Build answer key map and update question IDs
    const textToQ = new Map(validQuestions.map(q => [q.text, q]));
    const questionIds = [];

    for (const savedQ of savedQuestions) {
      const original = textToQ.get(savedQ.text);
      if (original) {
        questionIds.push(savedQ._id);
        answerKeyObject[String(original.questionNumber)] = original.correctAnswer;
      }
    }

    // 6. Update MockTest with question IDs and answer key
    await MockTest.findByIdAndUpdate(mockTestId, {
      structuredQuestions: questionIds,
      answerKey: answerKeyObject,
      answerKeyCount: Object.keys(answerKeyObject).length
    });

    console.log(`[Structured Upload] DONE — ${validQuestions.length} questions, total time: ${Date.now() - t0}ms`);

    res.status(201).json({
      mockTestId: mockTest._id,
      status: 'ready',
      name: mockTest.name,
      questionCount: validQuestions.length
    });

  } catch (err) {
    console.error("Structured Upload Error:", err);
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
      attempt.mockTestId.structuredQuestions.forEach((q) => {
        structuredOpts[q.questionNumber] = q.options;
      });
      
      // Enrich userAnswers with options if missing
      attempt.userAnswers = attempt.userAnswers.map((ua) => {
        if (!ua.options && structuredOpts[ua.questionNumber]) {
          return { ...ua, options: structuredOpts[ua.questionNumber] };
        }
        return ua;
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

    if (mockTest.mode === 'structured') {
      const populatedTest = await MockTest.findById(mockTest._id).populate('structuredQuestions');
      
      populatedTest.structuredQuestions.forEach(q => {
        questionTextMap.set(q.questionNumber, q.text);
        explanationMap.set(q.questionNumber, q.explanation);
        optionsMap.set(q.questionNumber, q.options);
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
      options: optionsMap.get(ans.questionNumber) || null
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




async function processTestAndAnswerKey(mockTestId, testPdfPath, solutionPdfPath, totalQ) {
  try {
    // --- STEP 1: Process Test Paper - Crop Questions into Images FIRST (before upload deletes the file) ---
    // console.log("[Visual] Starting question image processing...");
    const questionsData = await processTestPaperImages(testPdfPath, totalQ, mockTestId);
    // console.log(`[Visual] Processed ${questionsData.length} question images`);

    // --- STEP 2: Upload Test PDF to Cloud ---
    const testUpload = await uploadFileToUploadthing(testPdfPath, false); // false = don't delete yet
    const testCloudUrl = testUpload?.url;
    console.log(`[Visual] Test PDF upload:`, testUpload ? 'success' : 'FAILED');

    if (!testCloudUrl) {
      throw new Error("Test PDF upload failed");
    }

    // --- STEP 3: Extract Answer Key from Solution PDF (AI-based) ---
    console.log("[Visual] Extracting answer key...");
    let regexParsed = {};
    let answerKeySection = '';
    
    try {
      const result = await extractAnswerKeyFromSolutionPdf(solutionPdfPath);
      regexParsed = result.regexParsed;
      answerKeySection = result.answerKeySection;
    } catch (extractErr) {
      if (extractErr.message === 'VISION_MODEL_NOT_SUPPORTED') {
        console.log("[Visual] Vision API failed, using regex fallback...");
        // Read solution PDF text directly for regex parsing
        const fs = await import('fs');
        const { extractAnswersRegex } = await import('../utils/parser.js');
        const solutionText = fs.readFileSync(solutionPdfPath, 'utf-8').substring(0, 50000);
        regexParsed = extractAnswersRegex(solutionText);
        answerKeySection = Object.entries(regexParsed).slice(0, 50).map(([k, v]) => `${k}: ${v}`).join(', ');
      } else {
        throw extractErr;
      }
    }
    
    const finalKey = await aiService.parseAnswerKeyFromText({ answerKeySection, regexParsed, totalQuestions: totalQ });

    // --- STEP 4: Map answers to questions ---
    const keyEntries = Object.entries(finalKey).filter(([k, v]) => !isNaN(parseInt(k)));
    const answerKeyMap = new Map(keyEntries.map(([k, v]) => [String(k), String(v).toUpperCase()]));

    // Update questions with correct answers
    const updatedQuestions = questionsData.map(q => {
      const correctAnswer = answerKeyMap.get(String(q.questionNumber)) || null;
      return {
        ...q,
        correctAnswer: correctAnswer
      };
    });

    // --- STEP 5: Save to Database ---
    await MockTest.findByIdAndUpdate(mockTestId, {
      testPdfPath: testCloudUrl,
      testPdfKey: testUpload.key,
      questions: updatedQuestions,
      answerKey: answerKeyMap,
      answerKeyCount: answerKeyMap.size,
      status: 'ready',
      questionTextExtractionStatus: 'completed'
    });

    // Cleanup - files may already be deleted by upload function
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }
    if (fs.existsSync(solutionPdfPath)) {
      try { fs.unlinkSync(solutionPdfPath); } catch (e) { }
    }

    console.log(`[Visual] Processing complete for MockTest ${mockTestId}`);

  } catch (err) {
    console.error("[Visual] Processing error:", err);
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }
    if (fs.existsSync(solutionPdfPath)) {
      try { fs.unlinkSync(solutionPdfPath); } catch (e) { }
    }
    throw err;
  }
}



async function processTestWithTextAnswerKey(mockTestId, testPdfPath, answerKeyText, totalQ) {
  try {
    // --- STEP 1: Process Test Paper - Crop Questions into Images ---
    // console.log("[Visual] Starting question image processing...");
    const questionsData = await processTestPaperImages(testPdfPath, totalQ, mockTestId);
    // console.log(`[Visual] Processed ${questionsData.length} question images`);

    // --- STEP 2: Upload Test PDF to Cloud ---
    const testUpload = await uploadFileToUploadthing(testPdfPath, false);
    const testCloudUrl = testUpload?.url;
    console.log(`[Visual] Test PDF upload:`, testUpload ? 'success' : 'FAILED');

    if (!testCloudUrl) {
      throw new Error("Test PDF upload failed");
    }

    // --- STEP 3: Parse Answer Key from Raw Text (AI-based) ---
    // console.log("[Visual] Parsing answer key from text...");
    // console.log("[Visual] Raw answer key text:", answerKeyText.substring(0, 500));

    // Use AI service to parse the raw text answer key
    const finalKey = await aiService.parseAnswerKeyFromText({
      answerKeySection: answerKeyText,
      regexParsed: {},
      totalQuestions: totalQ
    });

    // console.log("[Visual] AI parsed answer key:", JSON.stringify(finalKey));

    // --- STEP 4: Normalize answer keys (handle Q1, Q2, etc.) ---
    const normalizedKey = {};
    Object.entries(finalKey).forEach(([k, v]) => {
      // Extract just the number from keys like "Q1", "1", "Q 1"
      const questionNum = String(k).replace(/Q\s*/i, '').trim();
      if (!isNaN(parseInt(questionNum))) {
        normalizedKey[questionNum] = String(v).toUpperCase().replace(/[^ABCD]/g, '');
      }
    });

    console.log("[Visual] Normalized answer key:", JSON.stringify(normalizedKey));

    // --- STEP 5: Map answers to questions ---
    const keyEntries = Object.entries(normalizedKey).filter(([k, v]) => !isNaN(parseInt(k)));
    const answerKeyMap = new Map(keyEntries.map(([k, v]) => [String(k), v]));

    // console.log(`[Visual] Final answer key map:`, Object.fromEntries(answerKeyMap));

    // Update questions with correct answers
    const updatedQuestions = questionsData.map(q => {
      const correctAnswer = answerKeyMap.get(String(q.questionNumber)) || null;
      if (!correctAnswer) {
        console.log(`[Visual] WARNING: No answer found for Q${q.questionNumber}`);
      }
      return {
        ...q,
        correctAnswer: correctAnswer
      };
    });

    const questionsWithAnswers = updatedQuestions.filter(q => q.correctAnswer).length;
    // console.log(`[Visual] Questions with answers: ${questionsWithAnswers}/${updatedQuestions.length}`);

    // --- STEP 5: Save to Database ---
    await MockTest.findByIdAndUpdate(mockTestId, {
      testPdfPath: testCloudUrl,
      testPdfKey: testUpload.key,
      questions: updatedQuestions,
      answerKey: answerKeyMap,
      answerKeyCount: answerKeyMap.size,
      status: 'ready',
      questionTextExtractionStatus: 'completed'
    });

    // Cleanup
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }

    console.log(`[Visual] Processing complete for MockTest ${mockTestId}`);

  } catch (err) {
    console.error("[Visual] Processing error:", err);
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) { }
    }
    throw err;
  }
}



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

