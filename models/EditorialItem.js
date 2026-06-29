import mongoose from 'mongoose';

const editorialItemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  runDateKey: { type: String, required: true }, // YYYY-MM-DD (based on RSS pubDate)
  sourcesKey: { type: String, required: true }, // e.g. 'hindu+govt'
  sourceKey: { type: String, required: true }, // e.g. 'thehindu', 'pib'
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  link: { type: String, required: true },
  publishedAt: { type: Date, default: null },
  extractedAt: { type: Date, default: Date.now },
  fingerprint: { type: String, default: '' }, // optional for de-dupe

  speechContent: { type: String, default: '' },
  keyPointersContent: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

editorialItemSchema.pre('save', async function () {
  this.updatedAt = new Date();
});

export default mongoose.model('EditorialItem', editorialItemSchema);
