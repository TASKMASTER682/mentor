import mongoose from 'mongoose';

const prelimsItemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  runDateKey: { type: String, required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  link: { type: String, default: '' },
  sourceKey: { type: String, default: 'vajiram-prelims' },
  contentHtml: { type: String, default: '' },
  scrapedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

prelimsItemSchema.pre('save', async function () {
  this.updatedAt = new Date();
});

export default mongoose.model('PrelimsItem', prelimsItemSchema);
