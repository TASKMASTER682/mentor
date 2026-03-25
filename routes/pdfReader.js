import express from 'express';
import PDFHighlight from '../models/PDFHighlight.js';
import PDFNote from '../models/PDFNote.js';
import PDFReadingSession from '../models/PDFReadingSession.js';
import PDF from '../models/PDF.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.post('/highlight', authenticate, async (req, res) => {
  try {
    const { pdfId, pageNumber, highlightType, color, text, position, path } = req.body;

    const highlight = new PDFHighlight({
      userId: req.user._id,
      pdfId,
      pageNumber,
      highlightType: highlightType || 'text',
      color: color || 'yellow',
      text: text || '',
      position,
      path,
    });

    await highlight.save();
    res.json(highlight);
  } catch (error) {
    console.error('Error creating highlight:', error);
    res.status(500).json({ error: 'Failed to create highlight' });
  }
});

router.get('/highlights/:userId/:pdfId', authenticate, async (req, res) => {
  try {
    const { userId, pdfId } = req.params;

    const authUserId = req.user._id.toString();
    
    if (authUserId !== userId && authUserId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const highlights = await PDFHighlight.find({ userId: authUserId, pdfId })
      .sort({ pageNumber: 1, createdAt: 1 });

    for (let h of highlights) {
      h.notes = await PDFNote.find({ highlightId: h._id }).sort({ createdAt: 1 });
    }

    res.json(highlights);
  } catch (error) {
    console.error('Error fetching highlights:', error);
    res.status(500).json({ error: 'Failed to fetch highlights' });
  }
});

router.delete('/highlight/:id', authenticate, async (req, res) => {
  try {
    const highlight = await PDFHighlight.findOneAndDelete({ 
      _id: req.params.id, 
      userId: req.user._id 
    });

    if (!highlight) {
      return res.status(404).json({ error: 'Highlight not found' });
    }

    await PDFNote.deleteMany({ highlightId: req.params.id });
    res.json({ message: 'Highlight deleted' });
  } catch (error) {
    console.error('Error deleting highlight:', error);
    res.status(500).json({ error: 'Failed to delete highlight' });
  }
});

router.post('/note', authenticate, async (req, res) => {
  try {
    const { pdfId, highlightId, pageNumber, content } = req.body;

    const note = new PDFNote({
      userId: req.user._id,
      pdfId,
      highlightId,
      pageNumber,
      content,
    });

    await note.save();
    res.json(note);
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

router.delete('/note/:id', authenticate, async (req, res) => {
  try {
    const note = await PDFNote.findOneAndDelete({ 
      _id: req.params.id, 
      userId: req.user._id 
    });

    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ message: 'Note deleted' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

router.post('/session/start', authenticate, async (req, res) => {
  try {
    const { pdfId, startPage } = req.body;

    let session = await PDFReadingSession.findOne({
      userId: req.user._id,
      pdfId,
      endTime: { $exists: false },
    });

    if (session) {
      return res.json(session);
    }

    session = new PDFReadingSession({
      userId: req.user._id,
      pdfId,
      startPage: startPage || 1,
      pagesRead: [startPage || 1],
    });

    await session.save();
    res.json(session);
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

router.post('/session/update', authenticate, async (req, res) => {
  try {
    const { pdfId, currentPage, totalTimeSpent, averageReadingSpeed, pagesRead } = req.body;

    await PDF.findOneAndUpdate(
      { _id: pdfId, userId: req.user._id },
      { 
        lastReadDate: new Date(),
        lastPageRead: currentPage,
        ...(totalTimeSpent !== undefined && { totalTimeSpent }),
        ...(averageReadingSpeed !== undefined && { averageReadingSpeed }),
      }
    );

    const session = await PDFReadingSession.findOneAndUpdate(
      { userId: req.user._id, pdfId, endTime: { $exists: false } },
      { 
        endPage: currentPage,
        ...(pagesRead && { pagesRead: { $addToSet: { $each: pagesRead } } }),
      },
      { new: true }
    );

    res.json(session || { success: true });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

router.post('/session/end', authenticate, async (req, res) => {
  try {
    const { pdfId } = req.body;

    const session = await PDFReadingSession.findOneAndUpdate(
      { userId: req.user._id, pdfId, endTime: { $exists: false } },
      { endTime: new Date() },
      { new: true }
    );

    if (session) {
      const duration = Math.round((session.endTime - session.startTime) / 1000);
      await PDF.findOneAndUpdate(
        { _id: pdfId, userId: req.user._id },
        { $inc: { totalTimeSpent: duration } }
      );
    }

    res.json(session || { success: true });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

router.get('/session/:userId/:pdfId', authenticate, async (req, res) => {
  try {
    const { userId, pdfId } = req.params;

    if (req.user._id.toString() !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const sessions = await PDFReadingSession.find({ userId, pdfId }).sort({ startTime: -1 });
    const pdf = await PDF.findOne({ _id: pdfId, userId });
    
    res.json({
      sessions,
      totalTimeSpent: pdf?.totalTimeSpent || 0,
      lastPageRead: pdf?.lastPageRead || 1,
      averageReadingSpeed: pdf?.averageReadingSpeed || 0,
      isCompleted: pdf?.isCompleted || false,
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

export default router;
