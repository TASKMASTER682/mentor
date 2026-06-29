import { aiService } from '../services/aiService.js';
import * as cheerio from 'cheerio';

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
    /\bEP-\d+/g,
    /Join Now.*/gi,
];

// ─── HELPERS ────────────────────────────────────────────────────────────────
export const cleanRawText = (text) => {
    if (!text) return "";
    let cleaned = text;
    for (const pattern of GARBAGE_PATTERNS) cleaned = cleaned.replace(pattern, '');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const escapeHtml = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

// ─── TYPE DETECTION ─────────────────────────────────────────────────────────
export const detectQuestionType = (questionText) => {
    const text = questionText.toLowerCase();
    if (/(pairs|match the|correctly matched|following pairs|match List I with List II)/i.test(text)) return 'table_match';
    if (/statement[- ]?I[:\s]/i.test(text)) return 'statement_pair';
    if (/assertion[:\s]/i.test(text) && /reason[:\s]/i.test(text)) return 'assertion_reason';
    if (/\b(I{1,3}|IV|V)\s*[\.\)]/.test(questionText)) return 'roman_numeral';
    if (/\b[1-9]\.\s+[A-Z]/.test(questionText)) return 'numeric_statements';
    return 'regular_mcq';
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

    // 1. AI TRIGGER LOGIC (Refined for Table vs Complex Text)
    const whichCount = (text.match(/\bWhich\b/gi) || []).length;
    const howCount = (text.match(/\bHow\b/gi) || []).length;
    const selectCount = (text.match(/\bSelect\b/gi) || []).length;

    // Conditions for Complex Text Redundancy
    const hasRedundancy = (whichCount > 0 && howCount > 0) || (howCount > 1) || (whichCount > 1) || (selectCount > 1);

    // AI Execution Block
    if (type === 'table_match' || (hasRedundancy && statements)) {
        try {
            let aiFormatted = null;

            // CASE A: Table Match Question (Use Table Formatter only)
            if (type === 'table_match' && typeof aiService.formatTableQuestion === 'function') {
                aiFormatted = await aiService.formatTableQuestion(text);
            } 
            // CASE B: Complex Text Question (Use Complex Formatter only)
            else if (hasRedundancy && statements && typeof aiService.formatComplexQuestion === 'function') {
                aiFormatted = await aiService.formatComplexQuestion(text, statements);
            }

            if (aiFormatted) return `<div class="w-full">${aiFormatted}</div>`;
        } catch (e) { 
            console.error("AI Formatting Fail, falling back to Regex", e); 
        }
    }

    // 2. EXTRACTION LOGIC (Working perfectly for Simple Questions)
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

    let html = `<div class="w-full flex flex-col space-y-4" style="font-family:'Playfair Display',Georgia,serif">`;
    
    // HEADER RENDER
    html += `<div class="w-full">
                <h3 style="font-size:1.125rem;font-weight:700;color:#a63a3a;line-height:1.375">
                    ${escapeHtml(questionHeader.replace(/\s+/g, ' '))}
                </h3>
             </div>`;

    // 3. STATEMENTS RENDER
    if (statements && typeof statements === 'object') {
        const entries = Object.entries(statements).filter(([_, v]) => v !== null && v !== undefined);
        
        if (entries.length > 0 || Array.isArray(statements)) {
            html += `<div class="w-full p-4 rounded-lg" style="background:rgba(243,239,227,0.6);border-left:4px solid #ef4444">`;
            
            if (!Array.isArray(statements)) {
                // Object Case (Statement I, II, III)
                entries.forEach(([key, val]) => {
                    const cleanVal = val.split(questionPhraseRegex)[0].trim();
                html += `<p class="w-full flex items-start" style="color:#1B1510">
                            <strong style="min-width:120px;flex-shrink:0;color:#ef4444;font-weight:700">${escapeHtml(key)}:</strong> 
                            <span style="flex-grow:1;line-height:1.625">${escapeHtml(cleanVal.replace(/\s+/g, ' '))}</span>
                         </p>`;
                });
            } else {
                // Array Case (Numeric/Roman)
                statements.forEach(s => {
                    if (s && s.text) {
                        const cleanStmt = s.text.split(questionPhraseRegex)[0].trim();
                html += `<div class="flex items-start w-full py-0.5">
                            <span style="color:#ef4444;font-weight:700;min-width:35px;flex-shrink:0">${escapeHtml(s.label)}.</span> 
                            <span style="color:#1B1510;flex-grow:1;line-height:1.625">${escapeHtml(cleanStmt.replace(/\s+/g, ' '))}</span>
                         </div>`;
                    }
                });
            }
            html += `</div>`;
        }
    }

    // 4. TAIL TEXT (Instruction Phrase)
    if (tailText && tailText.length > 5 && tailText !== questionHeader) {
        html += `<div class="mt-2 pt-2" style="border-top:1px solid rgba(222,214,190,0.5)">
                    <p style="color:#1B1510;font-weight:500;font-style:italic;line-height:1.625">
                        ${escapeHtml(tailText.replace(/\s+/g, ' '))}
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
        if (lastQNum !== null) {
            blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex, match.index).trim() });
        }
        lastQNum = parseInt(match[1]);
        lastIndex = match.index + match[0].length;
    }
    if (lastQNum) blocks.push({ qNum: lastQNum, body: cleaned.substring(lastIndex).trim() });

    for (const { qNum, body } of blocks) {
        // 1. Better Answer Detection (Handles: Ans: A, Answer - B, Ans) A)
        const ansMatch = body.match(/(?:Answer|Ans)[\s:]*\)?\s*\(?([a-d])\)?/im);
        if (!ansMatch) continue;

        const answer = ansMatch[1].toUpperCase();
        
        // 2. Smart Explanation Extraction
        let rawExplanation = '';
        const expMatch = body.match(/(?:Exp|Explanation|Solution)[\s:]*\)?\s*([\s\S]*)/im);
        
        if (expMatch) {
            rawExplanation = expMatch[1];
        } else {
            // Fallback: Answer marker ke baad ka saara text explanation hai
            rawExplanation = body.substring(ansMatch.index + ansMatch[0].length).trim();
        }

        // 3. Final Cleanup & Formatting
        const finalExplanation = rawExplanation
            .replace(/\bKnowledge Base\s*:[\s\S]*/i, '') // Extra section hatao
            .replace(/\bSource\s*:\s*[\s\S]*/i, '')      // Source hatao
            .replace(/(Statement\s*\d+)/gi, '<strong>$1</strong>') // Statements ko bold karo
            .replace(/(Hence|Therefore|Correct\s*Option)/gi, '<br/><strong>$1</strong>') // New line focus
            .replace(/\n/g, '<br/>') // Standard line breaks
            .trim();

        solutions.push({
            questionNumber: qNum,
            correctAnswer: answer,
            explanation: finalExplanation
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

// ─── HTML STRUCTURED PARSER ─────────────────────────────────────────────────
// Parses questions from HTML using data-* attributes and classes.
// Expected HTML structure:
//   <div class="ata-question-item" data-question-no="1">
//     <div data-question-stem>...</div>
//     <div data-statement-intro>...</div>
//     <ul data-statements-list>...</ul>
//     <div data-question-continuation>...</div>
//     <div data-code-instruction>...</div>
//     <ul data-options-list>
//       <li data-option="A">text</li>
//       <li data-option="B">text</li>
//       ...
//     </ul>
//     <div data-case-study>...</div>
//     <div data-assertion-text>...</div>
//     <div data-match-list>...</div>
//   </div>
//
// Solutions HTML:
//   <div class="ata-question-item" data-question-no="1">
//     <div data-answer>A</div>
//     <div data-explanation>...</div>
//   </div>

export const parseQuestionsFromHTML = (questionsHtml, solutionsHtml) => {
  const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
  const $q = cheerio.load(stripComments(questionsHtml));
  const $s = solutionsHtml ? cheerio.load(stripComments(solutionsHtml)) : cheerio.load('');

  const esc = (t) => {
    if (!t) return '';
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };

  const stripLabelSpan = ($, li) => {
    const $li = $(li);
    $li.find('span').each((_, s) => {
      const t = $(s).text().trim();
      if (/^[IVXLCDM\d]+\.$/.test(t) || /^\(?[a-d]\)$/.test(t)) $(s).remove();
    });
    return $li.text().trim();
  };

  const buildStem = ($el, $) => {
    const stemParts = [];
    const preamble = [];
    const stmts = [];
    const labeledStmts = [];
    const continuations = [];
    const codeInstrs = [];
    const extras = [];

    $el.find('[data-question-stem], .question-stem').each((_, e) => stemParts.push($(e).text().trim()));
    $el.find('[data-statement-intro], .statement-intro').each((_, e) => preamble.push($(e).text().trim()));
    $el.find('[data-match-intro], .match-intro').each((_, e) => preamble.push($(e).text().trim()));

    $el.find('.statement-item').each((_, e) => {
      const $item = $(e);
      const label = $item.find('.assertion-label').text().trim();
      const text = $item.find('.assertion-text').text().trim();
      if (text) {
        if (label) labeledStmts.push({ label, text });
        else stmts.push(text);
      } else {
        const t = $item.text().trim();
        if (t) stmts.push(t);
      }
    });
    $el.find('[data-statements-list] > li').each((_, e) => {
      const t = stripLabelSpan($, e);
      if (t) stmts.push(t);
    });

    $el.find('[data-question-continuation], .question-continuation').each((_, e) => continuations.push($(e).text().trim()));
    $el.find('[data-code-instruction], .code-instruction').each((_, e) => codeInstrs.push($(e).text().trim()));
    $el.find('[data-case-study], .case-study').each((_, e) => extras.push($(e).html().trim()));
    $el.find('[data-match-wrapper], .match-wrapper').each((_, e) => {
      let raw = $(e).html().trim();
      if (raw) {
        raw = raw.replace(/<table[^>]*>/gi, '').replace(/<\/table>/gi, '');
        raw = raw.replace(/<td\b/gi, '<td style="border:1px solid #ded6be;padding:0.5rem 0.75rem"');
        raw = raw.replace(/<th\b/gi, '<th style="border:1px solid #ded6be;padding:0.5rem 0.75rem"');
        extras.push(`<div style="overflow-x:auto;margin-top:0.5rem"><table style="width:100%;border-collapse:collapse;font-size:0.9375rem;color:#1B1510">${raw}</table></div>`);
      }
    });

    let html = '<div class="w-full flex flex-col space-y-4" style="font-family:\'Playfair Display\',Georgia,serif">';

    const heading = [...stemParts, ...preamble].filter(Boolean).join(' ');
    if (heading) {
      html += `<div class="w-full"><h3 style="font-size:1.125rem;font-weight:700;color:#a63a3a;line-height:1.375">${esc(heading)}</h3></div>`;
    }

    const hasAnyStmt = labeledStmts.length || stmts.length;
    if (hasAnyStmt) {
      html += '<div class="w-full p-4 rounded-lg" style="background:rgba(243,239,227,0.6);border-left:4px solid #ef4444">';
      labeledStmts.forEach(({ label, text }) => {
        const cleanLabel = label.replace(/:\s*$/, '');
        html += `<div class="flex items-start w-full py-0.5"><span style="color:#ef4444;font-weight:700;min-width:120px;flex-shrink:0">${esc(cleanLabel)}:</span> <span style="color:#1B1510;flex-grow:1;line-height:1.625">${esc(text)}</span></div>`;
      });
      stmts.forEach((s, i) => {
        const cleaned = s.replace(/^[\s]*(?:[IVX]+|\(?[a-z]\)|\d+)[\.\)]\s*/, '');
        html += `<div class="flex items-start w-full py-0.5"><span style="color:#ef4444;font-weight:700;min-width:35px;flex-shrink:0">${i+1}.</span> <span style="color:#1B1510;flex-grow:1;line-height:1.625">${esc(cleaned)}</span></div>`;
      });
      html += '</div>';
    }

    extras.forEach((e) => {
      if (e) html += `<div class="mt-2"><p style="color:#1B1510;line-height:1.625">${e}</p></div>`;
    });

    const tailParts = [...continuations, ...codeInstrs].filter(Boolean);
    tailParts.forEach((t, i) => {
      const border = hasAnyStmt || extras.length ? 'border-top:1px solid rgba(222,214,190,0.5)' : '';
      html += `<div class="${i > 0 ? 'mt-2 ' : ''}pt-2" style="${border}"><p style="color:#1B1510;font-weight:500;font-style:italic;line-height:1.625">${esc(t)}</p></div>`;
    });

    html += '</div>';
    return html;
  };

  const stripOptLabel = (t) => t.replace(/^\(?[a-d]\)?\s*\)?\s*/, '').trim();

  const extractOptions = ($el, $) => {
    const opts = { a: '', b: '', c: '', d: '' };
    const letters = ['a', 'b', 'c', 'd'];
    $el.find('[data-options-list] [data-option], .options-list .option-item[data-option]').each((_, e) => {
      const letter = $(e).attr('data-option')?.toLowerCase();
      if (letters.includes(letter)) opts[letter] = stripOptLabel($(e).text().trim());
    });
    if (!opts.a) {
      $el.find('[data-options-list] li, .options-list .option-item').each((i, e) => {
        if (i < 4) opts[letters[i]] = stripOptLabel($(e).text().trim());
      });
    }
    return opts;
  };

  const questions = [];
  $q('.ata-question-item, [data-question-item], .question-item').each((_, el) => {
    const $el = $q(el);
    const qNo = parseInt($el.attr('data-question-number') || $el.attr('data-question-no'));
    if (!qNo) return;

    const stem = buildStem($el, $q);
    const options = extractOptions($el, $q);

    questions.push({
      questionNumber: qNo,
      questionText: stem,
      options,
      questionType: detectQuestionType(stem)
    });
  });

  const buildExplanation = (answer, justification, elimNote) => {
    const parts = [];
    if (answer) parts.push(`<div style="color:#a63a3a;font-weight:600;font-size:1rem;margin-bottom:0.5rem">Answer: (${answer.toLowerCase()})</div>`);
    if (justification) parts.push(`<div style="color:#1B1510;line-height:1.625">${esc(justification)}</div>`);
    if (elimNote) parts.push(`<div style="color:#5C4D3C;font-size:0.875rem;font-style:italic;margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(222,214,190,0.5)">${esc(elimNote)}</div>`);
    return parts.join('\n');
  };

  // Parse solutions
  const solutionMap = new Map();

  $s('[data-solution-item]').each((_, el) => {
    const $el = $s(el);
    const qNo = parseInt($el.attr('data-question-number'));
    if (!qNo) return;
    let answer = ($el.attr('data-answer') || '').toUpperCase();
    if (!answer) {
      const line = $el.find('[data-answer-line]').text().trim();
      const m = line.match(/\(?([a-d])\)?/i);
      if (m) answer = m[1].toUpperCase();
    }
    const justification = $el.find('[data-justification]').text().trim();
    const elimNote = $el.find('[data-elimination-note]').text().trim();
    const explanation = buildExplanation(answer, justification, elimNote);
    solutionMap.set(qNo, { correctAnswer: answer, explanation });
  });

  $s('.ata-question-item').each((_, el) => {
    const $el = $s(el);
    const qNo = parseInt($el.attr('data-question-no'));
    if (!qNo || solutionMap.has(qNo)) return;
    const answer = ($el.find('[data-answer]').text().trim() || '').toUpperCase();
    const raw = $el.find('[data-explanation]').html()?.trim();
    const explanation = raw ? `<div style="color:#1B1510;line-height:1.625">${raw}</div>` : '';
    if (answer) solutionMap.set(qNo, { correctAnswer: answer, explanation });
  });

  return questions.map(q => {
    const sol = solutionMap.get(q.questionNumber);
    return {
      ...q,
      correctAnswer: sol?.correctAnswer || null,
      explanation: sol?.explanation || ''
    };
  });
};