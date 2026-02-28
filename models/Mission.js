import mongoose from 'mongoose';

const missionTaskSchema = new mongoose.Schema({
  date: Date,
  chapters: [String],
  estimatedHours: Number,
  completed: { type: Boolean, default: false },
  completedHours: { type: Number, default: 0 }
});

const missionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  description: String,
  deadline: { type: Date, required: true },
  startDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['active', 'completed', 'paused', 'failed'], default: 'active' },
  totalChapters: { type: Number, default: 0 },
  completedChapters: { type: Number, default: 0 },
  dailyPlan: [missionTaskSchema],
  totalHoursNeeded: { type: Number, default: 0 },
  dailyHoursRequired: { type: Number, default: 0 },
  priority: { type: Number, default: 1 }, // Lower = higher priority (LIFO)
  warningIssued: { type: Boolean, default: false },
  completedAt: Date,
  aiStrategy: String,
  missedDays: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

missionSchema.virtual('daysRemaining').get(function() {
  const now = new Date();
  const diff = this.deadline - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

missionSchema.virtual('progressPercentage').get(function() {
  if (this.totalChapters === 0) return 0;
  return Math.round((this.completedChapters / this.totalChapters) * 100);
});

missionSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Mission', missionSchema);