 import OpenAI from 'openai';
 import DailyTracker from '../models/DailyTracker.js'; 
import Mission from '../models/Mission.js';
import TestAttempt from '../models/TestAttempt.js'
import { extractUPSCVisualMap } from './pdfService.js'; // New function to extract question text from test PDFs


const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY ,
  baseURL: "https://api.groq.com/openai/v1"
});
let openai = null;

const getOpenAIClient = () => {
  if (!openai) {
    openai = new OpenAI({
      baseURL: process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY
    });
  }
  return openai;
};

const MENTOR_SYSTEM_PROMPT = `You are ARJUN - a high-performance UPSC Mentor (inspired by the focus of the legendary archer). 
You have access to the student's complete performance OS. You do not give generic advice.

CORE MANDATES (Non-Negotiable)that you have to include in the scedule:
1. ANSWER WRITING: Must happen for 1 hour daily, regardless of the situation. No excuses.
2. CURRENT AFFAIRS: 30 minutes daily is the baseline. 
3. MENTAL AND PHYSICAL FITNESS: Meditation, and Exercise (1 hour total) are part of the 'UPSC Athlete' protocol.
4. FEEDBACK LOOP: Studying without testing is a sin. Demand test scores and MCQ practice.
5. CSAT: Must be scheduled/discussed on alternate days as a priority.
6.Rest as per missions and library

COMMUNICATION STYLE:
- Brutally Honest: If the data shows procrastination, call it out. 
- Stoic & Motivational: Use the "Process over Fantasy" approach. Celebrate hard-earned wins, not just intentions.
- Data-Driven: Analyze the student's missions, test scores, and avoided subjects before answering.
- Strict Scope: Only discuss UPSC preparation, mindset, and discipline. Politely deflect anything else.

YOUR GOAL:
Identify patterns in the student's data, and act like his personal mentor and push him/her to achive daily schedule and targets.Dont ignore core mandates`;

const fallbackParseSyllabus = (syllabusText = '') => {
  const raw = String(syllabusText || '').trim();
  if (!raw) return [];

  const cleanedLines = raw
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^[\s\-*•]+/, '')
      .replace(/^\(?[ivxlcdm]+\)?[.)-]?\s+/i, '')
      .replace(/^\d+[\].)-]?\s+/, '')
      .trim())
    .filter(Boolean);

  const stopWords = new Set([
    'syllabus',
    'paper',
    'general studies',
    'upsc',
    'mains',
    'prelims',
    'optional subject',
    'section-a',
    'section-b',
  ]);

  const seen = new Set();
  const chapters = [];

  for (const line of cleanedLines) {
    const compact = line.replace(/\s+/g, ' ').trim();
    const key = compact.toLowerCase();
    if (key.length < 4 || key.length > 140) continue;
    if (stopWords.has(key)) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    chapters.push({
      title: compact,
      estimatedHours: compact.length > 70 ? 3 : compact.length > 35 ? 2 : 1,
      status: 'not_started',
    });
    if (chapters.length >= 120) break;
  }

  return chapters;
};

const normalizeParsedChapters = (list = []) => {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      title: String(item?.title || '').trim(),
      estimatedHours: Math.min(4, Math.max(1, Number(item?.estimatedHours) || 2)),
      status: 'not_started',
    }))
    .filter((item) => item.title.length > 0);
};

export const aiService = {
  async parseSyllabus(syllabusText, subject) {
    try {
      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [{
          role: 'user',
          content: `Parse this UPSC syllabus text for subject "${subject}" and return a JSON array of chapters. Each chapter should have: title (string), estimatedHours (number, 1-4), status ("not_started").\nSyllabus text:\n${syllabusText}\n\nReturn ONLY valid JSON array, no markdown.`
        }],
        max_tokens: 2000,
        temperature: 0.5
      });
      const text = response.choices[0].message.content.trim();
      const parsed = normalizeParsedChapters(JSON.parse(text));
      return parsed.length > 0 ? parsed : fallbackParseSyllabus(syllabusText);
    } catch (err) {
      console.error('parseSyllabus error:', err.message);
      return fallbackParseSyllabus(syllabusText);
    }
  },
  async generateMissionStrategy({ title, subject, chapters, daysAvailable, dailyHours, userProfile }) {
    try {
      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [
          { role: 'system', content: MENTOR_SYSTEM_PROMPT },
          { 
            role: 'user', 
            content: `Create a concise mission strategy for:\nMission: ${title}\nSubject: ${subject}\nChapters: ${chapters.length}\nDays available: ${daysAvailable}\nDaily hours for mission: ${dailyHours}\nAttempt year: ${userProfile.attemptYear}\n\nGive a 3-4 line strategic approach. Be specific and direct.` 
          }
        ],
        max_tokens: 300,
        temperature: 0.5
      });
      return response.choices[0].message.content;
    } catch (err) {
      return 'Focus on consistent daily progress.';
    }
  },
  async parseAnswerKeyFromText({ answerKeySection, regexParsed, totalQuestions }) {
    try {
      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [{
          role: 'system',
          content: `You are an Exam Data Processor. Output ONLY a valid JSON object like {"1":"A", "2":"B"}. No explanations.`
        }, {
          role: 'user',
          content: `Total Questions expected: ${totalQuestions}\nRegex already found: ${JSON.stringify(regexParsed)}\nNow, extract the full key from this text:\n${answerKeySection}`
        }],
        temperature: 0.1, 
        max_tokens: 2000
      });

      const text = response.choices[0].message.content.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : regexParsed;
    } catch (err) {
      console.error('parseAnswerKeyFromText error:', err);
      return regexParsed;
    }
  },


async mentorChat({ message, conversationHistory, user }) {
    try {
      const userId = user._id;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const [dailyLogs, activeMissions, todayAttempts] = await Promise.all([
        DailyTracker.find({ userId }).sort({ date: -1 }).limit(3),
        Mission.find({ userId, status: 'active' }),
        TestAttempt.find({ 
          userId, 
          submittedAt: { $gte: today } // Aaj ke attempts dhoondna
        }).sort({ submittedAt: -1 })
      ]);
      const testSummary = todayAttempts.length > 0
        ? todayAttempts.map(attempt => {
            const breakdown = attempt.subjectBreakdown
              .map(s => `${s.subject}: ${s.correct}/${s.total}`)
              .join(' | ');
            
            return `
- TEST: ${attempt.testName}
- SCORE: ${attempt.score}/${attempt.maxScore} (${attempt.percentage}%)
- ACCURACY: ${((attempt.correctCount / (attempt.correctCount + attempt.wrongCount)) * 100).toFixed(1)}%
- BREAKDOWN: ${breakdown}
- WEAK AREAS DETECTED: ${attempt.weakAreas?.join(', ') || 'None'}
            `;
          }).join('\n')
        : "No tests attempted today.";
      const trackerSummary = dailyLogs.length > 0 
        ? dailyLogs.map(day => {
            const tasks = day.tasks.map(t => `${t.subject}(${t.status})`).join(', ');
            return `- ${day.date.toISOString().split('T')[0]}: Mood: ${day.mood}, Tasks: ${tasks}`;
          }).join('\n')
        : "No study logs found.";
      const contextSummary = `
Student Profile: ${user.name}
---
TODAY'S TEST DATA:
${testSummary}
---
RECENT STUDY LOGS:
${trackerSummary}
---
ACTIVE MISSIONS: ${activeMissions.map(m => m.subject).join(', ')}
`;

      const messages = [
        { 
          role: 'system', 
          content: MENTOR_SYSTEM_PROMPT + '\n\n[STUDENT DB CONTEXT]\n' + contextSummary 
        },
        ...(conversationHistory || []),
        { role: 'user', content: message }
      ];

      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages,
        max_tokens: 1000, // Detailed response ke liye tokens badhaye
        temperature: 0.5
      });

      return response.choices[0].message.content;

    } catch (err) {
      console.error('ARJUN Chat Error:', err);
      return "I'm having trouble pulling your test data, but don't let that stop you. If you gave a test today, tell me—how was your accuracy in the static subjects?";
    }
},
   generateDailyInsight: async (data) => {
    const { 
      tasks = [], 
      focusScore = 5, 
      mood = 'neutral', 
      energyLevel = 'medium', 
      totalStudyHours = 0,
      notesPrepared = false,
      topicsNotUnderstood = []
    } = data;
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    
    let insight = "";
    let punchline = "";
    if (completionRate >= 90 && focusScore >= 8) {
      punchline = "Beast Mode ON! ⚡";
      insight = `Unstoppable performance today. Completing ${completedTasks}/${totalTasks} tasks with a focus score of ${focusScore}/10 is exactly how UPSC is cracked. `;
    } else if (completionRate >= 70) {
      punchline = "Solid Consistency. 🎯";
      insight = `Great rhythm today. You've covered the core of your schedule. `;
    } else if (completionRate >= 40) {
      punchline = "Keeping it alive. 🔄";
      insight = `You survived a tough day. Completing ${completionRate}% of your tasks is better than a zero day. `;
    } else {
      punchline = "Rest & Regroup. 🔋";
      insight = `Today was a struggle, but your ${mood} mood is temporary. Let's re-prioritize for tomorrow. `;
    }
    if (energyLevel === 'low' && completionRate > 50) {
      insight += "Impressive grit despite low energy. Take an extra hour of sleep tonight. ";
    }
    
    if (focusScore < 5) {
      insight += "Focus was shaky—try the Pomodoro technique tomorrow to avoid burnout. ";
    }

    if (topicsNotUnderstood.length > 0) {
      insight += `I've noted your difficulty in ${topicsNotUnderstood.join(', ')}. I'll adjust your next revision cycle to cover these. `;
    }

    if (notesPrepared) {
      insight += "Good job on the notes; your future self will thank you during revision! ";
    }
    return `${punchline} ${insight}`;
  },

  // async generateSchedule({ user, activeMissions, additionalInstruction = '', currentScheduleBlocks = [], scheduleWindow = null }) {
  //   try {
  //     const missionsPayload = JSON.stringify(activeMissions ?? [], null, 2);
  //     const currentPlanSummary = Array.isArray(currentScheduleBlocks) && currentScheduleBlocks.length > 0
  //       ? currentScheduleBlocks.slice(0, 20).map((b) => `${b.startTime}-${b.endTime} ${b.subject}: ${b.topic}`).join('\n')
  //       : 'No existing schedule blocks.';

  //     const prompt = [
  //       'Generate a JSON study schedule tailored to the missions below.',
  //       `Missions: ${missionsPayload}`,
  //       `Current schedule blocks (if any):\n${currentPlanSummary}`,
  //       scheduleWindow?.startTime && scheduleWindow?.endTime
  //         ? `Schedule window for this generation: start at ${scheduleWindow.startTime} and end by ${scheduleWindow.endTime}.`
  //         : 'Schedule window for this generation: use the full day as needed.',
  //       additionalInstruction ? `Additional user instruction for today:\n${additionalInstruction}` : 'Additional user instruction for today: None',
  //       '',
  //       'Output a single JSON array (no markdown) where each object represents one study block.',
  //       'Each block must include:',
  //       '- "subject": the mission subject (e.g., "Polity").',
  //       '- "focus": a short description of what should be studied.',
  //       '- "date": ISO date (YYYY-MM-DD).',
  //       '- "startTime": HH:MM (24h) when the block starts.',
  //       '- "endTime": HH:MM (24h) when the block ends.',
  //       '- "dailyHoursRequired": total hours per day for that subject, if known.',
  //       '- "priority": an integer (1 highest) if you need to order them.',
  //       '',
  //       'Planning rules:',
  //       '- Prioritize targets/tasks first, not clock precision.',
  //       '- The first block should be the most critical target chosen from mission priority/urgency.',
  //       '- Keep a logical sequence so high-priority targets come before lower-priority ones.',
  //       '- Time values are rough placeholders for flow; target ordering and coverage matter most.',
  //       '- Strictly keep blocks inside the given schedule window.',
  //       '- Day baseline starts at 07:00 unless a stricter schedule window start is provided.',
  //       '- Mandatory daily blocks: Physical + Mental fitness total 1 hour, CSAT total 2 hours, Answer Writing total 1 hour.',
  //       '- If additional user instruction asks to add something, include it in schedule.',
  //       '- If additional user instruction asks to remove/avoid something, remove it from schedule.',
  //       '- Balance remaining time using active missions and library-driven priorities.',
  //       '',
  //       'Arrange the blocks chronologically and keep them brief. Do not include explanations outside the JSON array.'
  //     ].join('\n\n');

  //     const response = await getOpenAIClient().chat.completions.create({
  //       model: 'yentinglin/llama-3-taiwan-70b-instruct',
  //       messages: [
  //         { role: 'system', content: MENTOR_SYSTEM_PROMPT },
  //         { role: 'user', content: prompt },
  //       ],
  //       max_tokens: 1500,
  //       temperature: 0.5,
  //     });

  //     const text = response.choices[0].message.content.trim();
      
  //     // Try to find JSON array in the response
  //     let payloadText = text;
      
  //     // Look for array pattern
  //     const arrayMatch = text.match(/\[[\s\S]*\]/);
  //     if (arrayMatch) {
  //       payloadText = arrayMatch[0];
  //     } else {
  //       // If no array found, try to find any JSON object
  //       const jsonMatch = text.match(/\{[\s\S]*\}/);
  //       if (jsonMatch) {
  //         payloadText = jsonMatch[0];
  //       }
  //     }
      
  //     try {
  //       const parsed = JSON.parse(payloadText);
  //       // Ensure it's an array
  //       return Array.isArray(parsed) ? parsed : [];
  //     } catch (err) {
  //       console.error('generateSchedule parse error. Raw response:', text.substring(0, 400));
  //       console.error('Payload text attempted:', payloadText.substring(0, 200));
  //       return [];
  //     }
  //   } catch (err) {
  //     console.error('generateSchedule error:', err);
  //     return [];
  //   }
  // },


  async generateSchedule({ user, activeMissions, additionalInstruction = '', currentScheduleBlocks = [], scheduleWindow = null }) {
    try {
      // --- 1. PERSONAL PROMPT FOR SCHEDULER (Independent of Master Prompt) ---
      const SCHEDULER_SYSTEM_PROMPT = `You are a Precision UPSC Scheduler. 
      Your ONLY job is to create a high-density, logical study timeline.
      
      CORE SCHEDULING PROTOCOLS:
      - 07:00 to 08:00: Physical & Mental Fitness (Mandatory).
      - Answer Writing: 1 Hour daily block (High Priority).
      - CSAT: 2 Hours daily block (Consistent Practice).
      - Mission Blocks: Remaining time allocated to Active Missions.
      - Sequencing: Hardest topics in the morning, revision/current affairs in the evening.
      - Output: STRICT JSON ARRAY ONLY. No conversational text.`;

      const missionsPayload = JSON.stringify(activeMissions ?? [], null, 2);
      const currentPlanSummary = Array.isArray(currentScheduleBlocks) && currentScheduleBlocks.length > 0
        ? currentScheduleBlocks.slice(0, 20).map((b) => `${b.startTime}-${b.endTime} ${b.subject}: ${b.topic}`).join('\n')
        : 'No existing schedule blocks.';

      // --- 2. DYNAMIC USER PROMPT ---
      const userPrompt = [
        `Generate a JSON study schedule for UPSC Aspirant: ${user.name}`,
        `Active Missions: ${missionsPayload}`,
        `Existing Blocks to avoid overlap: ${currentPlanSummary}`,
        `Time Window: ${scheduleWindow?.startTime || '07:00'} to ${scheduleWindow?.endTime || '23:00'}`,
        `Special User Instructions: ${additionalInstruction || 'None'}`,
        '',
        'STRICT JSON STRUCTURE REQUIRED:',
        '[{"subject": "String", "focus": "String", "date": "YYYY-MM-DD", "startTime": "HH:MM", "endTime": "HH:MM", "priority": Number}]'
      ].join('\n\n');

      const response = await getOpenAIClient().chat.completions.create({
        model: 'yentinglin/llama-3-taiwan-70b-instruct',
        messages: [
          // Yahan humne MENTOR_SYSTEM_PROMPT ki jagah apna naya SCHEDULER prompt dala hai
          { role: 'system', content: SCHEDULER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.2, // Temperature kam rakha hai taaki JSON format break na ho
      });

      let text = response.choices[0].message.content.trim();
      
      // Cleaning JSON Markdown if AI includes it
      text = text.replace(/```json|```/gi, '').trim();

      const arrayMatch = text.match(/\[[\s\S]*\]/);
      const payloadText = arrayMatch ? arrayMatch[0] : text;
      
      try {
        const parsed = JSON.parse(payloadText);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.error('Schedule Parse Error');
        return [];
      }
    } catch (err) {
      console.error('generateSchedule error:', err);
      return [];
    }
  },


async generateTestPerformanceReview({ user, attempt, mockTest, questionBank }) {
  const testSubject = mockTest.subject || "UPSC General Studies";

  const tryParseAnalysis = (rawText) => {
    if (!rawText || typeof rawText !== 'string') return null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const target = jsonMatch ? jsonMatch[0] : rawText;
      return JSON.parse(target.replace(/```json|```/gi, '').trim());
    } catch (e) { 
      console.error("JSON Parse Failed");
      return null; 
    }
  };

  const buildFallbackAnalysis = () => ({
    headline: `Performance Review: ${testSubject}`,
    summary: { 
      strengths: ["Attempted Test", "Basic Awareness"], 
      studyRecommendations: "Deep analysis failed due to data mismatch. Please review your wrong answers manually." 
    },
    topicList: ["General Studies"],
    strategy: ["Analyze wrong answers", "Revise NCERTs"],
    deepAnalysis: []
  });

  try {
    // 1. STAGE 1: FILTER (Only meaningful questions)
    const wrongQuestions = questionBank.filter(q => !q.isCorrect);
    
    // Filter questions that actually have text or concepts
    const validForCrux = wrongQuestions.filter(q => 
        q.questionText && 
        q.questionText.length > 10 && 
        !q.questionText.toLowerCase().includes("no text available")
    ).slice(0, 15);

    // 2. STAGE 2: GET CRUX (Groq Integration)
    // Ab hum wahi 'cruxes' array mangwa rahe hain jo aapne abhi nikala
    const cruxes = validForCrux.length > 0 ? await getQuestionsCrux(validForCrux) : [];

    // 3. STAGE 3: BUILD PAYLOAD (Connecting Crux to Payload)
    const payload = {
      userName: user.name,
      testName: mockTest.name,
      score: attempt.score,
      accuracy: `${attempt.percentage}%`,
      totalQuestions: mockTest.totalQuestions || 100,
      correctCount: attempt.correctCount || 0,
      wrongCount: attempt.wrongCount || 0,
      // mapping cruxes back to the wrong sample
      wrongSample: validForCrux.map((item, i) => ({
        qNo: item.questionNumber,
        // Crux ko hi Question Text bana kar bhej rahe hain taaki AI ko "Context" mile
        questionText: cruxes[i] || item.topic || "UPSC Concept Review",
        topic: item.topic || "Static GS",
        userChoice: item.userChoice ?? 'N/A',
        correctAnswer: item.correctAnswer ?? 'N/A'
      }))
    };

    // 4. STAGE 4: SYSTEM PROMPT
    const systemPrompt = `You are Arjun AI Mentor - a high-performance UPSC mentor. 
    Analyze the 'wrongSample' which contains conceptual cruxes of wrong answers.
    Return ONLY JSON:
    - headline: String
    - summary: { strengths: Array(specific correct topics), studyRecommendations: String }
    - topicList: Array (specific weak topics)
    - strategy: Array (mentor-like actionable steps)
    - deepAnalysis: Array of { qNo: Number, topic: String, questionText: String, analysis: String }

    REQUIREMENTS:
    1. Use the 'questionText' (which is a concept crux) to give specific UPSC advice.
    2. Be direct and authoritative. Use phrases like "You must master...", "Don't confuse X with Y".
    3. If questionText mentions 'Citizenship Act', your analysis must talk about Articles 5-11 or CAA.
    4. Provide at least 15 deep analysis items if data is available.`;

    const response = await getOpenAIClient().chat.completions.create({
      model: 'yentinglin/llama-3-taiwan-70b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this UPSC attempt: ${JSON.stringify(payload)}` },
      ],
      temperature: 0.1,
      max_tokens: 2500
    });



    const aiContent = response.choices[0].message.content.trim();
    const rawParsed = tryParseAnalysis(aiContent);

    if (rawParsed) {
      // Mapping back the AI response to your frontend structure
      return {
        headline: rawParsed.headline || `Mentor Analysis for ${user.name}`,
        // summary: rawParsed.summary,
        summary: {
          strengths: (rawParsed.summary?.strengths?.length > 0) 
            ? rawParsed.summary.strengths 
            : [`Scored ${attempt.score} marks`, `${attempt.correctCount} correct answers`, "Basic awareness of UPSC pattern"],
          studyRecommendations: rawParsed.summary?.studyRecommendations || "Review your concepts."
        },
        topicList: rawParsed.topicList || [],
        strategy: rawParsed.strategy || [] + rawParsed.summary.studyRecommendations,
        deepAnalysis: (rawParsed.deepAnalysis || []).map(m => ({
          qNo: m.qNo || 0,
          topic: m.topic || "UPSC Concept",
          questionText: m.questionText || "Concept Crux",
          analysis: m.analysis || "Focus on this fundamental concept."
        }))
      };
    }
    
    return buildFallbackAnalysis();

  } catch (err) {
    console.error('Arjun Engine Error:', err);
    return buildFallbackAnalysis();
  }
},




async generateWeeklyReport({ user, entries = [], missions = [] }) {
  try {
    const safeEntries = Array.isArray(entries) ? entries : [];
    const safeMissions = Array.isArray(missions) ? missions : [];

    if (safeEntries.length === 0) {
      return {
        headline: 'No tracker data in the last 7 days.',
        strengths: ['Start by submitting one complete daily report today.'],
        concerns: ['Weekly trend cannot be computed without tracker entries.'],
        mentorMessage: 'Discipline starts with tracking. Submit daily and I will optimize your next week.'
      };
    }

    const avgCompletion = Math.round(
      safeEntries.reduce((sum, e) => sum + (Number(e?.completionRate) || 0), 0) / safeEntries.length
    );
    const avgFocus = (
      safeEntries.reduce((sum, e) => sum + (Number(e?.focusScore) || 0), 0) / safeEntries.length
    ).toFixed(1);
    const completedDays = safeEntries.filter((e) => (Number(e?.completionRate) || 0) >= 70).length;

    const weakTopicCounts = new Map();
    safeEntries.forEach((e) => {
      const topics = Array.isArray(e?.topicsNotUnderstood) ? e.topicsNotUnderstood : [];
      topics.forEach((t) => {
        const topic = String(t || '').trim();
        if (!topic) return;
        weakTopicCounts.set(topic, (weakTopicCounts.get(topic) || 0) + 1);
      });
    });
    const topWeakTopics = [...weakTopicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([topic]) => topic);

    const activeMissionSubjects = safeMissions
      .filter((m) => m?.status === 'active')
      .map((m) => m?.subject)
      .filter(Boolean);

    return {
      headline: `${user?.name || 'Student'}: ${completedDays}/${safeEntries.length} high-performance days this week`,
      strengths: [
        `Average completion rate: ${avgCompletion}%`,
        `Average focus score: ${avgFocus}/10`,
        activeMissionSubjects.length > 0
          ? `Active mission focus: ${activeMissionSubjects.slice(0, 3).join(', ')}`
          : 'Mission pipeline is clear for the current week'
      ],
      concerns: topWeakTopics.length > 0
        ? [`Recurring weak areas: ${topWeakTopics.join(', ')}`]
        : ['No recurring weak topics captured in tracker entries'],
      mentorMessage: avgCompletion >= 70
        ? 'Strong consistency. Keep answer-writing daily and push one focused revision loop on weak areas.'
        : 'Execution is below target. Reduce scope, lock fixed study blocks, and submit complete tracker entries daily.'
    };
  } catch (err) {
    console.error('generateWeeklyReport error:', err);
    return {
      headline: 'Weekly report unavailable right now.',
      strengths: ['Try again in a moment.'],
      concerns: ['Could not compute weekly analytics due to a temporary error.'],
      mentorMessage: 'Stay on process; the report service will recover.'
    };
  }
}
};


async function getQuestionsCrux(wrongQuestions) {
  // 1. Filter: "No text available" aur khali questions ko raste mein hi rok lo
  const validQuestions = (wrongQuestions || []).filter(q => 
    q.questionText && 
    q.questionText.trim() !== "" && 
    !q.questionText.toLowerCase().includes("no text available") &&
    q.questionText.length > 15
  );

  if (!validQuestions.length) return [];

  try {
    // 2. Batch sirf VALID questions ka banega
    const batchPrompt = validQuestions.map((q) => 
      `Q${q.questionNumber}: ${q.questionText}`
    ).join("\n\n");

    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { 
          role: "system", 
          content: "You are a UPSC expert. Summarize each question into its core conceptual crux (max 12 words). Return ONLY a JSON object with a key 'cruxes' containing an array of strings." 
        },
        { role: "user", content: batchPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const content = JSON.parse(response.choices[0].message.content);
    console.log("Groq Valid Cruxes:", content);

    const finalCruxes = content.cruxes || (Array.isArray(content) ? content : Object.values(content)[0]);

    // Array extract karke return karein
    return Array.isArray(finalCruxes) ? finalCruxes : [];

  } catch (err) {
    console.error("Groq Error:", err.message);
    // Fallback mein bhi filter lagaya hai taaki Llama (NVIDIA) ko kachra na mile
    return validQuestions.map(q => q.topic || q.questionText?.slice(0, 100));
  }
}

