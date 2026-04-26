import mongoose from 'mongoose';

const userCourseEnrollmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  pricePaid: { type: Number, required: true },
  paymentId: String,
  status: { 
    type: String, 
    enum: ['pending', 'completed', 'cancelled', 'refunded'], 
    default: 'completed' 
  },
  enrolledAt: { type: Date, default: Date.now },
  expiresAt: Date
});

userCourseEnrollmentSchema.index({ userId: 1, courseId: 1 }, { unique: true });

export default mongoose.model('UserCourseEnrollment', userCourseEnrollmentSchema);