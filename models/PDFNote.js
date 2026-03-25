import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
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
  },
  highlightId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PDFHighlight',
    required: true,
  },
  pageNumber: {
    type: Number,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

noteSchema.index({ highlightId: 1 });

export default mongoose.models.PDFNote || mongoose.model('PDFNote', noteSchema);
