import mongoose from 'mongoose';

const testAttemptSchema = new mongoose.Schema({
  testName: String,
  date: Date,
  score: Number,
  totalMarks: Number,
  percentage: Number,
  weakTopics: [String],
  strongTopics: [String],
  timeSpent: Number, // minutes
  notes: String
});

const testSeriesSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  provider: String,
  type: { type: String, enum: ['prelims_gs', 'prelims_csat', 'mains_gs', 'sectional', 'full_length', 'optional'], required: true },
  totalTests: Number,
  isActive: { type: Boolean, default: true },
  attempts: [testAttemptSchema],
  nextRecommendedDate: Date,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('TestSeries', testSeriesSchema);