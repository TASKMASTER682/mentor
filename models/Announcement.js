import mongoose from 'mongoose';

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['info', 'alert', 'discount', 'update'], default: 'info' },
  isActive: { type: Boolean, default: true },
  expiryDate: Date,
  createdAt: { type: Date, default: Date.now }
});

export const Announcement = mongoose.model('Announcement', announcementSchema);
