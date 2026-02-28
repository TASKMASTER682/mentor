import mongoose from 'mongoose';

const chapterSchema = new mongoose.Schema({
  title: String,
  status: { type: String, enum: ['not_started', 'ongoing', 'completed'], default: 'not_started' },
  revisionCount: { type: Number, default: 0 },
  lastRevised: Date,
  estimatedHours: { type: Number, default: 2 },
  notes: String
});

const librarySourceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  type: { type: String, enum: ['book', 'notes', 'coaching', 'test_series', 'video'], required: true },
  subject: { type: String, required: true },
  chapters: [chapterSchema],
  totalChapters: { type: Number, default: 0 },
  completedChapters: { type: Number, default: 0 },
  revisionCount: { type: Number, default: 0 },
  priority: { type: Number, default: 5 },
  syllabusText: String,
  addedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

librarySourceSchema.virtual('completionPercentage').get(function() {
  if (this.totalChapters === 0) return 0;
  return Math.round((this.completedChapters / this.totalChapters) * 100);
});

librarySourceSchema.set('toJSON', { virtuals: true });

export default mongoose.model('LibrarySource', librarySourceSchema);