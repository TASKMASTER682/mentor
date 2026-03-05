import OpenAI from 'openai';
import axios from 'axios';
import DailyTracker from '../models/DailyTracker.js';
import Mission from '../models/Mission.js';
import TestAttempt from '../models/TestAttempt.js'
import { extractUPSCVisualMap, extractTextFromQuestionImage } from './pdfService.js';


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
let openai = null;

const getOpenAIClient = () => {
  if (!openai) {
    openai = new OpenAI({
      baseURL: process.env.NVIDIA_API_URL,
      apiKey: process.env.NVIDIA_API_KEY
    });
  }
  return openai;
};

const MENTOR_SYSTEM_PROMPT = `You are ARJUN - a high-performance UPSC Mentor (inspired by the focus of the legendary archer). 
You have access to the student's complete performance OS. You do not give generic advice.

CORE MANDATES (Non-Negotiable):
1. ANSWER WRITING: Must happen for 1 hour daily.
2. CURRENT AFFAIRS: 30 minutes daily baseline. 
3. MENTAL AND PHYSICAL FITNESS: Meditation and Exercise (1 hour total).
4. FEEDBACK LOOP: Demand test scores and MCQ practice.
5. CSAT: Alternate days priority.

COMMUNICATION STYLE:
- Brutally Honest, Stoic, Data-Driven, Strictly UPSC Scope.`;

const ensureString = (val) => {
  if (val === null || val === undefined) return "";
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'object') {
    try {
      // Flatten simple objects for better readability in UI
      const entries = Object.entries(val);
      if (entries.length > 0) {
        return entries
          .map(([k, v]) => {
            const label = k.charAt(0).toUpperCase() + k.slice(1);
            const content = typeof v === 'object' ? JSON.stringify(v) : v;
            return `${label}: ${content}`;
          })
          .join('\n');
      }
      return JSON.stringify(val);
    } catch (e) {
      return "[Object Content]";
    }
  }
  return String(val);
};

const tryParseJSON = (text) => {
  if (!text) return null;
  try {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    return JSON.parse(match[0].replace(/```json|```/gi, '').trim());
  } catch (e) {
    return null;
  }
};

const getQuestionsCrux = async (questions) => {
  if (!questions || questions.length === 0) return [];
  try {
    const prompt = questions.map((q, i) => `Q${i + 1}: ${q.questionText || q.topic}`).join('\n\n');
    const response = await getGroqClient().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are an UPSC expert. For each question provided, give a 1-sentence "crux" (core concept) being tested. Return ONLY a JSON array of strings.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    });
    const parsed = tryParseJSON(response.choices[0].message.content);
    return Array.isArray(parsed) ? parsed : questions.map(q => q.topic || 'UPSC Concept');
  } catch (e) {
    console.error('getQuestionsCrux error:', e);
    return questions.map(q => q.topic || 'UPSC Concept');
  }
};

const fallbackParseSyllabus = (syllabusText = '') => {
  const raw = String(syllabusText || '').trim();
  if (!raw) return [];
  const cleanedLines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-*•]+/, '').replace(/^\(?[ivxlcdm]+\)?[.)-]?\s+/i, '').replace(/^\d+[\].)-]?\s+/, '').trim())
    .filter(Boolean);
  const seen = new Set();
  const chapters = [];
  for (const line of cleanedLines) {
    const compact = line.replace(/\s+/g, ' ').trim();
    const key = compact.toLowerCase();
    if (key.length < 4 || key.length > 140 || seen.has(key)) continue;
    seen.add(key);
    chapters.push({ title: compact, estimatedHours: compact.length > 70 ? 3 : 2, status: 'not_started' });
    if (chapters.length >= 100) break;
  }
  return chapters;
};

export const aiService = {
  async parseSyllabus(syllabusText, subject) {
    try {
      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [{
          role: 'user',
          content: `Parse this UPSC syllabus for "${subject}" into a JSON array of chapters: [{"title": string, "estimatedHours": number, "status": "not_started"}].\nText:\n${syllabusText}`
        }],
        temperature: 0.2
      });
      const text = response.choices[0].message.content.trim();
      const match = text.match(/\[[\s\S]*\]/);
      return match ? JSON.parse(match[0]) : fallbackParseSyllabus(syllabusText);
    } catch (err) {
      return fallbackParseSyllabus(syllabusText);
    }
  },

  async parseAnswerKeyFromText({ answerKeySection, totalQuestions }) {
    try {
      const response = await getGroqClient().chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'system',
          content: 'Extract UPSC answer key into JSON: {"1": "A", "2": "C"}. Only JSON output.'
        }, {
          role: 'user',
          content: `Text: ${answerKeySection}`
        }],
        temperature: 0.1
      });
      const text = response.choices[0].message.content.trim();
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    } catch (err) {
      return {};
    }
  },

  async mentorChat({ message, conversationHistory, user }) {
    try {
      const userId = user._id;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const [dailyLogs, activeMissions, todayAttempts] = await Promise.all([
        DailyTracker.find({ userId }).sort({ date: -1 }).limit(3),
        Mission.find({ userId, status: 'active' }),
        TestAttempt.find({ userId, submittedAt: { $gte: today } }).sort({ submittedAt: -1 })
      ]);
      const contextSummary = `Student: ${user.name}\nMissions: ${activeMissions.map(m => m.subject).join(',')}\nRecent Logs: ${dailyLogs.length}\nToday Tests: ${todayAttempts.length}`;
      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [
          { role: 'system', content: MENTOR_SYSTEM_PROMPT + '\n' + contextSummary },
          ...(conversationHistory || []),
          { role: 'user', content: message }
        ],
        temperature: 0.7
      });
      return response.choices[0].message.content;
    } catch (err) {
      return "I'm focusing on your data. Tell me, how was your accuracy today?";
    }
  },

  async generateSchedule({ user, activeMissions, sources, recentEntries, avoidedSubjects = [], additionalInstruction = '', currentScheduleBlocks = [], scheduleWindow = null, targetDateStr = '' }) {
    try {
      const SCHEDULER_SYSTEM_PROMPT = `You are a Precision UPSC Scheduler. 
Your goal is to interleave Mandatory tasks with Mission-specific tasks.

CORE PROTOCOLS:
1. MISSION PRIORITY: Use the "Today Plan" from active missions. These are top priority.
2. MERGE MANDATORY: If a mission involves Answer Writing or MCQ practice, that block fulfills BOTH the mission and the mandatory requirement. DO NOT create two separate blocks for the same activity.
3. AVOID DUPLICATION: Do not give multiple separate slots to one mission unless the hours required exceed a single block's capacity (usually 2-3h).
4. RELEVANCE: Focus on specific topics/chapters provided in the mission's todayPlan.
5. MANDATORY DEFAULTS: 1h Fitness, 1h Answer Writing, 2h CSAT (alternate days).

OUTPUT: JSON ARRAY ONLY. [{"subject": string, "focus": string, "startTime": "HH:MM", "endTime": "HH:MM", "priority": number, "taskType": string}]`;

      const todayStr = targetDateStr || new Date().toISOString().slice(0, 10);

      const prunedMissions = activeMissions.map(m => {
        const todayTasks = (m.dailyPlan || []).filter(p => {
          const pDateStr = new Date(p.date).toISOString().slice(0, 10);
          return pDateStr === todayStr && !p.completed;
        });

        return {
          subject: m.subject,
          title: m.title,
          todayPlan: todayTasks.map(t => t.chapters).flat(),
          dailyHoursRequired: m.dailyHoursRequired || 3,
          progress: `${m.completedChapters}/${m.totalChapters}`
        };
      });

      const prunedSources = sources.map(s => ({
        title: s.title,
        subject: s.subject,
        type: s.type
      }));

      const prompt = `CURRENT DATE: ${todayStr}
Student: ${user.name}
ACTIVE MISSIONS (INTEGRATE THESE): ${JSON.stringify(prunedMissions)}
Library Context: ${JSON.stringify(prunedSources)}
Available Window: ${scheduleWindow?.startTime} to ${scheduleWindow?.endTime}
User Custom Instruction: ${additionalInstruction}

INSTRUCTIONS:
- For each Mission, create a block using topics from 'todayPlan'.
- If a mission's todayPlan involves writing or practice, set taskType to 'answer_writing' or 'mcq'.
- Ensure "Answer Writing" (1h) and "Fitness" (1h) are covered. If a mission handles Answer Writing, just add the rest of the mandatory tasks (Fitness/CSAT).`;

      // console.log('[AI Schedule] Prompt length:', prompt.length, '| Missions:', prunedMissions.length);

      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [
          { role: 'system', content: SCHEDULER_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2000,
        temperature: 0.3
      });
      const text = response.choices[0].message.content.trim();
      const match = text.match(/\[[\s\S]*\]/);
      return match ? JSON.parse(match[0]) : [];
    } catch (err) {
      console.error('[AI Schedule] NVIDIA API failed, trying Groq:', err.response?.data?.error?.message || err.message);
      
      try {
        const groqResponse = await getGroqClient().chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: SCHEDULER_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2000,
          temperature: 0.3
        });
        const text = groqResponse.choices[0].message.content.trim();
        const match = text.match(/\[[\s\S]*\]/);
        return match ? JSON.parse(match[0]) : [];
      } catch (groqErr) {
        console.error('[AI Schedule] Groq also failed:', groqErr.message);
        return [];
      }
    }
  },

  async generateTestPerformanceReview({ user, attempt, mockTest, questionBank }) {
    try {
      const wrongQuestions = questionBank.filter(q => !q.isCorrect);
      const correctQuestions = questionBank.filter(q => q.isCorrect === true);
      const unattemptedQuestions = questionBank.filter(q => q.isCorrect === null || q.isCorrect === undefined || q.isCorrect === 'unattempted');
      
      const validForCrux = wrongQuestions.slice(0, 15);
      const validForStrengths = correctQuestions.slice(0, 15);
      const cruxes = await getQuestionsCrux(validForCrux);
      const strengthCruxes = await getQuestionsCrux(validForStrengths);

      const accuracyRate = ((attempt.correctCount / (attempt.correctCount + (attempt.wrongCount || 0) || 1)) * 100).toFixed(1);
      const totalAccuracy = ((attempt.correctCount / (mockTest.totalQuestions || 100)) * 100).toFixed(1);
      const percentageScore = (attempt.percentage || 0).toFixed(1);

      const payload = {
        score: attempt.score,
        accuracyAttempted: `${accuracyRate}% (Strike Rate - Correct/Attempted)`,
        accuracyTotal: `${totalAccuracy}% (Overall Accuracy - Correct/Total)`,
        percentageScore: `${percentageScore}% (Final Score)`,
        correct: attempt.correctCount,
        wrong: attempt.wrongCount,
        skipped: attempt.unattemptedCount,
        totalQuestions: mockTest.totalQuestions || 100,
        attempted: (attempt.correctCount || 0) + (attempt.wrongCount || 0),
        wrongSample: validForCrux.map((item, i) => ({
          qNo: item.questionNumber,
          crux: cruxes[i] || item.topic,
          topic: item.topic || 'General Studies'
        })),
        strengthSample: validForStrengths.map((item, i) => ({
          qNo: item.questionNumber,
          crux: strengthCruxes[i] || item.topic,
          topic: item.topic || 'General Studies'
        })),
        unattemptedCount: unattemptedQuestions.length
      };

      const systemPrompt = `You are ARJUN, a high-performance UPSC Mentor. 
Speak DIRECTLY to the student (use "You", "Your", "You missed"). 
Do not give generic advice. Be extremely granular with topics. 
For example Instead of "Polity", identify the exact sub-topic like "Governor's Pardoning Power" or "Fundamental Duties",instead of Economy identify the exact sub-topic like "GDP vs GVA",instead of Environment identify the exact sub-topic like "Biodiversity Hotspots" and so on as per the question.

Return ONLY JSON:
{ 
  "headline": "[Accuracy]% Strike Rate - [Direct Mentorship Message to 'You']",
  "summary": { "strengths": ["Granular Sub-Topic from CORRECT questions (e.g., Pre-Mauryan Age)"], "studyRecommendations": "Directed advice for 'You' naming specific books" },
  "topicList": ["Granular Sub-Topic (e.g., GDP vs GVA)"], 
  "strategy": ["Immediate action for 'You'"], 
  "deepAnalysis": [{"qNo": number, "topic": "Granular Sub-Topic", "questionText": "Concept Crux", "analysis": "Speak to 'You'. Explain the concept and what 'You' must read."}] 
}

REQUIREMENTS:
1. Headline must contain the Strike Rate (Correct/Attempted).
2. STRENGTHS: Find strengths from the "strengthSample" array (questions user got RIGHT). These are topics user knows well.
3. WEAK AREAS: Find weak areas from the "wrongSample" array (questions user got WRONG) and "unattemptedCount" (questions not attempted).
4. All topics MUST be granular sub-topics (e.g., "Sixth Schedule" NOT "Polity").
5. Analysis must address the user directly: "You confused X with Y. You must read Spectrum Chapter 5 for this."`;

      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this UPSC Attempt for ${user.name}: ${JSON.stringify(payload)}` }
        ],
        max_tokens: 3500,
        temperature: 0.2
      });

      const parsed = tryParseJSON(response.choices[0].message.content);
      if (!parsed) throw new Error("AI returned invalid JSON structure");

      return {
        headline: ensureString(parsed.headline) || `${accuracyRate}% Strike Rate - Keep Pushing`,
        summary: {
          strengths: Array.isArray(parsed.summary?.strengths) ? parsed.summary.strengths.map(ensureString) : ["Attempted test"],
          studyRecommendations: ensureString(parsed.summary?.studyRecommendations) || "Review weak topics."
        },
        topicList: Array.isArray(parsed.topicList) ? parsed.topicList.map(ensureString) : [],
        strategy: Array.isArray(parsed.strategy) ? parsed.strategy.map(ensureString) : [],
        deepAnalysis: (Array.isArray(parsed.deepAnalysis) ? parsed.deepAnalysis : []).map(m => ({
          qNo: Number(m.qNo) || 0,
          topic: ensureString(m.topic),
          questionText: ensureString(m.questionText),
          analysis: ensureString(m.analysis)
        }))
      };
    } catch (err) {
      console.error('Review Error:', err);
      return {
        headline: "Performance Review Processed",
        summary: { strengths: ["Test submitted"], studyRecommendations: "Manual review of weak areas suggested." },
        topicList: [], strategy: [], deepAnalysis: []
      };
    }
  },

  async generateTargetedFeedback({ user, attempt, mockTest, wrongQuestions }) {
    try {
      const accuracy = Math.round((attempt.correctCount / (attempt.correctCount + (attempt.wrongCount || 0) || 1)) * 100);

      const maxToAnalyze = 15;
      const subset = (wrongQuestions || []).slice(0, maxToAnalyze);
      const deepAnalysis = [];

      // console.log(`[Arjun AI] Analyzing ${subset.length} wrong questions...`);

      for (const wq of subset) {
        try {
          const res = await getGroqClient().chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
              {
                role: "system",
                content: `You are ARJUN, a high-performance UPSC Mentor speaking DIRECTLY to the student.
Identify the exact GRANULAR SUB-TOPIC from the UPSC syllabus (e.g., "Governor's Pardoning Power" instead of "Polity").
Provide a PERSONALIZED DEEP ANALYSIS:
- Use "You" and "Your". (e.g., "You missed this because...")
- Explain the logic/article/fact tested.
- Explain why YOUR choice was wrong and the correct logic.
- ADVICE: Name specific source (e.g., Laxmikanth, NCERT Class 11 Fine Arts) 'You' must read.

Return JSON:
{
  "coreTopic": "Granular Sub-Topic Name",
  "crux": "1-sentence core concept",
  "analysis": "Direct mentorship explanation for 'You'",
  "advice": "Specific reading reference for 'You'"
}
All values must be plain strings.`
              },
              { role: "user", content: `QUESTION:\n${wq.questionText}\n\nYour Choice: ${wq.userChoice}\nCorrect Answer: ${wq.correctAnswer}` }
            ],
            response_format: { type: "json_object" },
            max_tokens: 800
          });

          const parsed = tryParseJSON(res.choices[0].message.content);
          if (parsed) {
            const mapped = {
              qNo: Number(wq.questionNumber),
              topic: ensureString(parsed.coreTopic || parsed.topic || 'General Studies'),
              questionText: ensureString(wq.questionText),
              analysis: ensureString(parsed.analysis),
              mentorAdvice: ensureString(parsed.advice || parsed.mentorAdvice),
              coreTopic: ensureString(parsed.coreTopic || parsed.topic || 'General Studies')
            };
            deepAnalysis.push(mapped);

            // Immediate DB Update with string safety
            if (attempt?._id) {
              await TestAttempt.updateOne(
                { _id: attempt._id, 'userAnswers.questionNumber': mapped.qNo },
                {
                  $set: {
                    'userAnswers.$.coreTopic': mapped.coreTopic,
                    'userAnswers.$.mentorAdvice': mapped.mentorAdvice
                  }
                }
              ).catch(e => console.error(`DB Update failed for Q${mapped.qNo}:`, e.message));
            }
          }
        } catch (e) {
          console.error(`Error analyzing Q${wq.questionNumber}:`, e.message);
        }
      }

      return {
        headline: `${accuracy}% Strike Rate - Deep Analysis`,
        summary: {
          strengths: [`${accuracy}% Strike Rate`],
          studyRecommendations: "Targeted revision recommended for weak topics.",
        },
        topicList: [...new Set(deepAnalysis.map(d => d.topic))],
        deepAnalysis
      };
    } catch (err) {
      console.error('Targeted Feedback Critical Error:', err);
      return null;
    }
  },

  async intelligentParseExam({ questionText, solutionText, subject }) {
    try {
      const response = await getGroqClient().chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are an expert UPSC Exam Parser. 
            Analyze the provided raw question paper text and solution/explanation text carefully.
            
            GOAL: Extract a perfectly structured question bank.
            
            INSTRUCTIONS:
            1. OBJECT MAPPING: Every question must be correctly paired with its corresponding solution using the question number.
            2. CLEANING: 
               - Remove headers, footers, page numbers.
               - Strip watermarks or noise like "100%, 75%".
               - Fix OCR artifacts (e.g., "0" instead of "D" if it's an option).
            3. FORMATTING: 
               - Preserve mathematical notations, indented lists, or quotes within questionText.
               - Ensure options (a, b, c, d) are cleanly separated.
            4. CORRECTNESS: 
               - The "correctAnswer" must be EXACTLY one of: "A", "B", "C", "D".
               - The "explanation" must be comprehensive, including any factual references or logic provided in the solution text.
            5. HANDLING EDGE CASES:
               - If a question has more than 4 options, try to merge the extra into the question text or ignore.
               - If no explicit "Ans)" marker exists, deduce the answer from the explanation context.
            
            OUTPUT SCHEMA (Strictly JSON Array of Objects):
            [
              {
                "questionNumber": number,
                "question": "Full multi-line question text here",
                "options": {
                  "a": "text for option a",
                  "b": "text for option b",
                  "c": "text for option c",
                  "d": "text for option d"
                },
                "correctAnswer": "A",
                "solution": "Full detailed explanation text here"
              }
            ]`

          },
          {
            role: 'user',
            content: `SUBJECT: ${subject}\n\nQUESTION PAPER TEXT:\n${questionText}\n\nSOLUTION/ANSWER KEY TEXT:\n${solutionText}`
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 8000,
        temperature: 0.1
      });

      const text = response.choices[0].message.content.trim();
      const parsed = tryParseJSON(text);

      // The AI might return { "questions": [...] } or just the array
      if (parsed && Array.isArray(parsed)) return parsed;
      if (parsed && parsed.questions && Array.isArray(parsed.questions)) return parsed.questions;

      return null;
    } catch (err) {
      console.error('Intelligent Parse Error:', err);
      return null;
    }
  },

  async formatTableQuestion(questionText) {
    try {
      const response = await getGroqClient().chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'system',
          content: `You are an expert UPSC parser. The user will provide a match-the-column or pairs-based question.
Your goal is to reformat ONLY the tabular or paired data part into a perfect HTML table.
Return the ENTIRE question text, with the list/pairs perfectly formatted into an HTML <table>.
Maintain all text outside the table as standard HTML paragraphs <p>.
Add sleek styling to your table and cells using Tailwind classes similar to "border border-ink-800 text-sm text-left p-3". Make it look beautiful and readable in a dark mode UI.
Do not wrap your output in markdown code blocks (\`\`\`html) - return ONLY the raw HTML string.`
        }, {
          role: 'user',
          content: questionText
        }],
        temperature: 0.1
      });
      let html = response.choices[0].message.content.trim();
      if (html.startsWith('```html')) {
        html = html.replace(/^```html|```$/g, '').trim();
      } else if (html.startsWith('```')) {
        html = html.replace(/^```|```$/g, '').trim();
      }
      return html;
    } catch (err) {
      console.error('AI Table Formatting Error:', err);
      return null;
    }
  }
};
