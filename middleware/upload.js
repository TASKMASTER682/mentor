import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Folder name 'temp_uploads' kar diya (Deployment safe)
const uploadDir = path.join(__dirname, '..', 'temp_uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  // 2. Sirf ek destination rakha hai (Clean code)
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${unique}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    // Check file size - reject files over 6MB
    if (file.size > 6 * 1024 * 1024) {
      cb(new Error('File size must be under 6MB'), false);
    } else {
      cb(null, true);
    }
  } else {
    // 3. Error message ko thoda friendly banaya
    cb(new Error('Only PDF files are allowed'), false);
  }
};

export const uploadPDFs = multer({
  storage,
  fileFilter,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB limit
}).fields([
  { name: 'testPdf', maxCount: 1 },
]);

export const uploadDir_ = uploadDir;