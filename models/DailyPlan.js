import mongoose from 'mongoose';

const planTaskSchema = new mongoose.Schema({
  taskName: { type: String, required: true },
  optionalTarget: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const dailyLogSchema = new mongoose.Schema({
  date: { type: String, required: true },
  taskId: { type: String, default: '' },
  taskName: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  completedAt: { type: Date, default: null }
});

const dailyPlanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planName: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  tasks: [planTaskSchema],
  dailyLogs: [dailyLogSchema],
  status: { type: String, enum: ['active', 'completed', 'archived'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

dailyPlanSchema.index({ userId: 1, startDate: 1, endDate: 1 });

export default mongoose.model('DailyPlan', dailyPlanSchema);