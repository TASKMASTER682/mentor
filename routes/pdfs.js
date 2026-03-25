import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import PDF from '../models/PDF.js';
import LibrarySource from '../models/LibrarySource.js';
import { authenticate } from '../middleware/auth.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', 'uploads', 'pdfs');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

router.post('/upload', authenticate, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const pdf = new PDF({
      userId: req.user._id,
      name: req.body.name || req.file.originalname.replace(/\.pdf$/i, ''),
      subject: req.body.subject,
      year: req.body.year,
      fileName: req.file.originalname,
      filePath: `/uploads/pdfs/${req.file.filename}`,
      fileSize: req.file.size,
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
    const pdfs = await PDF.find({ userId: req.user._id })
      .sort({ createdAt: -1 });
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
    const pdf = await PDF.findOne({ 
      _id: req.params.id, 
      userId: req.user._id 
    });
    
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }
    
    res.json(pdf);
  } catch (error) {
    console.error('Error fetching PDF:', error);
    res.status(500).json({ message: 'Failed to fetch PDF' });
  }
});

router.get('/:id/file', authenticate, async (req, res) => {
  try {
    const pdf = await PDF.findOne({ 
      _id: req.params.id, 
      userId: req.user._id 
    });
    
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }

    const filePath = path.join(__dirname, '..', pdf.filePath);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.fileName}"`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
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
    
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }
    
    res.json(pdf);
  } catch (error) {
    console.error('Error updating PDF progress:', error);
    res.status(500).json({ message: 'Failed to update progress' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const pdf = await PDF.findOne({ 
      _id: req.params.id, 
      userId: req.user._id 
    });
    
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }

    const filePath = path.join(__dirname, '..', pdf.filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await PDF.findByIdAndDelete(req.params.id);
    res.json({ message: 'PDF deleted successfully' });
  } catch (error) {
    console.error('Error deleting PDF:', error);
    res.status(500).json({ message: 'Failed to delete PDF' });
  }
});

export default router;
