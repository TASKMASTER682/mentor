import express from 'express';
import axios from 'axios';
import { authenticate } from '../middleware/auth.js';
import YouTubeCourse from '../models/YouTubeCourse.js';
import UserCourseProgress from '../models/UserCourseProgress.js';

const router = express.Router();
router.use(authenticate);

function getYouTubeApiKey() {
  return process.env.YOUTUBE_API_KEY;
}

function parseYouTubeUrl(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      if (pattern === patterns[0]) {
        const videoId = match[1];
        const playlistMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        return {
          type: playlistMatch ? 'playlist' : 'video',
          videoId,
          playlistId: playlistMatch ? playlistMatch[1] : null
        };
      } else {
        return { type: 'playlist', playlistId: match[1] };
      }
    }
  }
  return null;
}

function formatDuration(isoDuration) {
  if (!isoDuration) return '0:00';
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '0:00';
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function parseDurationToSeconds(isoDuration) {
  if (!isoDuration) return 0;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

async function fetchVideoDetails(videoIds) {
  const YOUTUBE_API_KEY = getYouTubeApiKey();
  const results = [];
  
  // YouTube API allows max 50 video IDs per request
  const batchSize = 50;
  for (let i = 0; i < videoIds.length; i += batchSize) {
    const batch = videoIds.slice(i, i + batchSize);
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,contentDetails',
        id: batch.join(','),
        key: YOUTUBE_API_KEY
      }
    });
    
    results.push(...response.data.items.map(item => ({
      videoId: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
      duration: formatDuration(item.contentDetails.duration),
      durationSeconds: parseDurationToSeconds(item.contentDetails.duration)
    })));
  }
  
  return results;
}

async function fetchPlaylistItems(playlistId) {
  const YOUTUBE_API_KEY = getYouTubeApiKey();
  const videos = [];
  let nextPageToken = null;
  
  do {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
        key: YOUTUBE_API_KEY
      }
    });
    
    const items = response.data.items.map(item => ({
      videoId: item.contentDetails.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
      position: item.snippet.position
    }));
    
    videos.push(...items);
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);
  
  return videos;
}

router.get('/', async (req, res) => {
  try {
    const courses = await YouTubeCourse.find({ userId: req.user._id }).sort({ addedAt: -1 });
    const progressList = await UserCourseProgress.find({ userId: req.user._id });
    
    const coursesWithProgress = courses.map(course => {
      const progress = progressList.find(p => p.courseId.toString() === course._id.toString());
      if (progress) {
        const progressObj = progress.toObject({ virtuals: true });
        return {
          ...course.toObject(),
          progress: {
            percentage: progressObj.progressPercentage,
            completedVideos: progressObj.completedVideos,
            totalVideos: course.videos.length,
            lastWatchedVideoId: progressObj.lastWatchedVideoId
          }
        };
      }
      return {
        ...course.toObject(),
        progress: null
      };
    });
    
    res.json(coursesWithProgress);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/add', async (req, res) => {
  try {
    const { url, subject } = req.body;
    
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });
    
    const YOUTUBE_API_KEY = getYouTubeApiKey();
    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({ error: 'YouTube API key not configured on server' });
    }
    
    const parsed = parseYouTubeUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Invalid YouTube URL' });
    
    const existing = await YouTubeCourse.findOne({ userId: req.user._id, youtubeId: parsed.playlistId || parsed.videoId });
    if (existing) return res.status(400).json({ error: 'This course already exists in your library' });
    
    let courseData;
    
    if (parsed.type === 'playlist') {
      const playlistResponse = await axios.get('https://www.googleapis.com/youtube/v3/playlists', {
        params: {
          part: 'snippet',
          id: parsed.playlistId,
          key: YOUTUBE_API_KEY
        }
      }).catch(err => {
        throw new Error(`YouTube API error: ${err.response?.data?.error?.message || err.message}`);
      });
      
      if (!playlistResponse.data.items?.length) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      
      const playlistInfo = playlistResponse.data.items[0];
      const playlistVideos = await fetchPlaylistItems(parsed.playlistId);
      
      const videoIds = playlistVideos.map(v => v.videoId);
      const videoDetails = await fetchVideoDetails(videoIds);
      
      const videos = playlistVideos.map((v, idx) => {
        const details = videoDetails.find(d => d.videoId === v.videoId);
        return {
          videoId: v.videoId,
          title: v.title,
          description: v.description,
          thumbnail: v.thumbnail,
          duration: details?.duration || '0:00',
          durationSeconds: details?.durationSeconds || 0,
          position: idx
        };
      });
      
      courseData = {
        userId: req.user._id,
        youtubeId: parsed.playlistId,
        type: 'playlist',
        title: playlistInfo.snippet.title,
        description: playlistInfo.snippet.description,
        thumbnail: playlistInfo.snippet.thumbnails?.medium?.url || playlistInfo.snippet.thumbnails?.default?.url,
        channelName: playlistInfo.snippet.channelTitle,
        videos,
        totalVideos: videos.length,
        subject: subject || ''
      };
    } else {
      const videoDetails = await fetchVideoDetails([parsed.videoId]);
      
      if (!videoDetails.length) {
        return res.status(404).json({ error: 'Video not found' });
      }
      
      const video = videoDetails[0];
      
      courseData = {
        userId: req.user._id,
        youtubeId: parsed.videoId,
        type: 'video',
        title: video.title,
        description: video.description,
        thumbnail: video.thumbnail,
        channelName: '',
        videos: [{
          videoId: video.videoId,
          title: video.title,
          description: video.description,
          thumbnail: video.thumbnail,
          duration: video.duration,
          durationSeconds: video.durationSeconds,
          position: 0
        }],
        totalVideos: 1,
        subject: subject || ''
      };
    }
    
    const course = new YouTubeCourse(courseData);
    await course.save();
    
    const progress = new UserCourseProgress({
      userId: req.user._id,
      courseId: course._id,
      videos: course.videos.map(v => ({ videoId: v.videoId, completed: false }))
    });
    await progress.save();
    
    res.status(201).json({
      ...course.toObject(),
      progress: { percentage: 0, completedVideos: 0, totalVideos: course.videos.length }
    });
  } catch (err) {
    console.error('Error adding YouTube course:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const course = await YouTubeCourse.findOne({ _id: req.params.id, userId: req.user._id });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    
    const progress = await UserCourseProgress.findOne({ courseId: course._id, userId: req.user._id });
    
    if (progress) {
      const progressObj = progress.toObject({ virtuals: true });
      res.json({ 
        course, 
        progress: {
          percentage: progressObj.progressPercentage,
          completedVideos: progressObj.completedVideos,
          videos: progressObj.videos,
          lastWatchedVideoId: progressObj.lastWatchedVideoId,
          lastWatchedAt: progressObj.lastWatchedAt,
          completedAt: progressObj.completedAt
        }
      });
    } else {
      res.json({ course, progress: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await YouTubeCourse.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    await UserCourseProgress.deleteMany({ courseId: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/video/:videoId/complete', async (req, res) => {
  try {
    const course = await YouTubeCourse.findOne({ _id: req.params.id, userId: req.user._id });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    
    let progress = await UserCourseProgress.findOne({ courseId: course._id, userId: req.user._id });
    
    if (!progress) {
      progress = new UserCourseProgress({
        userId: req.user._id,
        courseId: course._id,
        videos: course.videos.map(v => ({ videoId: v.videoId, completed: false }))
      });
    }
    
    const videoIndex = progress.videos.findIndex(v => v.videoId === req.params.videoId);
    if (videoIndex === -1) {
      progress.videos.push({ videoId: req.params.videoId, completed: true, completedAt: new Date() });
    } else {
      progress.videos[videoIndex].completed = true;
      progress.videos[videoIndex].completedAt = new Date();
    }
    
    progress.lastWatchedVideoId = req.params.videoId;
    progress.lastWatchedAt = new Date();
    
    if (progress.videos.every(v => v.completed)) {
      progress.completedAt = new Date();
    }
    
    await progress.save();
    
    const updatedCourse = await YouTubeCourse.findById(course._id);
    const progressObj = progress.toObject({ virtuals: true });
    
    res.json({
      progress: {
        percentage: progressObj.progressPercentage,
        completedVideos: progressObj.completedVideos,
        videos: progressObj.videos,
        lastWatchedVideoId: progressObj.lastWatchedVideoId,
        lastWatchedAt: progressObj.lastWatchedAt,
        completedAt: progressObj.completedAt,
        totalVideos: progressObj.videos.length
      },
      course: updatedCourse
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/video/:videoId/incomplete', async (req, res) => {
  try {
    const course = await YouTubeCourse.findOne({ _id: req.params.id, userId: req.user._id });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    
    const progress = await UserCourseProgress.findOne({ courseId: course._id, userId: req.user._id });
    if (!progress) return res.status(404).json({ error: 'Progress not found' });
    
    const videoIndex = progress.videos.findIndex(v => v.videoId === req.params.videoId);
    if (videoIndex !== -1) {
      progress.videos[videoIndex].completed = false;
      progress.videos[videoIndex].completedAt = null;
      progress.completedAt = null;
    }
    
    await progress.save();
    
    const progressObj = progress.toObject({ virtuals: true });
    
    res.json({
      progress: {
        percentage: progressObj.progressPercentage,
        completedVideos: progressObj.completedVideos,
        videos: progressObj.videos,
        lastWatchedVideoId: progressObj.lastWatchedVideoId,
        totalVideos: progressObj.videos.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/watched/:videoId', async (req, res) => {
  try {
    const course = await YouTubeCourse.findOne({ _id: req.params.id, userId: req.user._id });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    
    let progress = await UserCourseProgress.findOne({ courseId: course._id, userId: req.user._id });
    
    if (!progress) {
      progress = new UserCourseProgress({
        userId: req.user._id,
        courseId: course._id,
        videos: course.videos.map(v => ({ videoId: v.videoId, completed: false }))
      });
    }
    
    const existingVideo = progress.videos.find(v => v.videoId === req.params.videoId);
    if (!existingVideo) {
      progress.videos.push({ videoId: req.params.videoId, completed: false });
    }
    
    progress.lastWatchedVideoId = req.params.videoId;
    progress.lastWatchedAt = new Date();
    
    await progress.save();
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
