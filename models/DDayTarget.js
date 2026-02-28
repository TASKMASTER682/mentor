import mongoose from 'mongoose';

const dDayTargetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  targetName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  },
  targetDate: {
    type: Date,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 },
  },
}, {
  timestamps: true,
});

dDayTargetSchema.index({ userId: 1, createdAt: -1 });

const DDayTarget = mongoose.models.DDayTarget || mongoose.model('DDayTarget', dDayTargetSchema);

export default DDayTarget;

