import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
    questionNumber: { type: Number, required: true },
    text: { type: String, required: true, unique: true }, // For exact match duplicate detection
    options: {
        a: { type: String, required: true },
        b: { type: String, required: true },
        c: { type: String, required: true },
        d: { type: String, required: true }
    },
    correctAnswer: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
    explanation: { type: String, default: "" },
    subject: { type: String },
    year: { type: Number },
    topics: [{ type: String }],
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Index for faster lookups and text searching
questionSchema.index({ text: 'text' });
questionSchema.index({ questionNumber: 1 });

const Question = mongoose.models.Question || mongoose.model('Question', questionSchema);
export default Question;
