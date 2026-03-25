import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  pdfId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PDF',
    required: true,
    index: true,
  },
  startTime: {
    type: Date,
    default: Date.now,
  },
  endTime: {
    type: Date,
  },
  duration: {
    type: Number,
    default: 0,
  },
  pagesRead: [{
    type: Number,
  }],
  startPage: {
    type: Number,
    default: 1,
  },
  endPage: {
    type: Number,
    default: 1,
  },
}, {
  timestamps: true,
});

sessionSchema.index({ userId: 1, pdfId: 1 });

export default mongoose.models.PDFReadingSession || mongoose.model('PDFReadingSession', sessionSchema);
