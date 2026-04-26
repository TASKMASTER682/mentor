import mongoose from 'mongoose';

const missionTaskOldSchema = new mongoose.Schema({
  date: Date,
  chapters: [String],
  estimatedHours: Number,
  completed: { type: Boolean, default: false },
  completedHours: { type: Number, default: 0 }
});

const missionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  targetType: { 
    type: String, 
    enum: ['hours', 'units'], 
    default: 'hours' 
  },
  totalTarget: { type: Number, required: true },
  completedValue: { type: Number, default: 0 },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['active', 'completed', 'paused', 'failed'], default: 'active' },
  priority: { type: Number, default: 1 },
  completedAt: Date,
  missedDays: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

missionSchema.virtual('remainingValue').get(function() {
  return Math.max(0, this.totalTarget - this.completedValue);
});

missionSchema.virtual('remainingDays').get(function() {
  const now = new Date();
  const diff = this.endDate - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

missionSchema.virtual('dailyRequired').get(function() {
  const remaining = this.totalTarget - this.completedValue;
  const days = this.remainingDays;
  if (days <= 0 || remaining <= 0) return 0;
  return remaining / days;
});

missionSchema.virtual('progressPercent').get(function() {
  if (this.totalTarget === 0) return 0;
  return Math.round((this.completedValue / this.totalTarget) * 100);
});

missionSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Mission', missionSchema);