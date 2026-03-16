import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  videoId: { type: String, required: true },
  title: { type: String, required: true },
  description: String,
  thumbnail: String,
  duration: String,
  durationSeconds: Number,
  position: { type: Number, default: 0 }
});

const youtubeCourseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  youtubeId: { type: String, required: true },
  type: { type: String, enum: ['video', 'playlist'], required: true },
  title: { type: String, required: true },
  description: String,
  thumbnail: String,
  channelName: String,
  videos: [videoSchema],
  totalVideos: { type: Number, default: 0 },
  subject: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

youtubeCourseSchema.virtual('videoCount').get(function() {
  return this.videos.length;
});

youtubeCourseSchema.set('toJSON', { virtuals: true });

export default mongoose.model('YouTubeCourse', youtubeCourseSchema);
