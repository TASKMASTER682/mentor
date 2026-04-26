import mongoose from 'mongoose';

const videoProgressSchema = new mongoose.Schema({
  videoId: { type: String, required: true },
  completed: { type: Boolean, default: false },
  completedAt: Date,
  watchTime: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
  lastViewedAt: Date
});

const userCourseProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'YouTubeCourse', required: true },
  videos: [videoProgressSchema],
  lastWatchedVideoId: { type: String, default: null },
  lastWatchedAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: Date.now },
  completedAt: Date
});

userCourseProgressSchema.virtual('progressPercentage').get(function() {
  if (this.videos.length === 0) return 0;
  const completed = this.videos.filter(v => v.completed).length;
  return Math.round((completed / this.videos.length) * 100);
});

userCourseProgressSchema.virtual('completedVideos').get(function() {
  return this.videos.filter(v => v.completed).length;
});

userCourseProgressSchema.set('toJSON', { virtuals: true });

export default mongoose.model('UserCourseProgress', userCourseProgressSchema);
