import Mission from '../models/Mission.js';

export const schedulerService = {

  calculateDuration(startTime = '00:00', endTime = '00:00') {
    const safeSplit = (value) => {
      const parts = (String(value) || '0:0').split(':').map(Number);
      return [parts[0] || 0, parts[1] || 0];
    };
    const [sh, sm] = safeSplit(startTime);
    const [eh, em] = safeSplit(endTime);
    return (eh * 60 + em) - (sh * 60 + sm);
  },

  toHHMM(totalMinutes = 0) {
    const safe = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
    const hours = Math.floor(safe / 60).toString().padStart(2, '0');
    const minutes = (safe % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  },

  getActiveMissions(userId) {
    return Mission.find({ 
      userId, 
      status: 'active' 
    });
  },

  calculatePriority(mission) {
    const remaining = mission.totalTarget - mission.completedValue;
    const days = Math.max(1, mission.remainingDays);
    return remaining / days;
  },

  convertToBlocks(totalMinutes) {
    if (totalMinutes <= 0) return [];
    const blocks = [];
    let remaining = totalMinutes;
    
    while (remaining > 0) {
      if (remaining >= 120) {
        blocks.push(120);
        remaining -= 120;
      } else if (remaining >= 60) {
        blocks.push(60);
        remaining -= 60;
      } else {
        blocks.push(remaining);
        remaining = 0;
      }
    }
    
    return blocks;
  },

  async generateDailyPlan(userId, availableHours) {
    const availableMinutes = availableHours * 60;
    
    const missions = await Mission.find({ 
      userId, 
      status: 'active' 
    }).sort({ priority: 1 });

    const activeMissions = missions.filter(m => {
      const now = new Date();
      return m.status === 'active' && m.startDate <= now && m.endDate >= now;
    });

    if (activeMissions.length === 0) {
      return {
        allocations: [],
        totalRequired: 0,
        totalAvailable: availableMinutes,
        deficit: 0,
        message: 'No active missions'
      };
    }

    const sortedMissions = activeMissions.map(m => ({
      ...m.toObject(),
      priorityScore: this.calculatePriority(m),
      dailyRequired: m.dailyRequired
    })).sort((a, b) => b.priorityScore - a.priorityScore);

    const allocations = [];
    let remainingMinutes = availableMinutes;
    let totalRequired = 0;

    for (const mission of sortedMissions) {
      if (remainingMinutes <= 0) break;

      const remaining = mission.totalTarget - mission.completedValue;
      const days = Math.max(1, mission.remainingDays);
      const dailyNeeded = remaining / days;
      
      totalRequired += dailyNeeded;

      const assignMinutes = Math.min(dailyNeeded, remainingMinutes);
      
      allocations.push({
        missionId: mission._id,
        missionName: mission.name,
        allocatedMinutes: assignMinutes,
        dailyRequired: dailyNeeded,
        blocks: this.convertToBlocks(assignMinutes),
        remainingHours: remaining,
        daysLeft: days
      });

      remainingMinutes -= assignMinutes;
    }

    const deficit = Math.max(0, totalRequired - availableMinutes);
    const excess = Math.max(0, availableMinutes - totalRequired);

    return {
      allocations,
      totalRequired,
      totalAvailable: availableMinutes,
      deficit: deficit > 0 ? deficit : 0,
      excessHours: excess > 0 ? excess / 60 : 0,
      shouldIncreaseBy: deficit > 0 ? Math.ceil(totalRequired / 60) - availableHours : 0
    };
  },

  async logProgress(missionId, userId, value, type = 'hours') {
    const mission = await Mission.findOne({ _id: missionId, userId });
    if (!mission) throw new Error('Mission not found');

    const completedValue = type === 'hours' ? value : value;
    mission.completedValue += completedValue;

    if (mission.completedValue >= mission.totalTarget) {
      mission.status = 'completed';
      mission.completedAt = new Date();
    }

    await mission.save();
    return mission;
  },

  async recalculateMission(mission) {
    const remaining = mission.totalTarget - mission.completedValue;
    const days = Math.max(1, mission.remainingDays);
    const dailyRequired = remaining / days;

    mission.missedDays = days < Math.ceil((mission.endDate - mission.startDate) / (1000 * 60 * 60 * 24)) 
      ? mission.missedDays + 1 
      : mission.missedDays;

    await mission.save();
    return {
      ...mission.toObject(),
      dailyRequired
    };
  },

  getMissionStats(mission) {
    const remaining = mission.totalTarget - mission.completedValue;
    const days = mission.remainingDays;
    const totalDays = Math.ceil((mission.endDate - mission.startDate) / (1000 * 60 * 60 * 24));
    const daysPassed = totalDays - days;
    const progressPercent = mission.progressPercent;
    
    const onTrack = progressPercent >= ((totalDays - days) / totalDays) * 100;

    return {
      remainingValue: remaining,
      remainingDays: days,
      totalDays,
      daysPassed,
      dailyRequired: remaining / days,
      progressPercent,
      onTrack,
      status: mission.status
    };
  }
};