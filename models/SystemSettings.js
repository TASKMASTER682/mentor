import mongoose from 'mongoose';

const systemSettingsSchema = new mongoose.Schema({
  paymentMethod: { 
    type: String, 
    enum: ['razorpay', 'manual'], 
    default: 'manual' 
  },
  razorpayKeyId: { type: String, default: '' },
  razorpayKeySecret: { type: String, default: '' },
  telegramHandle: { type: String, default: '' },
  telegramLink: { type: String, default: '' },
  announcement: {
    text: { type: String, default: '' },
    isActive: { type: Boolean, default: false },
    type: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' }
  },
  globalDiscount: {
    percentage: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    code: { type: String, default: '' }
  },
  updatedAt: { type: Date, default: Date.now }
});

export const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);
