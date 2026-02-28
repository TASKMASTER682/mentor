import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },
  profile: {
    state: { type: String, default: '' },
    attemptYear: { type: Number, default: 2026 },
    dailyStudyHours: { type: Number, default: 8 },
    preferredSlots: [{
      label: String,
      startTime: String,
      endTime: String
    }],
    optionalSubject: { type: String, default: '' },
    fitnessGoal: { type: String, default: '' },
    scoreTargets: {
      essay: { type: Number, default: 140 },
      gs1: { type: Number, default: 120 },
      gs2: { type: Number, default: 110 },
      gs3: { type: Number, default: 110 },
      gs4: { type: Number, default: 150 },
      optional: { type: Number, default: 300 }
    }
  },
  stats: {
    studyStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    totalStudyDays: { type: Number, default: 0 },
    confidenceScore: { type: Number, default: 50 },
    weeklyProductivity: { type: Number, default: 0 },
    lastStudyDate: { type: Date }
  },
  createdAt: { type: Date, default: Date.now }
}, { minimize: false });

userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  try {
    this.password = await bcrypt.hash(this.password, 12);
  } catch (err) {
    console.error('Password hashing error:', err);
    throw err;
  }
});

userSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);
