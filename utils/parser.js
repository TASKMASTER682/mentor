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

// ─── MARKER-BASED PARSER ─────────────────────────────────────────────────────
// Parses text using markers: [CONTEXT], [Q], [ST-START]/[ST-END], [MATCH-START]/[MATCH-END],
// [SUB-Q], [O_a], [O_b], [O_c], [O_d], [ANS], [EXP], [NEXT]
export const parseMarkers = (rawText) => {
    if (!rawText || !rawText.trim()) return [];

    const ALL_MARKERS = ['CONTEXT','Q','ST-START','ST-END','MATCH-START','MATCH-END','SUB-Q','O_a','O_b','O_c','O_d','ANS','EXP','SUBJ','NEXT'];

    const blocks = rawText.split('[NEXT]').map(b => b.trim()).filter(Boolean);
    const questions = [];

    for (let idx = 0; idx < blocks.length; idx++) {
        const block = blocks[idx];
        const qNum = idx + 1;

        const extract = (marker) => {
            const re = new RegExp(`\\[${marker}\\]([\\s\\S]*?)(?=\\[(?:${ALL_MARKERS.join('|')})\\]|$)`, 'i');
            const m = block.match(re);
            return m ? m[1].trim() : '';
        };

        const subject = extract('SUBJ');
        const context = extract('CONTEXT');
        const questionStem = extract('Q');
        const subQuestion = extract('SUB-Q');

        const rawStatements = extract('ST-START');
        const statements = rawStatements
            ? rawStatements.split('\n').map(l => l.trim()).filter(l => l).map(l => {
                return l.replace(/^\d+[\.\)]\s*/, '').trim();
            })
            : [];

        const rawMatches = extract('MATCH-START');
        let matchPairs = [];
        if (rawMatches) {
            matchPairs = rawMatches.split('\n').map(l => l.trim()).filter(l => l).map(l => {
                const colonIdx = l.indexOf(':');
                if (colonIdx > 0) {
                    const left = l.substring(0, colonIdx).replace(/^\d+[\.\)]\s*/, '').trim();
                    const right = l.substring(colonIdx + 1).trim();
                    return { left, right };
                }
                return null;
            }).filter(Boolean);
        }

        const options = {
            a: extract('O_a'),
            b: extract('O_b'),
            c: extract('O_c'),
            d: extract('O_d'),
        };

        const ansRaw = extract('ANS').toUpperCase();
        const correctAnswer = ['A','B','C','D'].includes(ansRaw) ? ansRaw : null;
        const explanation = extract('EXP');

        if (!questionStem && !subQuestion) continue;

        const questionText = [context, questionStem, subQuestion].filter(Boolean).join(' ');
        const hasStatements = statements.length > 0;
        const hasMatchPairs = matchPairs.length > 0;

        const structure = {
            type: hasMatchPairs ? 'match_column' : 'standard',
            context: context || undefined,
            questionStem: questionStem || undefined,
            statements: hasStatements ? statements : undefined,
            matchPairs: hasMatchPairs ? matchPairs : undefined,
            subQuestion: subQuestion || undefined,
        };

        questions.push({
            questionNumber: qNum,
            questionText,
            options,
            correctAnswer,
            explanation,
            subject: subject || undefined,
            structure,
            questionType: hasMatchPairs ? 'table_match' : 'regular_mcq'
        });
    }

    return questions;
};
