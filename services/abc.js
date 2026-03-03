// async generateTestPerformanceReview({ user, attempt, mockTest, questionBank }) {
//   const testSubject = mockTest.subject || "UPSC General Studies";

//   const tryParseAnalysis = (rawText) => {
//     if (!rawText || typeof rawText !== 'string') return null;
//     try {
//       const jsonMatch = rawText.match(/\{[\s\S]*\}/);
//       const target = jsonMatch ? jsonMatch[0] : rawText;
//       return JSON.parse(target.replace(/```json|```/gi, '').trim());
//     } catch (e) { 
//       console.error("JSON Parse Failed");
//       return null; 
//     }
//   };

//   const buildFallbackAnalysis = () => ({
//     headline: `Performance Review: ${testSubject}`,
//     summary: { 
//       strengths: ["Attempted Test", "Basic Awareness"], 
//       studyRecommendations: "Deep analysis failed due to data mismatch. Please review your wrong answers manually." 
//     },
//     topicList: ["General Studies"],
//     strategy: ["Analyze wrong answers", "Revise NCERTs"],
//     deepAnalysis: []
//   });

//   try {
//     // 1. STAGE 1: FILTER (Only meaningful questions)
//     const wrongQuestions = questionBank.filter(q => !q.isCorrect);
    
//     // Filter questions that actually have text or concepts
//     const validForCrux = wrongQuestions.filter(q => 
//         q.questionText && 
//         q.questionText.length > 10 && 
//         !q.questionText.toLowerCase().includes("no text available")
//     ).slice(0, 15);

//     // 2. STAGE 2: GET CRUX (Groq Integration)
//     // Ab hum wahi 'cruxes' array mangwa rahe hain jo aapne abhi nikala
//     const cruxes = validForCrux.length > 0 ? await getQuestionsCrux(validForCrux) : [];

//     // 3. STAGE 3: BUILD PAYLOAD (Connecting Crux to Payload)
//     const payload = {
//       userName: user.name,
//       testName: mockTest.name,
//       score: attempt.score,
//       accuracy: `${attempt.percentage}%`,
//       totalQuestions: mockTest.totalQuestions || 100,
//       correctCount: attempt.correctCount || 0,
//       wrongCount: attempt.wrongCount || 0,
//       // mapping cruxes back to the wrong sample
//       wrongSample: validForCrux.map((item, i) => ({
//         qNo: item.questionNumber,
//         // Crux ko hi Question Text bana kar bhej rahe hain taaki AI ko "Context" mile
//         questionText: cruxes[i] || item.topic || "UPSC Concept Review",
//         topic: item.topic || "Static GS",
//         userChoice: item.userChoice ?? 'N/A',
//         correctAnswer: item.correctAnswer ?? 'N/A'
//       }))
//     };

//     // 4. STAGE 4: SYSTEM PROMPT
//     const systemPrompt = `You are Arjun AI Mentor - a high-performance UPSC mentor. 
//     Analyze the 'wrongSample' which contains conceptual cruxes of wrong answers.
//     Return ONLY JSON:
//     - headline: String
//     - summary: { strengths: Array(specific correct topics), studyRecommendations: String }
//     - topicList: Array (specific weak topics)
//     - strategy: Array (mentor-like actionable steps)
//     - deepAnalysis: Array of { qNo: Number, topic: String, questionText: String, analysis: String }

//     REQUIREMENTS:
//     1. Use the 'questionText' (which is a concept crux) to give specific UPSC advice.
//     2. Be direct and authoritative. Use phrases like "You must master...", "Don't confuse X with Y".
//     3. If questionText mentions 'Citizenship Act', your analysis must talk about Articles 5-11 or CAA.
//     4. Provide at least 15 deep analysis items if data is available.`;

//     const response = await getOpenAIClient().chat.completions.create({
//       model: 'yentinglin/llama-3-taiwan-70b-instruct',
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: `Analyze this UPSC attempt: ${JSON.stringify(payload)}` },
//       ],
//       temperature: 0.1,
//       max_tokens: 2500
//     });



//     const aiContent = response.choices[0].message.content.trim();
//     const rawParsed = tryParseAnalysis(aiContent);

//     if (rawParsed) {
//       // Mapping back the AI response to your frontend structure
//       return {
//         headline: rawParsed.headline || `Mentor Analysis for ${user.name}`,
//         // summary: rawParsed.summary,
//         summary: {
//           strengths: (rawParsed.summary?.strengths?.length > 0) 
//             ? rawParsed.summary.strengths 
//             : [`Scored ${attempt.score} marks`, `${attempt.correctCount} correct answers`, "Basic awareness of UPSC pattern"],
//           studyRecommendations: rawParsed.summary?.studyRecommendations || "Review your concepts."
//         },
//         topicList: rawParsed.topicList || [],
//         strategy: rawParsed.strategy || [] + rawParsed.summary.studyRecommendations,
//         deepAnalysis: (rawParsed.deepAnalysis || []).map(m => ({
//           qNo: m.qNo || 0,
//           topic: m.topic || "UPSC Concept",
//           questionText: m.questionText || "Concept Crux",
//           analysis: m.analysis || "Focus on this fundamental concept."
//         }))
//       };
//     }
    
//     return buildFallbackAnalysis();

//   } catch (err) {
//     console.error('Arjun Engine Error:', err);
//     return buildFallbackAnalysis();
//   }
// },