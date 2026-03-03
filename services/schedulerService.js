

import User from '../models/User.js';
import Schedule from '../models/Schedule.js';
import Mission from '../models/Mission.js';
import LibrarySource from '../models/LibrarySource.js';
import DailyTracker from '../models/DailyTracker.js';
import TestAttempt from '../models/TestAttempt.js';          // NEW
import { aiService } from './aiService.js';

const toMinutes = (hhmm = '00:00') => {
  const [h, m] = String(hhmm).split(':').map((v) => Number(v) || 0);
  return (h * 60) + m;
};

const toHHMM = (totalMinutes = 0) => {
  const safe = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  const hours = Math.floor(safe / 60).toString().padStart(2, '0');
  const minutes = (safe % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

const normalizeWindow = (window) => {
  if (!window?.startTime || !window?.endTime) return null;
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);
  if (end <= start) return null;
  return { start, end, startTime: toHHMM(start), endTime: toHHMM(end) };
};

const REQUIRED_DAILY_BLOCKS = [
  {
    key: 'fitness',
    requiredMinutes: 60,
    subject: 'Fitness & Mental Conditioning',
    topic: 'Exercise, breath-work, and meditation',
    taskType: 'fitness',
    priority: 'high',
  },
  {
    key: 'csat',
    requiredMinutes: 120,
    subject: 'CSAT',
    topic: 'Quantitative aptitude and reasoning practice',
    taskType: 'mcq',
    priority: 'high',
  },
  {
    key: 'answer_writing',
    requiredMinutes: 60,
    subject: 'Answer Writing',
    topic: 'Structured UPSC answer writing practice',
    taskType: 'answer_writing',
    priority: 'high',
  },
];

const classifyRequiredBlock = (block = {}) => {
  const text = `${block.subject || ''} ${block.topic || ''} ${block.focus || ''} ${block.taskType || ''}`.toLowerCase();
  if (text.includes('csat')) return 'csat';
  if (text.includes('answer writing') || text.includes('answer_writing') || block.taskType === 'answer_writing') {
    return 'answer_writing';
  }
  if (text.includes('fitness') || text.includes('exercise') || text.includes('meditation') || text.includes('mental')) {
    return 'fitness';
  }
  return null;
};

export const schedulerService = {
  async generateScheduleForUser(user, options = {}) {
    try {
      const { additionalInstruction = '', currentSchedule = null, resetRefinements = false, scheduleWindow = null } = options;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const activeMissions = await Mission.find({ userId: user._id, status: 'active' }).sort({ priority: 1, deadline: 1 });
      const sources = await LibrarySource.find({ userId: user._id });

      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const recentEntries = await DailyTracker.find({ userId: user._id, date: { $gte: weekAgo } });
      const subjectCompletionMap = {};
      recentEntries.forEach(entry => {
        entry.tasks.forEach(task => {
          if (!subjectCompletionMap[task.subject]) subjectCompletionMap[task.subject] = { completed: 0, total: 0 };
          subjectCompletionMap[task.subject].total++;
          if (task.status === 'completed') subjectCompletionMap[task.subject].completed++;
        });
      });

      const avoidedSubjects = Object.entries(subjectCompletionMap)
        .filter(([_, v]) => v.total > 0 && v.completed / v.total < 0.5)
        .map(([k]) => k);
      const recentAttempts = await TestAttempt.find({ userId: user._id })
        .sort({ submittedAt: -1 }).limit(2);

      const testWeakSubjects = [];
      recentAttempts.forEach(a => {
        if (a.aiFeedback?.prioritySubjects?.length) {
          testWeakSubjects.push(...a.aiFeedback.prioritySubjects);
        } else if (a.subjectBreakdown?.length) {
          a.subjectBreakdown
            .filter(s => s.accuracy < 40 && s.total >= 3)
            .forEach(s => testWeakSubjects.push(s.subject));
        }
      });
      const allWeakSubjects = [...new Set([...testWeakSubjects, ...avoidedSubjects])];

      const inferredWindow = (() => {
        if (!Array.isArray(currentSchedule?.blocks) || currentSchedule.blocks.length === 0) return null;
        const first = currentSchedule.blocks[0];
        const last = currentSchedule.blocks[currentSchedule.blocks.length - 1];
        return normalizeWindow({ startTime: first?.startTime, endTime: last?.endTime });
      })();
      let effectiveWindow = normalizeWindow(scheduleWindow) || inferredWindow;
      if (!effectiveWindow) {
        const now = new Date();
        const startMinutes = (now.getHours() * 60) + now.getMinutes();
        const roundedStart = Math.min(23 * 60, Math.ceil(startMinutes / 15) * 15);
        const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
        effectiveWindow = {
          start: roundedStart,
          end: 23 * 60,
          startTime: toHHMM(roundedStart),
          endTime: '23:00'
        };
      }

      const blocks = await aiService.generateSchedule({
        user, sources, activeMissions, recentEntries,
        avoidedSubjects: allWeakSubjects,
        additionalInstruction,
        currentScheduleBlocks: Array.isArray(currentSchedule?.blocks) ? currentSchedule.blocks : [],
        scheduleWindow: effectiveWindow,
      });

      const fitBlocksToWindow = (inputBlocks = [], window) => {
        if (!window) return inputBlocks;

        let cursor = window.start;
        const out = [];

        for (const block of inputBlocks) {
          if (cursor >= window.end) break;

          const parsedDuration = this.calculateDuration(block?.startTime, block?.endTime);
          const plannedDuration = Number(block?.plannedDurationMinutes) || 0;
          const dailyHours = Number(block?.dailyHoursRequired);
          const fallbackDuration = Number.isFinite(dailyHours) && dailyHours > 0
            ? Math.min(180, Math.round(dailyHours * 60))
            : 60;
          const duration = plannedDuration > 0 ? plannedDuration : (parsedDuration > 0 ? parsedDuration : fallbackDuration);
          const end = Math.min(window.end, cursor + duration);
          if (end <= cursor) continue;

          out.push({
            ...block,
            startTime: toHHMM(cursor),
            endTime: toHHMM(end),
          });
          cursor = end;
        }

        return out;
      };

      const ensureMandatoryBlocks = (inputBlocks = [], window) => {
        if (!window) return inputBlocks;

        const windowMinutes = window.end - window.start;
        if (windowMinutes <= 0) return inputBlocks;

        const totals = { fitness: 0, csat: 0, answer_writing: 0 };
        const existingMandatory = [];
        const optional = [];

        inputBlocks.forEach((block) => {
          const category = classifyRequiredBlock(block);
          const parsedDuration = this.calculateDuration(block?.startTime, block?.endTime);
          const plannedDuration = Number(block?.plannedDurationMinutes) || 0;
          const duration = plannedDuration > 0 ? plannedDuration : (parsedDuration > 0 ? parsedDuration : 60);

          if (category) {
            totals[category] += duration;
            existingMandatory.push(block);
          } else {
            optional.push(block);
          }
        });

        const requiredTotal = REQUIRED_DAILY_BLOCKS.reduce((sum, r) => sum + r.requiredMinutes, 0);
        const scale = windowMinutes < requiredTotal ? windowMinutes / requiredTotal : 1;

        const missingBlocks = REQUIRED_DAILY_BLOCKS
          .map((req) => {
            const target = Math.max(20, Math.round(req.requiredMinutes * scale));
            const missing = Math.max(0, target - (totals[req.key] || 0));
            if (missing <= 0) return null;
            return {
              subject: req.subject,
              topic: req.topic,
              taskType: req.taskType,
              priority: req.priority,
              plannedDurationMinutes: missing,
            };
          })
          .filter(Boolean);

        // Create a priority map for missions
        const missionSubjects = new Set(activeMissions.map(m => m.subject));

        // Categorize optional blocks into Mission and Non-Mission
        const missionBlocks = [];
        const otherBlocks = [];

        optional.forEach(block => {
          if (missionSubjects.has(block.subject)) {
            missionBlocks.push(block);
          } else {
            otherBlocks.push(block);
          }
        });

        // ENFORCE MISSIONS: Ensure every mission subject has at least one block
        const coveredMissionSubjects = new Set([...missionBlocks, ...existingMandatory].map(b => b.subject));
        const missingMissionBlocks = activeMissions
          .filter(m => !coveredMissionSubjects.has(m.subject))
          .map(m => ({
            subject: m.subject,
            topic: m.title,
            focus: "Mission Study Block",
            taskType: 'learning',
            priority: 1,
            plannedDurationMinutes: Math.max(60, Math.round((m.dailyHoursRequired || 2) * 60 / 2)) // Add a placeholder block
          }));

        // Interleave missing mandatory and missing mission blocks
        return [
          ...existingMandatory,
          ...missionBlocks,
          ...missingMissionBlocks,
          ...missingBlocks,
          ...otherBlocks
        ];
      };

      const sourceBlocks = Array.isArray(blocks) ? blocks : [];
      const mandatoryFirstBlocks = ensureMandatoryBlocks(sourceBlocks, effectiveWindow);
      const normalizedBlocks = fitBlocksToWindow(mandatoryFirstBlocks, effectiveWindow);

      const scheduledBlocks = normalizedBlocks
        .map(block => {
          const mission = activeMissions.find(m => m.subject === block.subject);
          if (!block.startTime || !block.endTime) {
            console.warn('schedulerService: skipping incomplete block', block);
            return null;
          }
          let mappedPriority = 'medium';
          if (typeof block.priority === 'string' && ['high', 'medium', 'low'].includes(block.priority)) {
            mappedPriority = block.priority;
          } else if (typeof block.priority === 'number') {
            mappedPriority = block.priority <= 1 ? 'high' : block.priority <= 2 ? 'medium' : 'low';
          }
          const taskType = ['learning', 'revision', 'answer_writing', 'mcq', 'test', 'break', 'fitness'].includes(block.taskType)
            ? block.taskType
            : 'learning';

          return {
            ...block,
            topic: block.topic || block.focus || 'Targeted study block',
            taskType,
            priority: mappedPriority,
            date: today.toISOString().slice(0, 10),
            missionId: mission?._id,
            duration: this.calculateDuration(block.startTime, block.endTime)
          };
        })
        .filter(Boolean);

      const totalPlannedHours = scheduledBlocks.reduce((sum, b) => sum + (b.duration / 60), 0);
      let aiRationale;
      if (activeMissions.length > 0) {
        aiRationale = `Mission mode active: ${activeMissions[0].title} gets priority.${avoidedSubjects.length > 0 ? ` Forcing ${avoidedSubjects.join(', ')} into schedule.` : ''}`;
      } else if (testWeakSubjects.length > 0) {
        const unique = [...new Set(testWeakSubjects)].slice(0, 3).join(', ');
        aiRationale = `Balanced plan. Mock test weak areas prioritized: ${unique}.`;
      } else {
        aiRationale = 'Balanced study plan based on your library and performance data.';
      }

      const updatePayload = {
        userId: user._id,
        date: today,
        blocks: scheduledBlocks,
        totalPlannedHours,
        activeMissions: activeMissions.map(m => m._id),
        aiRationale
      };
      if (resetRefinements) {
        updatePayload.refinementCount = 0;
        updatePayload.refinementNotes = [];
      }

      const schedule = await Schedule.findOneAndUpdate(
        { userId: user._id, date: today },
        updatePayload,
        { upsert: true, returnDocument: 'after' }
      );

      return schedule;
    } catch (err) {
      console.error('generateScheduleForUser error:', err);
      throw err;
    }
  },

  calculateDuration(startTime = '00:00', endTime = '00:00') {
    const safeSplit = (value) => {
      const parts = (value || '0:0').split(':').map(Number);
      return [parts[0] || 0, parts[1] || 0];
    };
    const [sh, sm] = safeSplit(startTime);
    const [eh, em] = safeSplit(endTime);
    return (eh * 60 + em) - (sh * 60 + sm);
  },

  async refineTodayScheduleForUser(user, instruction) {
    const cleanedInstruction = String(instruction || '').trim();
    if (!cleanedInstruction) {
      throw new Error('Instruction is required');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let schedule = await Schedule.findOne({ userId: user._id, date: today });
    if (!schedule) {
      schedule = await this.generateScheduleForUser(user, { resetRefinements: true });
    }

    const currentCount = Number(schedule.refinementCount) || 0;
    if (currentCount >= 2) {
      const limitError = new Error('Refinement limit reached');
      limitError.code = 'REFINEMENT_LIMIT';
      throw limitError;
    }

    const regenerated = await this.generateScheduleForUser(user, {
      additionalInstruction: cleanedInstruction,
      currentSchedule: schedule,
      resetRefinements: false,
    });

    const updated = await Schedule.findOneAndUpdate(
      { _id: regenerated._id, userId: user._id },
      {
        $set: {
          refinementCount: currentCount + 1,
          aiRationale: `${regenerated.aiRationale} | Refined with user instruction.`,
        },
        $push: {
          refinementNotes: {
            instruction: cleanedInstruction,
            createdAt: new Date(),
          }
        }
      },
      { returnDocument: 'after' }
    );

    return updated;
  },

  async generateNightlySchedules() {
    try {
      const users = await User.find({});
      for (const user of users) {
        await this.generateScheduleForUser(user);
      }
    } catch (err) {
      console.error('Nightly scheduler error:', err);
    }
  }
};

