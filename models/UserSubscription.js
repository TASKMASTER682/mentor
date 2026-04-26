import mongoose from 'mongoose';

const userSubscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
  planName: String,
  status: { 
    type: String, 
    enum: ['active', 'expired', 'cancelled', 'pending'], 
    default: 'active' 
  },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  autoRenew: { type: Boolean, default: false },
  paymentId: String,
  amount: Number,
  currency: { type: String, default: 'INR' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSubscriptionSchema.virtual('isExpired').get(function() {
  return new Date() > this.endDate;
});

userSubscriptionSchema.virtual('daysRemaining').get(function() {
  if (this.isExpired) return 0;
  const diff = this.endDate - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
});

userSubscriptionSchema.set('toJSON', { virtuals: true });

export default mongoose.model('UserSubscription', userSubscriptionSchema);