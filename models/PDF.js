import mongoose from 'mongoose';

const pdfSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  subject: {
    type: String,
    trim: true,
  },
  year: {
    type: String,
    trim: true,
  },
  fileName: {
    type: String,
    required: true,
  },
  filePath: {
    type: String,
    required: true,
  },
  fileSize: {
    type: Number,
  },
  pageCount: {
    type: Number,
    default: 0,
  },
  totalTimeSpent: {
    type: Number,
    default: 0,
  },
  lastReadDate: {
    type: Date,
  },
  lastPageRead: {
    type: Number,
    default: 1,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
  averageReadingSpeed: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

pdfSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.PDF || mongoose.model('PDF', pdfSchema);
