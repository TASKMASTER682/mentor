import mongoose from 'mongoose';

const editorialScrapeRunSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  runDateKey: { type: String, required: true }, // YYYY-MM-DD
  sourcesKey: { type: String, required: true }, // e.g. 'hindu+govt'
  itemLimitTotal: { type: Number, default: 6 },
  fetchedCount: { type: Number, default: 0 },
  savedCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

editorialScrapeRunSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('EditorialScrapeRun', editorialScrapeRunSchema);
