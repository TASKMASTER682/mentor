import mongoose from 'mongoose';

const scheduleBlockSchema = new mongoose.Schema({
  startTime: String,
  endTime: String,
  subject: String,
  topic: String,
  taskType: { type: String, enum: ['learning', 'revision', 'answer_writing', 'mcq', 'test', 'break', 'fitness'] },
  duration: Number, // minutes (planned)
  priority: { type: String, enum: ['high', 'medium', 'low'] },
  missionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mission' },
  sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibrarySource' },
  chapterIndex: Number,
  notes: String,
  completed: { type: Boolean, default: false },
  completedAt: { type: Date },
  timeSpent: { type: Number, default: 0 }, // minutes actually spent
  timerStartedAt: { type: Date } // when user started the timer
});

const scheduleSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: Date, required: true },
  blocks: [scheduleBlockSchema],
  totalPlannedHours: Number,
  generatedBy: { type: String, enum: ['ai', 'manual'], default: 'ai' },
  aiRationale: String,
  refinementCount: { type: Number, default: 0 },
  refinementNotes: [{
    instruction: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now }
  }],
  activeMissions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Mission' }],
  createdAt: { type: Date, default: Date.now }
});

scheduleSchema.index({ userId: 1, date: 1 }, { unique: true });

export default mongoose.model('Schedule', scheduleSchema);
