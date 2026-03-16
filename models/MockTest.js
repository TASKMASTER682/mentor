import mongoose from 'mongoose';

const mockTestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  testSeriesId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestSeries', default: null },
  name: { type: String, required: true },
  testType: { type: String, enum: ['prelims_gs', 'prelims_csat', 'sectional', 'full_length'], default: 'prelims_gs' },
  totalQuestions: { type: Number, default: 100 },
  durationMinutes: { type: Number, default: 120 },
  testPdfPath: { type: String, required: true },   // streamed to iframe
  solutionPdfPath: { type: String, default: null },   // no longer needed after answer key extraction
  testPdfName: { type: String },
  solutionPdfName: { type: String },
  subject: { type: String, required: true }, // e.g., "Polity", "History"
  year: { type: Number }, // For sorting/filtering
  topics: [{ type: String }],
  answerKey: { type: Map, of: String, default: new Map() },
  markCorrect: { type: Number, default: 2.0 },
  markWrong: { type: Number, default: -0.66 },
  markUnattempted: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['uploading', 'processing', 'ready', 'error'],
    default: 'uploading',
  },
  testPdfKey: { type: String }, // Store Uploadthing Key for deletion
  solutionPdfKey: { type: String }, // Store Uploadthing Key for deletion
  processingError: { type: String, default: null },
  answerKeyCount: { type: Number, default: 0 },

  // NEW: Visual-Spatial Questions Storage (Spatial-First Architecture)
  questions: [{
    questionNumber: { type: Number, required: true },
    text: { type: String, default: "Text not available." },
    subject: { type: String, default: "General Studies" },
    topic: { type: String, default: null },
    imageUrl: { type: String, default: null },
    imageHash: { type: String, default: null }, // For deduplication
    boundingBox: {
      page: { type: Number, default: 1 },
      x1: { type: Number, default: 0 },
      y1: { type: Number, default: 0 },
      x2: { type: Number, default: 0 },
      y2: { type: Number, default: 0 }
    },
    correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
    status: { type: String, enum: ['active', 'archived'], default: 'active' }
  }],

  // Answer Key Caching
  answerKeyCacheHash: { type: String, default: null }, // Hash of answer key image for cache lookup
  answerKeyCached: { type: Boolean, default: false },
  questionTextExtractionStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },

  mode: {
    type: String,
    enum: ['structured', 'pdf'],
    default: 'pdf'
  },
  isActive: { type: Boolean, default: true },
  structuredQuestions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question'
  }],
  createdAt: { type: Date, default: Date.now },
});

mockTestSchema.index({ userId: 1, createdAt: -1 });
mockTestSchema.index({ subject: 1 });
mockTestSchema.index({ year: -1 });
mockTestSchema.index({ mode: 1 });

export default mongoose.model('MockTest', mockTestSchema);

