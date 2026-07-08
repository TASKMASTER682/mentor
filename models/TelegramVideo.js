import mongoose from 'mongoose';

const telegramVideoSchema = new mongoose.Schema({
  channel: { type: String, required: true },
  msgId: { type: String, required: true },
  fileId: { type: String, required: true },
  accessHash: { type: String, required: true },
  fileReference: { type: Buffer, required: true },
  size: { type: Number, required: true },
  mimeType: { type: String, default: 'video/mp4' },
  duration: { type: Number, default: 0 },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  dcId: { type: Number },
}, { timestamps: true });

telegramVideoSchema.index({ channel: 1, msgId: 1 }, { unique: true });

export default mongoose.model('TelegramVideo', telegramVideoSchema);
