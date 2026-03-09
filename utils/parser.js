import { aiService } from '../services/aiService.js';

/**
 * Smart UPSC Question Paper & Solution Parser
 * Logic: AI used ONLY for complex Tables. Local Regex handles everything else.
 */

// ─── GARBAGE PATTERNS ───────────────────────────────────────────────────────
const GARBAGE_PATTERNS = [
    /Forum Learning Centre:.*(\n|$)/gi,
    /.*Canal Road,.*(\n|$)/gi,
    /.*Jawahar Nagar,.*(\n|$)/gi,
    /.*Pusa Road,.*(\n|$)/gi,
    /SFG \d{4}\s*\|.*(\n|$)/gi,
    /Page\s+\d+\s+of\s+\d+/gi,
    /^Page\s+\d+.*$/gim,
    /https?:\/\/\S+/gi,
    /www\.\S+/gi,
    /\S+@\S+\.\S+/gi,
    /\d{10}(?:[,\s]+\d{10})*/g,
    /\[\d{1,3}\]/g,
    /\b(?:100|75|50|25|0)%/g,
    /^Source:\).*(\n|$)/gmi,
    /^Subject:\).*(\n|$)/gmi,
    /^Topic:\).*(\n|$)/gmi,
    /^Subtopic:\)?.*(\n|$)/gmi,
    /Only For Premium Members.*/gi,
    /https:\/\/upsccopycenter\.com\/.*/gi,
    /UnderStand UPSC.*/gi,
    /Join Now.*/gi,
];

// ─── HELPERS ────────────────────────────────────────────────────────────────
export const cleanRawText = (text) => {
    if (!text) return "";
    let cleaned = text;
    for (const pattern of GARBAGE_PATTERNS) cleaned = cleaned.replace(pattern, '');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const cleanTextInline = (text) => text?.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim() || '';

// ─── TYPE DETECTION ─────────────────────────────────────────────────────────
export const detectQuestionType = (questionText) => {
    const text = questionText.toLowerCase();
    if (/(pairs|match the|correctly matched|following pairs|match List I with List II)/i.test(text)) return 'table_match';
    if (/statement[- ]?I[:\s]/i.test(text)) return 'statement_pair';
    if (/assertion[:\s]/i.test(text) && /reason[:\s]/i.test(text)) return 'assertion_reason';
    if (/\b(I{1,3}|IV|V)\s*[\.\)]/.test(questionText)) return 'roman_numeral';
    if (/\b[1-9]\.\s+[A-Z]/.test(questionText)) return 'numeric_statements';
    return 'regular_mcq'
};

// ─── LOCAL EXTRACTORS ───────────────────────────────────────────────────────
const extractRomanNumeralStatements = (text) => {
    const statements = [];
    const regex = /\b(I{1,3}|IV|V)\s*[\.\)]\s*([\s\S]*?)(?=\b(I{1,3}|IV|V)\s*[\.\)]|which|select|answer|$)/gi;
    let m;
    while ((m = regex.exec(text)) !== null) {
        statements.push({ label: m[1].toUpperCase(), text: m[2].trim() });
    }
    return statements;
};

const extractNumericStatements = (text) => {
    const statements = [];
    const regex = /\b([1-9])[\.\)]\s+([\s\S]*?)(?=\b[1-9][\.\)]|which|select|answer|$)/gi;
    let m;
    while ((m = regex.exec(text)) !== null) {
        statements.push({ label: m[1], text: m[2].trim() });
    }
    return statements;
};

const extractStatementPair = (text) => {
    // S1: Statement I se II tak
    const s1 = text.match(/Statement[- ]?I[:\s]+([\s\S]*?)(?=Statement[- ]?II|$)/i);
    // S2: Statement II se III tak (Agar III hai) ya phir Question Phrase tak
    const s2 = text.match(/Statement[- ]?II[:\s]+([\s\S]*?)(?=Statement[- ]?III|Which|Select|How|Match|$)/i);
    // S3: Statement III se Question Phrase tak
    const s3 = text.match(/Statement[- ]?III[:\s]+([\s\S]*?)(?=Which|Select|How|Match|$)/i);

    return { 
        "Statement I": s1?.[1]?.trim() || null, 
        "Statement II": s2?.[1]?.trim() || null, 
        "Statement III": s3?.[1]?.trim() || null 
    };
};

const extractAssertionReason = (text) => {
    const a = text.match(/Assertion[:\s]+([\s\S]*?)(?=Reason|$)/i);
    const r = text.match(/Reason[:\s]+([\s\S]*?)(?=Which|Select|$)/i);
    return { "Assertion": a?.[1]?.trim(), "Reason": r?.[1]?.trim() };
};

// ─── HTML FORMATTER ─────────────────────────────────────────────────────────


export const formatQuestionTextToHTML = async (text, type, statements) => {
    if (!text) return "";

    // 1. AI TRIGGER (Tables)
    if (type === 'table_match') {
        try {
            const aiFormatted = await aiService.formatTableQuestion(text);
            if (aiFormatted) return `<div class="w-full">${aiFormatted}</div>`;
        } catch (e) { console.error("AI Table Fail", e); }
    }

    const statementMarkerRegex = /\b(I\.|1\.|Statement[- ]?I|Assertion)/i;
    const questionPhraseRegex = /\b(Which|How many|In how many|Select|Match|With reference)\b/i;
    const hasStatements = statementMarkerRegex.test(text);

    let questionHeader = "";
    let tailText = "";

    if (hasStatements) {
        const splitMatch = text.match(statementMarkerRegex);
        questionHeader = text.substring(0, splitMatch.index).trim();
        
        const remainder = text.substring(splitMatch.index);
        const phraseMatch = remainder.match(questionPhraseRegex);
        if (phraseMatch) {
            tailText = remainder.substring(phraseMatch.index).trim();
        }
    } else {
        questionHeader = text.trim();
        tailText = "";
    }

    let html = `<div class="w-full flex flex-col space-y-4">`;
    
    // HEADER
    html += `<div class="w-full">
                <h3 class="text-lg font-bold text-white leading-snug w-full">
                    ${questionHeader.replace(/\s+/g, ' ')}
                </h3>
             </div>`;

    // 3. STATEMENTS RENDER (Strict Check)
    if (statements && typeof statements === 'object') {
        const entries = Object.entries(statements).filter(([_, v]) => v !== null);
        
        if (entries.length > 0 || Array.isArray(statements)) {
            html += `<div class="w-full bg-slate-800/40 p-4 rounded-lg border-l-4 border-yellow-500 flex flex-col space-y-3">`;
            
            if (!Array.isArray(statements)) {
                entries.forEach(([key, val]) => {
                    const cleanVal = val.split(questionPhraseRegex)[0].trim();
                    html += `<p class="text-gray-200 w-full flex items-start">
                                <strong class="min-w-[120px] shrink-0 text-yellow-400 font-bold">${key}:</strong> 
                                <span class="flex-grow leading-relaxed">${cleanVal.replace(/\s+/g, ' ')}</span>
                             </p>`;
                });
            } else {
                statements.forEach(s => {
                    const cleanStmt = s.text.split(questionPhraseRegex)[0].trim();
                    html += `<div class="flex items-start w-full py-0.5">
                                <span class="text-yellow-400 font-bold min-w-[35px] shrink-0">${s.label}.</span> 
                                <span class="text-gray-200 flex-grow leading-relaxed">${cleanStmt.replace(/\s+/g, ' ')}</span>
                             </div>`;
                });
            }
            html += `</div>`;
        }
    }

    // 4. TAIL TEXT (Instruction Phrase)
    if (tailText && tailText.length > 5 && tailText !== questionHeader) {
        html += `<div class="mt-2 pt-2 border-t border-gray-700/50">
                    <p class="text-white font-medium italic leading-relaxed">
                        ${tailText.replace(/\s+/g, ' ')}
                    </p>
                 </div>`;
    }

    return html + `</div>`;
};

// ─── CORE QUESTION PARSER ───────────────────────────────────────────────────
export const parseQuestions = async (rawText) => {
    const cleaned = cleanRawText(rawText);
    const markerRegex = /(?:^|\n)\s*Q\.?(\d+)\s*[\.\)]/gm;
    const questions = [];
    
    let match, lastIndex = 0, lastQNum = null;
    const blocks = [];

    while ((match = markerRegex.exec(cleaned)) !== null) {
        if (lastQNum !== null) blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex, match.index).trim() });
        lastQNum = parseInt(match[1]);
        lastIndex = match.index + match[0].length;
    }
    if (lastQNum) blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex).trim() });

    for (const { qNum, body } of blocks) {
        const optRegex = /^[ \t]*\(?([a-d])\)?[ \t]*[\.\)]\s*/gm;
        let m, firstOptIdx = -1, options = { a:'', b:'', c:'', d:'' };
        const optPositions = [];

        while ((m = optRegex.exec(body)) !== null) {
            if (firstOptIdx === -1) firstOptIdx = m.index;
            optPositions.push({ letter: m[1].toLowerCase(), start: m.index, len: m[0].length });
        }

        for (let i = 0; i < optPositions.length; i++) {
            const end = optPositions[i+1] ? optPositions[i+1].start : body.length;
            options[optPositions[i].letter] = body.substring(optPositions[i].start + optPositions[i].len, end).replace(/\n/g, ' ').trim();
        }

        const qTextRaw = firstOptIdx !== -1 ? body.substring(0, firstOptIdx).trim() : body.trim();
        const type = detectQuestionType(qTextRaw);
        
        let stmts = null;
        if (type === 'roman_numeral') stmts = extractRomanNumeralStatements(qTextRaw);
        else if (type === 'numeric_statements') stmts = extractNumericStatements(qTextRaw);
        else if (type === 'statement_pair') stmts = extractStatementPair(qTextRaw);
        else if (type === 'assertion_reason') stmts = extractAssertionReason(qTextRaw);

        const html = await formatQuestionTextToHTML(qTextRaw, type, stmts);

        questions.push({
            questionNumber: qNum,
            questionText: html,
            options: options,
            questionType: type
        });
    }
    return questions;
};

// ─── SOLUTIONS PARSER ───────────────────────────────────────────────────────
export const parseSolutions = (rawText) => {
    const cleaned = cleanRawText(rawText);
    const markerRegex = /(?:^|\n)\s*Q\.?(\d+)\s*[\.\)]/gm;
    const solutions = [];

    let match, lastIndex = 0, lastQNum = null;
    const blocks = [];

    while ((match = markerRegex.exec(cleaned)) !== null) {
        if (lastQNum !== null) blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex, match.index).trim() });
        lastQNum = parseInt(match[1]);
        lastIndex = match.index + match[0].length;
    }
    if (lastQNum) blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex).trim() });

    for (const { qNum, body } of blocks) {
        const ansMatch = body.match(/(?:Answer|Ans)[\s:]*\)?\s*\(?([a-d])\)?/im);
        if (!ansMatch) continue;

        const answer = ansMatch[1].toUpperCase();
        let explanation = '';
        const expMatch = body.match(/(?:Exp|Explanation)[\s:]*\)?\s*([\s\S]*)/im);
        
        if (expMatch) {
            explanation = expMatch[1]
                .replace(/\bKnowledge Base\s*:[\s\S]*/i, '')
                .replace(/\bSource\s*:\)[\s\S]*/i, '')
                .trim();
        } else {
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

// ─── LEGACY / PDF FALLBACK ──────────────────────────────────────────────────
export const extractAnswersRegex = (text) => {
    const answerKey = {};
    const regex = /(\d+)[\.\s\-\)]+([ABCDabcd])/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        answerKey[match[1]] = match[2].toUpperCase();
    }
    return answerKey;
};
