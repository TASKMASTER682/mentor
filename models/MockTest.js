import mongoose from 'mongoose';

const mockTestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  testSeriesId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestSeries', default: null },
  name:            { type: String, required: true },
  testType:        { type: String, enum: ['prelims_gs', 'prelims_csat', 'sectional', 'full_length'], default: 'prelims_gs' },
  totalQuestions:  { type: Number, default: 100 },
  durationMinutes: { type: Number, default: 120 },
  testPdfPath:     { type: String, required: true },   // streamed to iframe
  solutionPdfPath: { type: String, required: true },   // used only during processing
  testPdfName:     { type: String },
  solutionPdfName: { type: String },
  subject: { type: String, required: true }, // e.g., "Polity", "History"
  topics:  [{ type: String }],
  answerKey: { type: Map, of: String, default: new Map() },
  markCorrect:     { type: Number, default: 2.0 },
  markWrong:       { type: Number, default: -0.66 },
  markUnattempted: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['uploading', 'processing', 'ready', 'error'],
    default: 'uploading',
  },
  testPdfKey:     { type: String }, // Store Uploadthing Key for deletion
  solutionPdfKey: { type: String }, // Store Uploadthing Key for deletion
  processingError: { type: String, default: null },
  answerKeyCount:  { type: Number, default: 0 },
  
  // NEW: Store extracted question text for AI analysis
  questions: [{
    questionNumber: { type: Number, required: true },
    text: { type: String, default: "Text not available." },
    subject: { type: String, default: "General Studies" }
  }],
  questionTextExtractionStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },

  createdAt: { type: Date, default: Date.now },
});

mockTestSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('MockTest', mockTestSchema);

