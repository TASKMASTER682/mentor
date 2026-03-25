import express from 'express';
import PDF from '../models/PDF.js';
import LibrarySource from '../models/LibrarySource.js';
import { authenticate } from '../middleware/auth.js';
import { UTApi } from 'uploadthing/server';
import { File } from 'node:buffer';

const router = express.Router();
const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

router.post('/upload', authenticate, async (req, res) => {
  try {
    const { name, subject, year, fileName, fileData, fileSize } = req.body;

    if (!fileData) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    if (fileSize > 20 * 1024 * 1024) {
      return res.status(400).json({ message: 'File too large. Max 20MB allowed' });
    }

    console.log('[PDF Upload] File:', fileName, 'Size:', fileSize);

    const buffer = Buffer.from(fileData, 'base64');
    const pdfFile = new File([buffer], fileName || 'document.pdf', { type: 'application/pdf' });

    const uploadResponse = await utapi.uploadFiles([pdfFile]);
    const uploadResult = uploadResponse[0];

    if (!uploadResult.data) {
      console.error('[PDF Upload] UploadThing failed:', uploadResult.error);
      return res.status(500).json({ message: 'Upload failed' });
    }

    const pdf = new PDF({
      userId: req.user._id,
      name: name || fileName?.replace(/\.pdf$/i, ''),
      subject,
      year,
      fileName: fileName || 'document.pdf',
      filePath: uploadResult.data.ufsUrl,
      fileSize,
    });

    await pdf.save();
    res.json(pdf);
  } catch (error) {
    console.error('Error uploading PDF:', error);
    res.status(500).json({ message: 'Failed to upload PDF' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const pdfs = await PDF.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(pdfs);
  } catch (error) {
    console.error('Error fetching PDFs:', error);
    res.status(500).json({ message: 'Failed to fetch PDFs' });
  }
});

router.get('/subjects', authenticate, async (req, res) => {
  try {
    const sources = await LibrarySource.find({ userId: req.user._id });
    const subjects = [...new Set(sources.map(s => s.subject).filter(Boolean))].sort();
    res.json(subjects);
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ message: 'Failed to fetch subjects' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const pdf = await PDF.findOne({ _id: req.params.id, userId: req.user._id });
    if (!pdf) return res.status(404).json({ message: 'PDF not found' });
    res.json(pdf);
  } catch (error) {
    console.error('Error fetching PDF:', error);
    res.status(500).json({ message: 'Failed to fetch PDF' });
  }
});

router.get('/:id/file', authenticate, async (req, res) => {
  try {
    const pdf = await PDF.findOne({ _id: req.params.id, userId: req.user._id });
    if (!pdf) return res.status(404).json({ message: 'PDF not found' });

    if (pdf.filePath.startsWith('http')) {
      return res.redirect(pdf.filePath);
    }

    return res.status(404).json({ message: 'File not found' });
  } catch (error) {
    console.error('Error serving PDF:', error);
    res.status(500).json({ message: 'Failed to serve PDF' });
  }
});

router.patch('/:id/progress', authenticate, async (req, res) => {
  try {
    const { totalTimeSpent, lastReadDate, lastPageRead, isCompleted, averageReadingSpeed } = req.body;
    const pdf = await PDF.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      {
        ...(totalTimeSpent !== undefined && { totalTimeSpent }),
        ...(lastReadDate && { lastReadDate }),
        ...(lastPageRead && { lastPageRead }),
        ...(isCompleted !== undefined && { isCompleted }),
        ...(averageReadingSpeed !== undefined && { averageReadingSpeed }),
      },
      { new: true }
    );
    if (!pdf) return res.status(404).json({ message: 'PDF not found' });
    res.json(pdf);
  } catch (error) {
    console.error('Error updating PDF progress:', error);
    res.status(500).json({ message: 'Failed to update progress' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const pdf = await PDF.findOne({ _id: req.params.id, userId: req.user._id });
    if (!pdf) return res.status(404).json({ message: 'PDF not found' });

    if (pdf.filePath.includes('uploadthing')) {
      try {
        const key = pdf.filePath.split('/').pop();
        await utapi.deleteFiles(key);
      } catch (e) {
        console.error('Failed to delete from UploadThing:', e);
      }
    }

    await PDF.findByIdAndDelete(req.params.id);
    res.json({ message: 'PDF deleted successfully' });
  } catch (error) {
    console.error('Error deleting PDF:', error);
    res.status(500).json({ message: 'Failed to delete PDF' });
  }
});

export default router;
