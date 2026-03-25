import mongoose from 'mongoose';

const highlightSchema = new mongoose.Schema({
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
  pageNumber: {
    type: Number,
    required: true,
  },
  highlightType: {
    type: String,
    enum: ['text', 'area', 'freehand'],
    default: 'text',
  },
  color: {
    type: String,
    default: 'yellow',
  },
  text: {
    type: String,
    default: '',
  },
  position: {
    x: Number,
    y: Number,
    width: Number,
    height: Number,
    rects: [Number],
  },
  path: {
    type: String,
  },
}, {
  timestamps: true,
});

highlightSchema.index({ userId: 1, pdfId: 1 });
highlightSchema.index({ pdfId: 1, pageNumber: 1 });

export default mongoose.models.PDFHighlight || mongoose.model('PDFHighlight', highlightSchema);
