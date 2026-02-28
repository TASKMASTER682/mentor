export const UPSC_MARKS = {
  CORRECT: 2.0,
  WRONG: -0.66,
  UNATTEMPTED: 0,
};
export function calculateScore(userAnswers, answerKey, marking = UPSC_MARKS) {
  const results = [];
  let correctCount = 0;
  let wrongCount = 0;
  let unattemptedCount = 0;
  let totalScore = 0;
  const keyMap = answerKey instanceof Map ? Object.fromEntries(answerKey) : answerKey;
  for (const [qNumStr, userAns] of Object.entries(userAnswers)) {
    const correctAns = keyMap[qNumStr] || keyMap[parseInt(qNumStr)];
    let isCorrect = null;
    let marksAwarded = marking.UNATTEMPTED;

    if (!userAns || userAns === null || userAns === '') {
      unattemptedCount++;
      marksAwarded = marking.UNATTEMPTED;
      isCorrect = null;
    } else if (!correctAns) {
      unattemptedCount++;
      marksAwarded = marking.UNATTEMPTED;
      isCorrect = null;
    } else if (userAns.toUpperCase() === correctAns.toUpperCase()) {
      correctCount++;
      marksAwarded = marking.CORRECT;
      isCorrect = true;
    } else {
      wrongCount++;
      marksAwarded = marking.WRONG;
      isCorrect = false;
    }

    totalScore += marksAwarded;
    results.push({
      questionNumber: parseInt(qNumStr),
      answer: userAns || null,
      isCorrect,
      marksAwarded,
      correctAnswer: correctAns || null,
    });
  }
  results.sort((a, b) => a.questionNumber - b.questionNumber);

  const totalQuestions = Object.keys(userAnswers).length;
  const maxScore = totalQuestions * marking.CORRECT;

  return {
    userAnswers: results,
    score: parseFloat(totalScore.toFixed(2)),
    maxScore,
    correctCount,
    wrongCount,
    unattemptedCount,
    percentage: parseFloat(((totalScore / maxScore) * 100).toFixed(2)),
  };
}
export function estimateSubjectFromRange(questionNumber) {
  if (questionNumber <= 15) return 'History';
  if (questionNumber <= 25) return 'Geography';
  if (questionNumber <= 40) return 'Polity';
  if (questionNumber <= 55) return 'Economy';
  if (questionNumber <= 65) return 'Environment';
  if (questionNumber <= 75) return 'Science & Tech';
  if (questionNumber <= 85) return 'Current Affairs';
  return 'General';
}
export function buildSubjectBreakdown(scoredAnswers, questions = []) {
  const subjectMap = {};
  const qSubjectMap = {};
  questions.forEach(q => {
    if (q.subject) qSubjectMap[q.number] = q.subject;
  });

  scoredAnswers.forEach(ans => {
    const subject = qSubjectMap[ans.questionNumber] || estimateSubjectFromRange(ans.questionNumber);
    if (!subjectMap[subject]) {
      subjectMap[subject] = { subject, total: 0, correct: 0, wrong: 0, unattempted: 0, score: 0 };
    }
    subjectMap[subject].total++;
    subjectMap[subject].score += ans.marksAwarded;
    if (ans.isCorrect === true) subjectMap[subject].correct++;
    else if (ans.isCorrect === false) subjectMap[subject].wrong++;
    else subjectMap[subject].unattempted++;
  });

  return Object.values(subjectMap).map(s => ({
    ...s,
    score: parseFloat(s.score.toFixed(2)),
    accuracy: s.total > 0 ? parseFloat(((s.correct / s.total) * 100).toFixed(1)) : 0,
  }));
}

