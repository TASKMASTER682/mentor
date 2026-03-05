import fs from 'fs';
import path from 'path';
import axios from 'axios';
import PDFParser from 'pdf2json';
import { fileURLToPath } from 'url';
import decompress from 'decompress';
import { pdfToImg } from "pdftoimg-js";
import { pdf } from "pdf-to-img";
import { UTApi } from "uploadthing/server";
import { File } from "node:buffer";
import Tesseract from 'tesseract.js';
import OpenAI from 'openai';
import { Jimp } from 'jimp';

let groq = null;
const getGroqClient = () => {
    if (!groq) {
        groq = new OpenAI({
            apiKey: process.env.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1"
        });
    }
    return groq;
};

// ========================== ANSWER KEY CACHE ==========================
const answerKeyCache = new Map();

export function clearAnswerKeyCache() {
    answerKeyCache.clear();
    console.log("[AnswerKey] Cache cleared!");
}

function generateImageHash(base64String) {
    let hash = 0;
    const str = base64String.substring(0, 10000); // Use first 10k chars for hash
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}

let nvidia = null;
const getNvidiaClient = () => {
    if (!nvidia) {
        nvidia = new OpenAI({
            baseURL: process.env.NVIDIA_API_URL,
            apiKey: process.env.NVIDIA_API_KEY
        });
    }
    return nvidia;
};


const utapi = new UTApi();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export async function uploadFileToUploadthing(filePath, shouldDelete = true) {
    try {
        if (!fs.existsSync(filePath)) return null;

        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);

        const response = await utapi.uploadFiles([
            new File([fileBuffer], fileName, { type: "application/pdf" }),
        ]);

        const uploadResult = response[0];
        if (uploadResult.data) {
            if (shouldDelete) {
                try { fs.unlinkSync(filePath); } catch (e) { }
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

// ========================== QUESTION PAPER PROCESSING ==========================

export async function extractQuestionPaperMap(pdfPathOrUrl) {
    const { default: extractUPSCVisualMap } = await import('./pdfService.js');
    return extractUPSCVisualMap(pdfPathOrUrl);
}

export async function extractUPSCVisualMap(pdfPathOrUrl) {
    let localPath = null;
    let isDownloaded = false;
    let finalMap = {};

    try {
        if (pdfPathOrUrl.startsWith('http')) {
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const downloadPath = path.join(tempDir, `ocr_proc_${Date.now()}.pdf`);

            const response = await axios({ url: pdfPathOrUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(downloadPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

            localPath = downloadPath;
            isDownloaded = true;
        } else {
            localPath = pdfPathOrUrl;
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

            const { data: { text } } = await Tesseract.recognize(imageList[i], 'eng', {
                tessedit_pageseg_mode: '3' // 3 is usually better for mixed/column layouts
            });

            // --- STEP 4: Advanced Regex Splitting (Column Friendly) ---
            const qRegex = /(?:^|\n|\s)(?:Q|0|O|Cl)[\s\.]*(\d{1,3})[\s\)\.]([\s\S]*?)(?=(?:\n\s*(?:Q|0|O|Cl)[\s\.]*\d{1,3}[\s\)\.])|$)/gi;

            let match;
            while ((match = qRegex.exec(text)) !== null) {
                const qNo = parseInt(match[1]);
                let content = match[2]
                    .replace(/\n+/g, ' ')
                    .replace(/\s\s+/g, ' ')
                    .trim();

                if (qNo > 0 && qNo <= 100 && content.length > 15) {
                    if (!finalMap[qNo] || content.length > finalMap[qNo].length) {
                        finalMap[qNo] = content;
                    }
                }
            }
        }

        return finalMap;

    } catch (err) {
        console.error("[Arjun OCR Error]:", err.message);
        return finalMap;
    } finally {
        if (isDownloaded && fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (e) { }
        }
    }
}

// ========================== ANSWER KEY EXTRACTION (with Caching) ==========================

export async function extractAnswerKeyFromSolutionPdf(solutionPdfPathOrUrl, mockTestId = null) {
    let localPath = null;
    let isDownloaded = false;

    try {
        // --- STEP 1: Download if URL ---
        if (solutionPdfPathOrUrl.startsWith('http')) {
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            localPath = path.join(tempDir, `anskey_${Date.now()}.pdf`);

            const response = await axios({ url: solutionPdfPathOrUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(localPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
            isDownloaded = true;
        } else {
            localPath = solutionPdfPathOrUrl;
        }

        // --- STEP 2: Convert PDF to Images using pdf-to-img ---
        console.log("[AnswerKey] Converting PDF to images for Vision API...");
        const document = await pdf(localPath, { scale: 2 });
        const imageBuffers = [];
        for await (const page of document) {
            imageBuffers.push(page);
        }

        // Generate cache hash from first page
        const cacheHash = generateImageHash(imageBuffers[0].toString('base64').substring(0, 5000));
        console.log(`[AnswerKey] Cache hash: ${cacheHash}`);

        // --- CHECK CACHE ---
        if (answerKeyCache.has(cacheHash)) {
            console.log("[AnswerKey] Using cached answer key!");
            return {
                regexParsed: answerKeyCache.get(cacheHash),
                answerKeySection: Object.keys(answerKeyCache.get(cacheHash)).slice(0, 50).join(', '),
                cached: true
            };
        }

        console.log(`[AnswerKey] Processing ${imageBuffers.length} pages with Vision API...`);

        // --- STEP 3: Use NVIDIA Vision API to extract answer key ---
        console.log("[AnswerKey] Sending to NVIDIA Vision API...");

        const maxPages = Math.min(5, imageBuffers.length);
        let allAnswers = {};

        for (let i = 0; i < maxPages; i++) {
            console.log(`[AnswerKey] Processing page ${i + 1}...`);

            const base64Image = imageBuffers[i].toString('base64');

            // STEP 1: Get raw text from image first (not JSON)
            let rawText = '';

            try {
                const textResponse = await getNvidiaClient().chat.completions.create({
                    model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
                    messages: [
                        {
                            role: "system",
                            content: "You are an OCR tool. Extract ALL text from the answer key image exactly as it appears. Include every question number and answer. Preserve the layout and spacing. Do not add formatting."
                        },
                        {
                            role: "user",
                            content: [
                                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                                { type: "text", text: `Extract all text from page ${i + 1}. Include every "Q.No" or question number with its answer (A/B/C/D). Copy exactly as shown.` }
                            ]
                        }
                    ],
                    max_tokens: 8192,
                    temperature: 0.0,
                });

                rawText = textResponse.choices[0]?.message?.content?.trim() || '';
                console.log(`[AnswerKey] Page ${i + 1} raw text (first 300 chars):`, rawText.substring(0, 300));

            } catch (err) {
                console.error(`[AnswerKey] Raw text extraction failed:`, err.message);
            }

            // STEP 2: Parse raw text to JSON using AI
            if (rawText.length > 10) {
                try {
                    const parseResponse = await getNvidiaClient().chat.completions.create({
                        model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
                        messages: [
                            {
                                role: "system",
                                content: `Parse the answer key text into JSON format.
Rules:
- Extract every question number and its answer (A, B, C, or D)
- Question numbers are: 1, 2, 3, ... up to 50+
- If you see patterns like "1 A 2 C 3 A" or "Q1 A Q2 C" or "1.A 2.C 3.A", extract all pairs
- Convert lowercase a/b/c/d to uppercase A/B/C/D
- Fix common OCR errors: 0=D, l=A, I=A, O=D

Return ONLY valid JSON like: {"1": "A", "2": "C", "3": "A", ...}
Include EVERY question number you can find.`
                            },
                            {
                                role: "user",
                                content: `Convert this answer key text to JSON:\n\n${rawText}`
                            }
                        ],
                        max_tokens: 4096,
                        temperature: 0.0,
                        response_format: { type: "json_object" }
                    });

                    const parsedText = parseResponse.choices[0]?.message?.content?.trim() || '';
                    console.log(`[AnswerKey] Page ${i + 1} parsed:`, parsedText.substring(0, 200));

                    const jsonMatch = parsedText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const pageAnswers = JSON.parse(jsonMatch[0]);
                        allAnswers = { ...allAnswers, ...pageAnswers };
                        console.log(`[AnswerKey] Page ${i + 1} got ${Object.keys(pageAnswers).length} answers`);
                    }

                } catch (parseErr) {
                    console.error(`[AnswerKey] Parse error:`, parseErr.message);
                }
            }
        }

        const validAnswers = {};
        Object.entries(allAnswers).forEach(([q, a]) => {
            const qNum = parseInt(q);
            const answer = String(a).toUpperCase();
            if (qNum > 0 && qNum <= 300 && /^[A-D]$/.test(answer)) {
                validAnswers[qNum] = answer;
            }
        });

        console.log(`[AnswerKey] NVIDIA extracted ${Object.keys(validAnswers).length} answers`);

        // --- CACHE THE RESULT ---
        if (Object.keys(validAnswers).length > 0) {
            answerKeyCache.set(cacheHash, validAnswers);
            console.log("[AnswerKey] Cached answer key for future use");
        }

        return {
            regexParsed: validAnswers,
            answerKeySection: Object.keys(validAnswers).slice(0, 50).join(', '),
            cached: false
        };

    } catch (e) {
        console.error("[AnswerKey] Extraction error:", e.message);
        return { regexParsed: {}, answerKeySection: "" };
    } finally {
        if (isDownloaded && localPath && fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (e) { }
        }
    }
}

// ========================== IMAGE PREPROCESSING ==========================

async function preprocessQuestionImage(imageBuffer) {
    try {
        const jimpImage = await Jimp.read(imageBuffer);

        // Convert to grayscale (Jimp v1 uses greyscale)
        if (typeof jimpImage.greyscale === 'function') {
            jimpImage.greyscale();
        } else if (typeof jimpImage.grayscale === 'function') {
            jimpImage.grayscale();
        }

        // Apply contrast enhancement (value between -1 and 1)
        if (typeof jimpImage.contrast === 'function') {
            jimpImage.contrast(0.3);
        }

        // Apply brightness adjustment (value between -1 and 1)
        if (typeof jimpImage.brightness === 'function') {
            jimpImage.brightness(0.1);
        }

        // Normalize
        if (typeof jimpImage.normalize === 'function') {
            jimpImage.normalize();
        }

        return jimpImage;
    } catch (err) {
        console.error("[Preprocess] Error:", err.message);
        return await Jimp.read(imageBuffer);
    }
}

function generateQuestionImageHash(imageBuffer) {
    const base64 = imageBuffer.toString('base64');
    return generateImageHash(base64);
}

// ========================== VISUAL QUESTION IMAGE PROCESSING (Spatial-First) ==========================

export async function processTestPaperImages(pdfPathOrUrl, totalQuestions = 100, mockTestId = "unknown") {
    let localPath = null;
    let isDownloaded = false;
    const questionsData = [];

    try {
        // --- STEP 1: Download if URL ---
        if (pdfPathOrUrl.startsWith('http')) {
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            localPath = path.join(tempDir, `test_${Date.now()}.pdf`);

            const response = await axios({ url: pdfPathOrUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(localPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
            isDownloaded = true;
        } else {
            localPath = pdfPathOrUrl;
        }

        // --- STEP 2: Convert PDF to Images ---
        console.log("[Visual] Converting PDF to images...");
        const document = await pdf(localPath, { scale: 2 });
        const imageBuffers = [];
        for await (const page of document) {
            imageBuffers.push(page);
        }

        console.log(`[Visual] Processing ${imageBuffers.length} pages...`);

        // --- STEP 3: Crop individual questions from each page with spatial tracking ---
        const startPageIdx = 1; // Skip page 1 (instructions), start from page 2
        const actualPageCount = imageBuffers.length - startPageIdx;
        const questionsPerPage = Math.ceil(totalQuestions / Math.max(1, actualPageCount));

        console.log(`[Visual] Skipping page 1 (instructions), processing ${actualPageCount} pages, ~${questionsPerPage} questions per page`);

        for (let pageIdx = startPageIdx; pageIdx < imageBuffers.length; pageIdx++) {
            const pageNum = pageIdx + 1;
            console.log(`[Visual] Processing page ${pageNum}...`);

            const pageBuffer = imageBuffers[pageIdx];
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            // Calculate dimensions
            const pageImage = await Jimp.read(pageBuffer);
            const pageWidth = pageImage.width;
            const pageHeight = pageImage.height;
            const actualRowHeight = Math.floor(pageHeight / questionsPerPage);

            // Crop each question
            for (let q = 0; q < questionsPerPage; q++) {
                const questionNumber = ((pageIdx - startPageIdx) * questionsPerPage) + q + 1;
                if (questionNumber > totalQuestions) break;

                try {
                    const cropX = 10;
                    const cropY = q * actualRowHeight + 5;
                    const cropW = pageWidth - 20;
                    const cropH = Math.min(actualRowHeight - 10, pageHeight - cropY);

                    const cropped = pageImage.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
                    const processed = await preprocessQuestionImage(await cropped.getBuffer('image/jpeg'));

                    const cropPath = path.join(tempDir, `q_${questionNumber}_${Date.now()}.jpg`);
                    await processed.write(cropPath);

                    const imageHash = generateQuestionImageHash(fs.readFileSync(cropPath));

                    // Unique filename per test to avoid Uploadthing collisions
                    const uniqueFileName = `test_${mockTestId}_q${questionNumber}.jpg`;

                    const uploadResult = await utapi.uploadFiles([
                        new File([fs.readFileSync(cropPath)], uniqueFileName, { type: "image/jpeg" })
                    ]);

                    const imageUrl = uploadResult[0]?.data?.ufsUrl || uploadResult[0]?.data?.url || null;
                    fs.unlinkSync(cropPath);

                    if (imageUrl) {
                        questionsData.push({
                            questionNumber: questionNumber,
                            imageUrl: imageUrl,
                            imageHash: imageHash,
                            text: `Question ${questionNumber}`, // Placeholder, text can be updated later via OCR
                            subject: "General Studies",
                            topic: null,
                            correctAnswer: null,
                            status: 'active',
                            boundingBox: {
                                page: pageIdx + 1,
                                x1: cropX,
                                y1: cropY,
                                x2: cropX + cropW,
                                y2: cropY + cropH
                            }
                        });
                        console.log(`[Visual] Q${questionNumber}: ${imageUrl.substring(0, 30)}...`);
                    }
                } catch (cropErr) {
                    console.error(`[Visual] Error Q${questionNumber}:`, cropErr.message);
                }
            }
        }

        return questionsData;


    } catch (e) {
        console.error("[Visual] Processing error:", e.message);
        return [];
    } finally {
        if (isDownloaded && localPath && fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (e) { }
        }
    }
}

// ========================== TARGETED OCR ==========================

export async function extractTextFromQuestionImage(imageUrl) {
    try {
        let localPath = null;
        if (imageUrl.startsWith('http')) {
            const tempDir = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            localPath = path.join(tempDir, `q_ocr_${Date.now()}.jpg`);

            const response = await axios({ url: imageUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(localPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
        } else {
            localPath = imageUrl;
        }

        const { data } = await Tesseract.recognize(localPath, 'eng', {
            tessedit_pageseg_mode: '6'
        });

        if (localPath && localPath.includes('tmp')) {
            try { fs.unlinkSync(localPath); } catch (e) { }
        }

        return data.text.trim();

    } catch (e) {
        console.error("[Visual OCR] Error:", e.message);
        return null;
    }
}

// ========================== VIEWING LOGIC ==========================

export async function streamPdfToResponse(filePathOrUrl, req, res) {
    try {
        if (filePathOrUrl.startsWith('http')) {
            console.log(`[PDF] Redirecting to Cloud URL: ${filePathOrUrl}`);
            return res.redirect(filePathOrUrl);
        } else {
            console.log(`[PDF] Serving Local PDF: ${filePathOrUrl}`);
            return res.download(filePathOrUrl);
        }
    } catch (err) {
        console.error("[PDF] Error:", err);
        res.status(500).send("Error retrieving PDF");
    }
}

import { formatQuestionTextToHTML } from '../utils/parser.js';

export async function extractAndStoreQuestionText(mockTestId, testPdfUrl) {
    try {
        console.log(`[Question Text Extraction] Starting for MockTest ${mockTestId}`);

        const textMap = await extractUPSCVisualMap(testPdfUrl);

        if (textMap && Object.keys(textMap).length > 0) {
            const formattedQuestions = await Promise.all(
                Object.entries(textMap).map(async ([qNo, text]) => ({
                    questionNumber: parseInt(qNo),
                    text: await formatQuestionTextToHTML(text.replace(/[ \t]+/g, ' ')),
                    subject: "General Studies"
                }))
            );

            await MockTest.updateOne(
                { _id: mockTestId },
                {
                    $set: {
                        questions: formattedQuestions,
                        questionTextExtractionStatus: 'completed'
                    }
                }
            );
            console.log(`[Question Text Extraction] Extracted ${Object.keys(textMap).length} questions`);
            return true;
        } else {
            await MockTest.updateOne(
                { _id: mockTestId },
                { $set: { questionTextExtractionStatus: 'failed' } }
            );
            return false;
        }
    } catch (err) {
        console.error("[Question Text Extraction] Error:", err.message);
        try {
            await MockTest.updateOne(
                { _id: mockTestId },
                { $set: { questionTextExtractionStatus: 'failed' } }
            );
        } catch (updateErr) {
            console.error(`[Question Text Extraction] Failed to update status for MockTest ${mockTestId}:`, updateErr.message);
        }

        return false;
    }
}

// Import MockTest for extractAndStoreQuestionText
import MockTest from '../models/MockTest.js';
