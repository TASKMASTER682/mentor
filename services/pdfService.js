import fs from 'fs';
import path from 'path';
import axios from 'axios';
import PDFParser from 'pdf2json';
import { fileURLToPath } from 'url';
import decompress from 'decompress';
import { pdfToImg } from "pdftoimg-js";
import { UTApi } from "uploadthing/server";
import { File } from "node:buffer"; // SDK v7 compatibility
import Tesseract from 'tesseract.js';


const utapi = new UTApi();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * HELPER: Ye function ensure karega ki aapke AI logic ko hamesha local file mile.
 * Agar input URL hai, toh ye use temporary download kar lega.
 */
async function ensureLocalPath(filePathOrUrl) {
    if (!filePathOrUrl.startsWith('http')) return filePathOrUrl;

    console.log("[SERVICE] URL detected, downloading for AI analysis...");
    const tempDir = path.join(__dirname, '../temp_uploads/tmp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempPath = path.join(tempDir, `ai_proc_${Date.now()}.pdf`);
    const response = await axios({ url: filePathOrUrl, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}

// ========================== UPLOAD LOGIC ==========================

export async function uploadFileToUploadthing(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;

        // No compression - files under 6MB are uploaded directly
        const finalPath = filePath;
        const fileBuffer = fs.readFileSync(finalPath);
        const fileName = path.basename(finalPath);
        
        // Upload to Uploadthing
        const response = await utapi.uploadFiles([
            new File([fileBuffer], fileName, { type: "application/pdf" }),
        ]);

        const uploadResult = response[0];
        if (uploadResult.data) {
            // Local files delete karein jab upload success ho
            try { fs.unlinkSync(finalPath); } catch (e) {}
            if (finalPath !== filePath) {
                try { fs.unlinkSync(filePath); } catch (e) {}
            }
            
            return {
                url: uploadResult.data.ufsUrl || uploadResult.data.url,
                key: uploadResult.data.key
            };
        }
        return null;
    } catch (error) {
        console.error("[Upload Error]:", error);
        return null;
    }
}

export async function uploadOnlyToUploadthing(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const response = await utapi.uploadFiles([
            new File([fileBuffer], fileName, { type: "application/pdf" }),
        ]);
        return response[0].data?.ufsUrl || null;
    } catch (error) {
        return null;
    }
}

// ========================== AI DATA EXTRACTION (NO LOGIC CHANGE) ==========================

export async function extractPdfText(filePathOrUrl) {
    const localPath = await ensureLocalPath(filePathOrUrl);
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser(null, 1);
        pdfParser.on("pdfParser_dataError", (errData) => reject(errData.parserError));
        pdfParser.on("pdfParser_dataReady", () => {
            const rawText = pdfParser.getRawTextContent();
            // Cleanup if it was a temp download
            if (filePathOrUrl.startsWith('http') && fs.existsSync(localPath)) {
                try { fs.unlinkSync(localPath); } catch (e) {}
            }
            resolve(rawText || '');
        });
        pdfParser.loadPDF(localPath);
    });
}


// export async function extractQuestionPaperMap(filePathOrUrl) {
//     console.log("[Arjun OCR] Starting Rough OCR Extraction...");
//     try {
//         // Tesseract ko image/buffer pass karein
//         // Yahan hum man kar chal rahe hain ki aapne PDF page ko image mein convert kar liya hai
//         const { data: { text } } = await Tesseract.recognize(
//             filePathOrUrl,
//             'eng',
//             { logger: m => console.log(m.status + ": " + Math.round(m.progress * 100) + "%") }
//         );

//         // --- ROUGH REGEX LOGIC ---
//         // Ye regex 'Q.1)', 'Q.2)', 'Q 1.' jaise patterns dhundega [cite: 41, 47, 108]
//         const questionBlocks = text.split(/(?=Q\s*[\.\d]+\s*[\)\.])/gi);
        
//         const questionMap = {};
//         questionBlocks.forEach(block => {
//             const match = block.match(/Q\s*[\.\s]*(\d+)[\s\)\.]+(.*)/si);
//             if (match) {
//                 const qNo = match[1];
//                 let content = match[2]
//                     .replace(/\n+/g, ' ') // Lines ko ek sath jodo
//                     .replace(/\s\s+/g, ' ') // Extra spaces hatao
//                     .trim();
                
//                 if (content.length > 5) {
//                     questionMap[qNo] = content;
//                 }
//             }
//         });

//         console.log(`[Arjun OCR] Success! Found ${Object.keys(questionMap).length} questions.`);
//         return questionMap;

//     } catch (err) {
//         console.error("[Arjun OCR] Error during OCR:", err);
//         return {}; // Fail hone par khali map bhejo taaki AI crash na ho
//     }
// }

export async function extractQuestionPaperMap(pdfBufferOrPages) {
    console.log("[Arjun OCR] Starting Sequential Page Processing...");
    
    // Final object jisme saare pages ke questions merge honge
    const finalQuestionMap = {};
    const worker = await Tesseract.createWorker('eng');

    try {
        await worker.setParameters({
            tessedit_pageseg_mode: '3', // Auto segmentation har page ke liye
        });

        // 1. Pages Array handle karo (Starting from Page 2 as you requested)
        // Note: Array 0-indexed hota hai, toh Page 2 = index 1
        const pages = Array.isArray(pdfBufferOrPages) ? pdfBufferOrPages : [pdfBufferOrPages];
        
        console.log(`[Arjun OCR] Total pages detected: ${pages.length}. Starting from Page 2...`);

        for (let i = 1; i < pages.length; i++) {
            console.log(`[Arjun OCR] Processing Page ${i + 1}...`);
            
            // Ek waqt mein sirf ek page ka OCR
            const { data: { text } } = await worker.recognize(pages[i]);

            // 2. Regex for Question Extraction
            // Pattern: [Q/0/O/Cl] followed by [Number] followed by [. / ) / Space]
            const qRegex = /(?:^|\n|\s)(?:Q|0|O|Cl)[\s\.]*(\d{1,3})[\s\)\.]([\s\S]*?)(?=(?:\n\s*(?:Q|0|O|Cl)[\s\.]*\d{1,3}[\s\)\.])|$)/gi;

            let match;
            let pageCount = 0;

            while ((match = qRegex.exec(text)) !== null) {
                const qNo = parseInt(match[1]);
                let content = match[2]
                    .replace(/\n+/g, ' ')
                    .replace(/\s\s+/g, ' ')
                    .trim();

                // 3. Validation & Merging
                if (qNo > 0 && qNo <= 100 && content.length > 15) {
                    // Agar question pehle mil chuka hai (overlap), toh bada content rakho
                    if (!finalQuestionMap[qNo] || content.length > finalQuestionMap[qNo].length) {
                        finalQuestionMap[qNo] = content;
                        pageCount++;
                    }
                }
            }
            console.log(`[Arjun OCR] Page ${i + 1} done. Found ${pageCount} new/updated questions.`);
        }

        await worker.terminate();
        
        const totalFound = Object.keys(finalQuestionMap).length;
        console.log(`[Arjun OCR] Extraction Complete! Total Unique Questions: ${totalFound}`);
        
        return finalQuestionMap;

    } catch (err) {
        console.error("[Arjun OCR] Error in Sequential Scan:", err);
        if (worker) await worker.terminate();
        return finalQuestionMap; // Jitne mil gaye utne toh return karo
    }
}

export async function extractAnswerKeyFromSolutionPdf(solutionPdfPathOrUrl) {
    try {
        const rawText = await extractPdfText(solutionPdfPathOrUrl);
        const regexParsed = {};
        const pattern = /(\d{1,3})\s*[\.\-\)]?\s*([A-D])/g;
        let match;
        while ((match = pattern.exec(rawText)) !== null) {
            regexParsed[match[1]] = match[2];
        }
        return { regexParsed, answerKeySection: rawText.substring(0, 5000) };
    } catch (e) { return { regexParsed: {}, answerKeySection: "" }; }
}

// ========================== VIEWING LOGIC ==========================





export async function streamPdfToResponse(filePathOrUrl, req, res) {
    try {
        let targetUrl = null;

        // --- STEP 1: Identification ---
        if (filePathOrUrl && filePathOrUrl.startsWith('http')) {
            targetUrl = filePathOrUrl;
        }

        // --- STEP 2: Local Check (With Fallback Logic) ---
        if (!targetUrl) {
            const absolutePath = path.isAbsolute(filePathOrUrl) 
                ? filePathOrUrl 
                : path.resolve(process.cwd(), filePathOrUrl);

            if (fs.existsSync(absolutePath)) {
                console.log("[PDF] Serving Local File:", absolutePath);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', 'inline; filename="test-paper.pdf"');
                return fs.createReadStream(absolutePath).pipe(res);
            } 
            
            // AGAR LOCAL NA MILE: Check karo kahi ye sirf filename toh nahi jo Cloud par ho sakta hai
            console.warn("[PDF] Local file not found, checking if it's a legacy record:", absolutePath);
            
            // Agar aapke pas koi logic hai URL construct karne ka toh yahan aayega
            // Filhal hum ise block karke 404 denge taaki user naya upload kare
        }

        // --- STEP 3: Cloud Proxying ---
        if (targetUrl) {
            console.log("[PDF] Proxying Cloud URL:", targetUrl);

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: {
                    'Accept': 'application/pdf',
                    'User-Agent': 'Mozilla/5.0' 
                },
                timeout: 20000 
            });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="test-paper.pdf"');
            
            response.data.pipe(res);

            response.data.on('error', (err) => {
                console.error("[PDF Stream Error]:", err.message);
                if (!res.headersSent) res.end();
            });
            return;
        }

        console.error("[PDF 404] Path invalid or file missing everywhere.");
        return res.status(404).json({ 
            error: "File not found", 
            message: "The file path in DB is outdated or local file was deleted." 
        });

    } catch (err) {
        console.error("[CRITICAL ERROR] PDF Service:", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream PDF" });
        }
    }
}



export async function extractUPSCVisualMap(filePathOrUrl) {
    let localPath = filePathOrUrl;
    let isDownloaded = false;
    let finalMap = {};

    try {
        // --- STEP 1: Cloud Download ---
        if (filePathOrUrl.startsWith('http')) {
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const downloadPath = path.join(tempDir, `ocr_proc_${Date.now()}.pdf`);

            const response = await axios({ url: filePathOrUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(downloadPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

            localPath = downloadPath;
            isDownloaded = true;
        }

        // --- STEP 2: PDF to Images (High Quality) ---
        console.log("[Arjun OCR] Sequential Scan: Converting PDF to images...");
        const images = await pdfToImg(localPath, {
            pages: "all",
            imgType: "jpg",
            scale: 2 
        });

        const imageList = Array.isArray(images) ? images : [images];
        
        // --- STEP 3: Page-by-Page Tesseract Loop ---
        console.log(`[Arjun OCR] Scanning ${imageList.length} pages starting from Page 2...`);
        
        for (let i = 1; i < imageList.length; i++) { // Page 2 se start (index 1)
            console.log(`[Arjun OCR] Processing Page ${i + 1}...`);
            
            // Tesseract recognition with OSD for better layout handling
            const { data: { text } } = await Tesseract.recognize(imageList[i], 'eng', {
                tessedit_pageseg_mode: '3' // 3 is usually better for mixed/column layouts
            });

            // --- STEP 4: Advanced Regex Splitting (Column Friendly) ---
            // Pattern: Dhundo Q.1, Q 1, 1., 01) etc.
            // Hum block-by-block split karenge taaki columns jumble na hon
            const qRegex = /(?:^|\n|\s)(?:Q|0|O|Cl)[\s\.]*(\d{1,3})[\s\)\.]([\s\S]*?)(?=(?:\n\s*(?:Q|0|O|Cl)[\s\.]*\d{1,3}[\s\)\.])|$)/gi;

            let match;
            while ((match = qRegex.exec(text)) !== null) {
                const qNo = parseInt(match[1]);
                let content = match[2]
                    .replace(/\n+/g, ' ') // Multiple lines ko space banao
                    .replace(/\s\s+/g, ' ') // Extra double spaces saaf karo
                    .trim();

                // Valid UPSC question check
                if (qNo > 0 && qNo <= 100 && content.length > 15) {
                    // Agar ek question do pages mein divide hai, toh hum longest version rakhenge
                    if (!finalMap[qNo] || content.length > finalMap[qNo].length) {
                        finalMap[qNo] = content;
                    }
                }
            }
        }

        console.log(`[Arjun OCR] Success! Found ${Object.keys(finalMap).length} unique questions.`);
        return finalMap;

    } catch (err) {
        console.error("[Arjun OCR Error]:", err.message);
        return finalMap; // Return partial results instead of null
    } finally {
        if (isDownloaded && fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (e) {}
        }
    }
}

// export async function extractUPSCVisualMap(filePathOrUrl) {
//     let localPath = filePathOrUrl;
//     let isDownloaded = false;
//     let finalMap = {};

//     try {
//         // --- STEP 1: Cloud Download (Same as your code) ---
//         if (filePathOrUrl.startsWith('http')) {
//             const tempDir = path.join(process.cwd(), 'tmp');
//             if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
//             const downloadPath = path.join(tempDir, `ocr_proc_${Date.now()}.pdf`);

//             const response = await axios({ url: filePathOrUrl, method: 'GET', responseType: 'stream' });
//             const writer = fs.createWriteStream(downloadPath);
//             response.data.pipe(writer);
//             await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

//             localPath = downloadPath;
//             isDownloaded = true;
//         }

//         // --- STEP 2: PDF to Images (High Scale for Better OCR) ---
//         console.log("[Arjun OCR] Converting PDF to images...");
//         const images = await pdfToImg(localPath, {
//             pages: "all",
//             imgType: "jpg",
//             scale: 2 // 2 minimum rakhein taaki Tesseract text pehchan sake
//         });

//         const imageList = Array.isArray(images) ? images : [images];
//         let currentQNo = null;
//         let currentText = "";

//     // --- STEP 3: Tesseract Processing ---
//     console.log(`[Arjun OCR] Processing ${imageList.length} pages via Tesseract...`);
    
//     for (let i = 0; i < imageList.length; i++) {
//         if (i === 0) continue; // Cover page skip

//         // Tesseract call
//         const { data: { text } } = await Tesseract.recognize(imageList[i], 'eng');

//         // --- STEP 4: Rough Parsing (Desi Logic) ---
//         const lines = text.split('\n');
//         lines.forEach(line => {
//             const cleanLine = line.trim();
//             if (!cleanLine) return;

//             // Regex: Dhundho "Q.1", "1.", "Q 45)" etc.
//             const qMatch = cleanLine.match(/^(?:Q\s*)?(\d{1,2})[\s\.\)\-]{1,3}/i);

//             if (qMatch) {
//                 // Purana question save karo
//                 if (currentQNo) finalMap[currentQNo] = currentText.trim();
                
//                 // Naya question start karo
//                 currentQNo = qMatch[1];
//                 currentText = cleanLine.replace(qMatch[0], "").trim();
//             } else if (currentQNo) {
//                 // Bina number wali line ko current question mein jodo
//                 currentText += " " + cleanLine;
//             }
//         });
//     }

//         // Last question save
//         if (currentQNo) finalMap[currentQNo] = currentText.trim();

//         console.log(`[Arjun OCR] Found ${Object.keys(finalMap).length} questions.`);
//         return finalMap;

//     } catch (err) {
//         console.error("[Arjun OCR Error]:", err.message);
//         return null;
//     } finally {
//         if (isDownloaded && fs.existsSync(localPath)) fs.unlinkSync(localPath);
//     }
// }

// NEW: Function to extract question text and store it in MockTest
export async function extractAndStoreQuestionText(mockTestId, testPdfPathOrUrl) {
    try {
        console.log(`[Question Text Extraction] Starting for MockTest: ${mockTestId}`);
        
        // Extract question text using visual OCR
        const questionMap = await extractUPSCVisualMap(testPdfPathOrUrl);
        
        if (!questionMap || Object.keys(questionMap).length === 0) {
            console.warn(`[Question Text Extraction] No questions found for MockTest: ${mockTestId}`);
            return false;
        }

        // Import MockTest model
        const MockTest = (await import('../models/MockTest.js')).default;
        
        // Prepare questions array
        const questions = Object.entries(questionMap).map(([qNo, text]) => ({
            questionNumber: parseInt(qNo),
            text: text.slice(0, 1000), // Limit text length to prevent DB issues
            subject: 'General Studies' // Will be updated by AI later
        }));

        // Update MockTest with extracted questions
        await MockTest.findByIdAndUpdate(mockTestId, {
            questions: questions,
            questionTextExtractionStatus: 'completed'
        });

        console.log(`[Question Text Extraction] Successfully stored ${questions.length} questions for MockTest: ${mockTestId}`);
        return true;

    } catch (err) {
        console.error(`[Question Text Extraction] Error for MockTest ${mockTestId}:`, err.message);
        
        // Update status to failed
        try {
            const MockTest = (await import('../models/MockTest.js')).default;
            await MockTest.findByIdAndUpdate(mockTestId, {
                questionTextExtractionStatus: 'failed'
            });
        } catch (updateErr) {
            console.error(`[Question Text Extraction] Failed to update status for MockTest ${mockTestId}:`, updateErr.message);
        }
        
        return false;
    }
}
