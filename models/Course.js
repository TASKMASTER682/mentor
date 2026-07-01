import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  thumbnail: String,
  subject: { type: String, default: '' },
  category: { type: String, default: 'General' },
  instructor: { type: String, default: '' },
  price: { type: Number, default: 0 },
  discountPrice: { type: Number, default: null }, // If null, no discount
  discountExpiry: { type: Date, default: null },
  isPremium: { type: Boolean, default: true },
  isPublished: { type: Boolean, default: false },
  maxViews: { type: Number, default: 2 },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const lessonSchema = new mongoose.Schema({
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  title: { type: String, required: true },
  description: String,
  videoId: { type: String }, // YouTube video ID (legacy)
  telegramChannel: { type: String }, // Telegram channel username or chat ID
  telegramMsgId: { type: String }, // Telegram message/post ID
  thumbnail: String,
  duration: String,
  durationSeconds: { type: Number, default: 0 },
  order: { type: Number, default: 0 },
  maxViews: { type: Number, default: null }, // Null means use course default
  isPreview: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

courseSchema.virtual('lessonCount').get(function() {
  return this.lessons?.length || 0;
});

courseSchema.set('toJSON', { virtuals: true });
lessonSchema.set('toJSON', { virtuals: true });

export const Course = mongoose.model('Course', courseSchema);
export const Lesson = mongoose.model('Lesson', lessonSchema);