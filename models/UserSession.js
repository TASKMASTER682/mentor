import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true },
  deviceInfo: {
    userAgent: String,
    platform: String,
    language: String
  },
  ipAddress: String,
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

sessionSchema.index({ userId: 1 });
sessionSchema.index({ token: 1 });

export default mongoose.model('UserSession', sessionSchema);