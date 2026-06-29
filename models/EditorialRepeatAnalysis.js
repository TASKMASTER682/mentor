import mongoose from 'mongoose';

const topicLinkSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    link: { type: String, required: true },
    sourceKey: { type: String, default: '' }
  },
  { _id: false }
);

const repeatResultSchema = new mongoose.Schema(
  {
    topicLabel: { type: String, required: true },
    repeatCount: { type: Number, required: true, default: 0 },
    comprehensiveLinks: { type: [topicLinkSchema], default: [] },
    rationale: { type: String, default: '' }
  },
  { _id: false }
);

const editorialRepeatAnalysisSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  generatedForDateKey: { type: String, required: true }, // the “latest” dateKey used as anchor
  windowType: { type: String, enum: ['7d', '1m', '6m', 'gt6m'], required: true },
  rulesApplied: { type: Object, default: {} },

  results: { type: [repeatResultSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

editorialRepeatAnalysisSchema.pre('save', async function () {
  this.updatedAt = new Date();
});

export default mongoose.model('EditorialRepeatAnalysis', editorialRepeatAnalysisSchema);
