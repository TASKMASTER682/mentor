import express from 'express';
import fs from 'fs';
import { authenticate } from '../middleware/auth.js';
import { uploadPDFs } from '../middleware/upload.js';
import MockTest from '../models/MockTest.js';
import TestAttempt from '../models/TestAttempt.js';
import { 
  extractUPSCVisualMap,
  streamPdfToResponse, 
  extractAnswerKeyFromSolutionPdf, 
  extractQuestionPaperMap,
  uploadFileToUploadthing,
  extractAndStoreQuestionText,
  processTestPaperImages
} from '../services/pdfService.js';
import { aiService} from '../services/aiService.js';
import { calculateScore } from '../services/scoringService.js';
import { UTApi } from "uploadthing/server";

const utapi = new UTApi();

const router = express.Router();
router.use(authenticate);

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
    const tests = await MockTest.find({ userId: req.user._id })
      .select('-answerKey')
      .sort({ createdAt: -1 });
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/attempts/all/list', async (req, res) => {
  try {
    const limit = Number(req.query.limit);

    let query = TestAttempt.find({ userId: req.user._id })
      .populate('mockTestId', 'name testType totalQuestions durationMinutes markCorrect markWrong testSeriesId')
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

    // 3. Visual Processing: Crop questions and parse answer key from text
    processTestWithTextAnswerKey(mockTest._id, testFile.path, answerKeyText, totalQ).catch(async (err) => {
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

router.get('/:id/pdf', async (req, res) => {
  try {
    // 1. Auth Check (Token Header mein ho ya Query string mein)
    // Frontend ab query mein bhejege: ?token=xyz
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Yahan aap apna manual JWT verify logic bhi daal sakte hain agar middleware bypass ho raha ho
    // Maan lete hain req.user._id mil raha hai (warna query se verify karein)

    const test = await MockTest.findById(req.params.id).select('testPdfPath');

    if (!test || !test.testPdfPath) {
      return res.status(404).json({ error: 'Test PDF not found' });
    }

    // Call our smart service
    return streamPdfToResponse(test.testPdfPath, req, res);

  } catch (err) {
    console.error("[Route Error] PDF Stream failed:", err);
    res.status(500).json({ error: "Could not retrieve PDF" });
  }
});


router.get('/:id/status', async (req, res) => {
  try {
    const test = await MockTest.findOne({ _id: req.params.id, userId: req.user._id })
      .select('status processingError totalQuestions name answerKeyCount questionTextExtractionStatus');
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
router.get('/attempts/:attemptId', async (req, res) => {
  try {
    const attempt = await TestAttempt.findOne({ _id: req.params.attemptId, userId: req.user._id })
      .populate('mockTestId', 'name testType totalQuestions markCorrect markWrong');
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    res.json(attempt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/:id/submit', async (req, res) => {
  try {
    const { userAnswers, timeTakenMinutes } = req.body;
    
    const mockTest = await MockTest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mockTest) {
      console.error(`[Submission] Test not found: ${req.params.id} for user: ${req.user._id}`);
      return res.status(404).json({ error: 'Test not found' });
    }

    const markingScheme = {
      CORRECT: Number(mockTest.markCorrect) || 2,
      WRONG: Number(mockTest.markWrong) || -0.66,
      UNATTEMPTED: Number(mockTest.markUnattempted) || 0,
    };

    // Build question map - no imageUrl needed for AI analysis
    const questionTextMap = new Map();
    if (mockTest.questions) {
      mockTest.questions.forEach(q => {
        questionTextMap.set(q.questionNumber, q.text);
      });
    }

    const result = calculateScore(userAnswers, mockTest.answerKey, markingScheme);

    // No need to enrich with imageUrls
    const attempt = new TestAttempt({
      userId: req.user._id,
      mockTestId: mockTest._id,
      testName: mockTest.name,
      userAnswers: result.userAnswers,
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

router.get('/:id', async (req, res) => {
  try {
    const test = await MockTest.findOne({ _id: req.params.id, userId: req.user._id }).select('-answerKey');
    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json(test);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.put('/:id/answer-key', async (req, res) => {
  try {
    const test = await MockTest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const answerKeyData = req.body; // Expecting {"1": "A", "2": "B", ...}
    const answerKeyMap = new Map(Object.entries(answerKeyData));

    await MockTest.updateOne(
      { _id: req.params.id },
      { 
        $set: { 
          answerKey: answerKeyMap,
          answerKeyCount: answerKeyMap.size
        }
      }
    );

    res.json({ success: true, answerKeyCount: answerKeyMap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.delete('/:id', async (req, res) => {
    try {
        const test = await MockTest.findOne({ _id: req.params.id, userId: req.user._id });
        if (!test) return res.status(404).json({ error: 'Test not found' });

        // 1. Uploadthing se delete (Using keys)
        const keysToDelete = [];
        if (test.testPdfKey) keysToDelete.push(test.testPdfKey);
        if (test.solutionPdfKey) keysToDelete.push(test.solutionPdfKey);

        if (keysToDelete.length > 0) {
            await utapi.deleteFiles(keysToDelete).catch(err => console.error("UT Delete Error:", err));
        }

        // 2. Database cleanup
        await MockTest.findByIdAndDelete(req.params.id);
        await TestAttempt.deleteMany({ mockTestId: req.params.id });

        res.json({ success: true, message: "Deleted from Cloud and DB" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



async function processTestAndAnswerKey(mockTestId, testPdfPath, solutionPdfPath, totalQ) {
  try {
    // --- STEP 1: Process Test Paper - Crop Questions into Images FIRST (before upload deletes the file) ---
    console.log("[Visual] Starting question image processing...");
    const questionsData = await processTestPaperImages(testPdfPath, totalQ);
    console.log(`[Visual] Processed ${questionsData.length} question images`);
    
    // --- STEP 2: Upload Test PDF to Cloud ---
    const testUpload = await uploadFileToUploadthing(testPdfPath, false); // false = don't delete yet
    const testCloudUrl = testUpload?.url;
    console.log(`[Visual] Test PDF upload:`, testUpload ? 'success' : 'FAILED');
    
    if (!testCloudUrl) {
      throw new Error("Test PDF upload failed");
    }
    
    // --- STEP 3: Extract Answer Key from Solution PDF (AI-based) ---
    console.log("[Visual] Extracting answer key...");
    const { regexParsed, answerKeySection } = await extractAnswerKeyFromSolutionPdf(solutionPdfPath);
    const finalKey = await aiService.parseAnswerKeyFromText({ answerKeySection, regexParsed, totalQuestions: totalQ });
    
    // --- STEP 4: Map answers to questions ---
    const keyEntries = Object.entries(finalKey).filter(([k, v]) => !isNaN(parseInt(k)));
    const answerKeyMap = new Map(keyEntries.map(([k, v]) => [String(k), String(v).toUpperCase()]));
    
    // Update questions with correct answers (keep original text, add correctAnswer)
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
      try { fs.unlinkSync(testPdfPath); } catch (e) {}
    }
    if (fs.existsSync(solutionPdfPath)) {
      try { fs.unlinkSync(solutionPdfPath); } catch (e) {}
    }
    
    console.log(`[Visual] Processing complete for MockTest ${mockTestId}`);
    
  } catch (err) {
    console.error("[Visual] Processing error:", err);
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) {}
    }
    if (fs.existsSync(solutionPdfPath)) {
      try { fs.unlinkSync(solutionPdfPath); } catch (e) {}
    }
    throw err;
  }
}



async function processTestWithTextAnswerKey(mockTestId, testPdfPath, answerKeyText, totalQ) {
  try {
    // --- STEP 1: Process Test Paper - Crop Questions into Images ---
    console.log("[Visual] Starting question image processing...");
    const questionsData = await processTestPaperImages(testPdfPath, totalQ);
    console.log(`[Visual] Processed ${questionsData.length} question images`);
    
    // --- STEP 2: Upload Test PDF to Cloud ---
    const testUpload = await uploadFileToUploadthing(testPdfPath, false);
    const testCloudUrl = testUpload?.url;
    console.log(`[Visual] Test PDF upload:`, testUpload ? 'success' : 'FAILED');
    
    if (!testCloudUrl) {
      throw new Error("Test PDF upload failed");
    }
    
    // --- STEP 3: Parse Answer Key from Raw Text (AI-based) ---
    console.log("[Visual] Parsing answer key from text...");
    console.log("[Visual] Raw answer key text:", answerKeyText.substring(0, 500));
    
    // Use AI service to parse the raw text answer key
    const finalKey = await aiService.parseAnswerKeyFromText({ 
      answerKeySection: answerKeyText, 
      regexParsed: {}, 
      totalQuestions: totalQ 
    });
    
    console.log("[Visual] AI parsed answer key:", JSON.stringify(finalKey));
    
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
    
    console.log(`[Visual] Final answer key map:`, Object.fromEntries(answerKeyMap));
    
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
    console.log(`[Visual] Questions with answers: ${questionsWithAnswers}/${updatedQuestions.length}`);
    
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
      try { fs.unlinkSync(testPdfPath); } catch (e) {}
    }
    
    console.log(`[Visual] Processing complete for MockTest ${mockTestId}`);
    
  } catch (err) {
    console.error("[Visual] Processing error:", err);
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (e) {}
    }
    throw err;
  }
}



async function generateAndSaveFeedback(attemptId, attempt, mockTest, user) {
  try {
    console.log(`[Arjun AI] Starting Targeted Analysis for Attempt: ${attemptId}`);

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

    console.log(`[Arjun AI] Total: ${allQuestions.length}, Wrong: ${wrongQuestions.length}`);

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

export default router;

