import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  priceId: String,
  duration: { type: Number, required: true },
  durationUnit: { type: String, enum: ['days', 'months', 'years'], default: 'months' },
  features: [String],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('SubscriptionPlan', subscriptionPlanSchema);