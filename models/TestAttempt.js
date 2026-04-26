import mongoose from 'mongoose';
const userAnswerSchema = new mongoose.Schema({
  questionNumber: { type: Number, required: true },
  answer: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
  isCorrect: { type: Boolean, default: false },
  marksAwarded: { type: Number, default: 0 },
  correctAnswer: { type: String },
  subject: { type: String, default: 'General Studies' },
  topic: { type: String, default: null },
  imageUrl: { type: String, default: null },
  questionImageUrl: { type: String, default: null }, // Cropped question image
  questionText: { type: String },
  explanation: { type: String },
  options: { type: mongoose.Schema.Types.Mixed, default: null },
  mentorAdvice: { type: String, default: null }, // 2-3 line advice
});
const subjectBreakdownSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  total: { type: Number, default: 0 },
  correct: { type: Number, default: 0 },
  wrong: { type: Number, default: 0 },
  unattempted: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  accuracy: { type: Number, default: 0 },
});
const testAttemptSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  mockTestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MockTest',
    required: true,
    index: true
  },
  testName: { type: String, required: true },
  userAnswers: [userAnswerSchema],
  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  correctCount: { type: Number, default: 0 },
  wrongCount: { type: Number, default: 0 },
  unattemptedCount: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },

  timeTakenMinutes: { type: Number, default: 0 },
  submittedAt: { type: Date, default: Date.now },

  subjectBreakdown: [subjectBreakdownSchema],
  aiFeedback: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  testSeriesId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestSeries',
    required: false // Starting mein false rakho taaki purane tests break na hon
  },

  weakAreas: [{ type: String }], // Topics list ke liye
  deepAnalysis: [{
    qNo: Number,
    topic: String,
    questionText: String,
    analysis: String
  }],

  feedbackStatus: {
    type: String,
    enum: ['pending', 'generating', 'completed', 'failed'],
    default: 'pending'
  },

  schedulerFeedbackApplied: { type: Boolean, default: false },
}, {
  timestamps: true // createdAt aur updatedAt automatic mil jayenge
});
testAttemptSchema.index({ userId: 1, submittedAt: -1 });
const TestAttempt = mongoose.models.TestAttempt || mongoose.model('TestAttempt', testAttemptSchema);
export default TestAttempt;
