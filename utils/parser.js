import { aiService } from '../services/aiService.js';
/**
 * Smart UPSC Question Paper & Solution Parser
 * Designed specifically for ForumIAS / CDS / standard PDF-extracted text
 *
 * QUESTION FORMAT:
 *   Q.1) Question text...
 *   a) Option A
 *   b) Option B
 *   c) Option C
 *   d) Option D
 *
 * SOLUTION FORMAT:
 *   Q.1) Question text... (repeated)
 *   a) ... b) ... c) ... d) ...
 *   Ans) a
 *   Exp) Full explanation here...
 *   Subject:) Polity
 *   Topic:)...
 */

// ─── GARBAGE PATTERNS (ForumIAS specific + general noise) ───────────────────
const GARBAGE_PATTERNS = [
    // Forum footer address lines
    /Forum Learning Centre:.*(\n|$)/gi,
    /.*Canal Road,.*(\n|$)/gi,
    /.*Jawahar Nagar,.*(\n|$)/gi,
    /.*Pusa Road,.*(\n|$)/gi,

    // SFG test headers
    /SFG \d{4}\s*\|.*(\n|$)/gi,

    // URLs and links
    /https?:\/\/\S+/gi,
    /www\.\S+/gi,

    // Email addresses
    /\S+@\S+\.\S+/gi,

    // Phone numbers (10-digit Indian)
    /\d{10}(?:[,\s]+\d{10})*/g,

    // Page markers [2] [3] etc.
    /\[\d{1,3}\]/g,

    // Percentage noise
    /\b(?:100|75|50|25|0)%/g,

    // Source / Subject / Topic metadata lines
    /^Source:\).*(\n|$)/gmi,
    /^Subject:\).*(\n|$)/gmi,
    /^Topic:\).*(\n|$)/gmi,
    /^Subtopic:\)?.*(\n|$)/gmi,
];

/**
 * Clean raw text by removing garbage patterns
 */
export const cleanRawText = (text) => {
    if (!text) return "";
    let cleaned = text;
    for (const pattern of GARBAGE_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
    }
    // Collapse excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
};

// ─── QUESTION PARSER ────────────────────────────────────────────────────────

/**
 * Split text into question blocks.
 * Specifically matches Q.N) or Q.N. at start of a line.
 * This is STRICT — "Q." prefix is REQUIRED to avoid matching numbers inside text.
 */
const splitByQuestionMarker = (text) => {
    // Matches: Q.1) Q.2) Q.10) OR Q.1. Q.2.  — "Q." is required
    const markerRegex = /(?:^|\n)\s*Q\.(\d+)\s*[\.\)]/gm;
    const blocks = [];
    let lastIndex = 0;
    let lastQNum = null;
    let match;

    while ((match = markerRegex.exec(text)) !== null) {
        if (lastQNum !== null) {
            blocks.push({
                qNum: lastQNum,
                body: text.substring(lastIndex, match.index).trim()
            });
        }
        lastQNum = parseInt(match[1]);
        lastIndex = match.index + match[0].length;
    }
    // Last block
    if (lastQNum !== null) {
        blocks.push({
            qNum: lastQNum,
            body: text.substring(lastIndex).trim()
        });
    }
    return blocks;
};

/**
 * Extract options a), b), c), d) from a question body.
 * Options must start at the beginning of a line (with optional whitespace).
 * Uses a strict line-start pattern to avoid matching (a), (b) inside explanation text.
 */
const extractOptions = (body) => {
    // Matches: "a)" or "a." at the START of a line (not inside text)
    const optionLineRegex = /^[ \t]*([a-d])[ \t]*[\.\)]\s*/gm;
    const optionPositions = [];
    let m;

    while ((m = optionLineRegex.exec(body)) !== null) {
        optionPositions.push({ letter: m[1].toLowerCase(), start: m.index, headerLength: m[0].length });
    }

    if (optionPositions.length === 0) return { options: null, firstOptionIndex: -1 };

    const options = { a: 'Option A', b: 'Option B', c: 'Option C', d: 'Option D' };

    for (let i = 0; i < optionPositions.length; i++) {
        const { letter, start, headerLength } = optionPositions[i];
        const valueStart = start + headerLength;
        const valueEnd = i + 1 < optionPositions.length ? optionPositions[i + 1].start : body.length;
        const value = body.substring(valueStart, valueEnd).replace(/\n/g, ' ').trim();
        if (value) options[letter] = value;
    }

    return { options, firstOptionIndex: optionPositions[0].start };
};


/**
 * Intelligently converts raw question text into structured HTML via Groq AI.
 * Detects "match the following", "consider the following pairs" type questions
 * and automatically formats the listed items into an HTML table.
 */
export const formatQuestionTextToHTML = async (text) => {
    if (!text) return "";

    let html = "";
    const isTableQuestion = /(pairs|match the|correctly matched|following pairs|match List I with List II)/i.test(text);

    if (isTableQuestion) {
        try {
            const aiFormatted = await aiService.formatTableQuestion(text);
            if (aiFormatted && aiFormatted.length > 20) {
                return aiFormatted;
            }
        } catch (e) {
            console.error("[Parser] AI Format failed, fallback to plain parsing", e);
        }
    }

    // Regular text formatting fallback
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p);
    if (paragraphs.length > 0) {
        html = `<div class="space-y-4">` + paragraphs.map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('') + `</div>`;
    } else {
        html = `<div class="space-y-4"><p>${text.replace(/\n/g, '<br/>')}</p></div>`;
    }

    return html;
};

/**
 * Parse questions from raw question paper text.
 * Handles: simple questions, numbered list questions, table/match-the-column questions.
 */
export const parseQuestions = async (rawText) => {
    const cleanedText = cleanRawText(rawText);
    const blocks = splitByQuestionMarker(cleanedText);
    const questions = [];

    for (const { qNum, body } of blocks) {
        const { options, firstOptionIndex } = extractOptions(body);

        // Question text = everything before first option
        const questionText = firstOptionIndex !== -1
            ? body.substring(0, firstOptionIndex).trim()
            : body.trim();

        // Skip if no meaningful content
        if (!questionText && (!options || !options.a)) continue;

        const formattedHTML = await formatQuestionTextToHTML(questionText);

        questions.push({
            questionNumber: qNum,
            questionText: formattedHTML,
            options: options || { a: 'Option A', b: 'Option B', c: 'Option C', d: 'Option D' }
        });
    }

    return questions;
};

// ─── SOLUTION PARSER ────────────────────────────────────────────────────────

/**
 * Parse solutions from raw solution book text.
 * Looks for the specific pattern:
 *   Ans) a        ← correct answer letter
 *   Exp) ...      ← explanation text
 */
export const parseSolutions = (rawText) => {
    const cleanedText = cleanRawText(rawText);
    const blocks = splitByQuestionMarker(cleanedText);
    const solutions = [];

    for (const { qNum, body } of blocks) {
        // 1. Find answer: "Ans) a" or "Ans. a" or "Ans: a" (exact, at start of a line)
        const ansMatch = body.match(/\bAns[\.\):\s]+\s*\(?([a-d])\)?/im);

        if (!ansMatch) {
            console.warn(`[Parser] No answer found for Q${qNum}. Snippet: "${body.substring(0, 100).replace(/\n/g, ' ')}"`);
            continue;
        }

        const answer = ansMatch[1].toUpperCase();

        // 2. Find explanation: "Exp) ..." — everything after this marker, cleanup metadata
        let explanation = '';
        const expMatch = body.match(/\bExp[\.\):\s]+\s*([\s\S]*)/im);
        if (expMatch) {
            explanation = expMatch[1]
                // Remove metadata footer lines that appear at the end
                .replace(/\bKnowledge Base\s*:[\s\S]*/i, '')
                .replace(/\bSource\s*:\)[\s\S]*/i, '')
                .trim();
        } else {
            // Fallback: everything after the Ans line
            explanation = body.substring(ansMatch.index + ansMatch[0].length).trim();
        }

        solutions.push({
            questionNumber: qNum,
            correctAnswer: answer,
            explanation
        });
    }

    return solutions;
};

// ─── MAPPER ─────────────────────────────────────────────────────────────────

/**
 * Maps questions and solutions by questionNumber.
 */
export const mapQuestionsAndSolutions = (questions, solutions) => {
    const solutionMap = new Map();
    solutions.forEach(s => solutionMap.set(s.questionNumber, s));

    return questions.map(q => {
        const sol = solutionMap.get(q.questionNumber);
        return {
            ...q,
            correctAnswer: sol?.correctAnswer ?? null,
            explanation: sol?.explanation ?? ''
        };
    });
};

// ─── LEGACY FALLBACK ─────────────────────────────────────────────────────────

/**
 * Simple regex answer key extractor — used for PDF mode only.
 */
export const extractAnswersRegex = (text) => {
    const answerKey = {};
    const regex = /(\d+)[\.\s\-\)]+([ABCDabcd])/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        answerKey[match[1]] = match[2].toUpperCase();
    }
    return answerKey;
};
