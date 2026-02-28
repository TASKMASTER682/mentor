import express from 'express';
import { authenticate } from '../middleware/auth.js';
import LibrarySource from '../models/LibrarySource.js';
import { aiService } from '../services/aiService.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const sources = await LibrarySource.find({ userId: req.user._id });
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, type, subject, syllabusText, chapters } = req.body;
    let parsedChapters = chapters || [];
    if (syllabusText && parsedChapters.length === 0) {
      parsedChapters = await aiService.parseSyllabus(syllabusText, subject);
      if (!Array.isArray(parsedChapters) || parsedChapters.length === 0) {
        return res.status(400).json({ error: 'Could not extract chapters from syllabus. Try manual chapters once.' });
      }
    }

    const source = new LibrarySource({
      userId: req.user._id, title, type, subject, syllabusText,
      chapters: parsedChapters,
      totalChapters: parsedChapters.length
    });

    await source.save();
    res.status(201).json(source);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/chapter/:chapterIndex', async (req, res) => {
  try {
    const { status, revisionCount } = req.body;
    const source = await LibrarySource.findOne({ _id: req.params.id, userId: req.user._id });
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const chIdx = parseInt(req.params.chapterIndex);
    if (status) source.chapters[chIdx].status = status;
    if (revisionCount !== undefined) source.chapters[chIdx].revisionCount = revisionCount;
    if (status === 'completed') {
      source.chapters[chIdx].lastRevised = new Date();
      source.completedChapters = source.chapters.filter(c => c.status === 'completed').length;
    }

    source.updatedAt = new Date();
    await source.save();
    res.json(source);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await LibrarySource.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

