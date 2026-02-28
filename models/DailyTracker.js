import mongoose from 'mongoose';

const taskItemSchema = new mongoose.Schema({
  subject: String,
  topic: String,
  taskType: { type: String, enum: ['learning', 'revision', 'answer_writing', 'mcq', 'test'] },
  status: { type: String, enum: ['completed', 'partial', 'skipped'], default: 'skipped' },
  plannedHours: Number,
  actualHours: { type: Number, default: 0 }
});

const dailyTrackerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: Date, required: true },
  tasks: [taskItemSchema],
  focusScore: { type: Number, min: 1, max: 10 },
  energyLevel: { type: String, enum: ['low', 'medium', 'high'] },
  mood: { type: String, enum: ['stressed', 'neutral', 'motivated', 'burnt_out', 'confident'] },
  notesPrepared: { type: Boolean, default: false },
  topicsNotUnderstood: [String],
testsAttempted: [{ 
  type: mongoose.Schema.Types.ObjectId, 
  ref: 'MockTest' 
}],
  totalStudyHours: { type: Number, default: 0 },
  completionRate: { type: Number, default: 0 }, // percentage
  notes: String,
  aiInsight: String,
  submittedAt: { type: Date, default: Date.now }
});

dailyTrackerSchema.index({ userId: 1, date: -1 });

export default mongoose.model('DailyTracker', dailyTrackerSchema);