import express from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { Course, Lesson } from '../models/Course.js';
import UserCourseProgress from '../models/UserCourseProgress.js';
import UserCourseEnrollment from '../models/UserCourseEnrollment.js';
import User from '../models/User.js';

const router = express.Router();

const checkEnrollment = async (userId, courseId) => {
  if (!userId) return false;
  const enrollment = await UserCourseEnrollment.findOne({ 
    userId, 
    courseId, 
    status: 'completed' 
  });
  return !!enrollment;
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { subject, category } = req.query;
    
    const isAdmin = req.user.role === 'admin';
    
    const filter = { isPublished: true };
    if (subject) filter.subject = subject;
    if (category) filter.category = category;

    const courses = await Course.find(filter).sort({ order: 1, createdAt: -1 });
    
    const coursesWithInfo = await Promise.all(courses.map(async (course) => {
      const enrollment = await UserCourseEnrollment.findOne({ 
        courseId: course._id, 
        userId: req.user._id,
        status: 'completed'
      });
      
      const lessons = await Lesson.find({ courseId: course._id }).sort({ order: 1 });
      const previewLesson = lessons.find(l => l.isPreview);
      
      return {
        ...course.toObject(),
        lessonCount: lessons.length,
        isEnrolled: !!enrollment || course.price === 0 || isAdmin,
        isOwned: !!enrollment,
        previewLessonId: previewLesson?._id,
        previewVideoId: previewLesson?.videoId
      };
    }));

    res.json(coursesWithInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';

    const course = await Course.findOne({ 
      _id: req.params.id, 
      isPublished: true 
    });
    
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const enrollment = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'completed'
    });

    const isEnrolled = !!enrollment || course.price === 0 || isAdmin;

    if (!isEnrolled) {
      return res.status(403).json({ 
        error: 'Course not enrolled',
        requiresEnrollment: true,
        price: course.price,
        courseName: course.title
      });
    }

    const lessons = await Lesson.find({ courseId: course._id }).sort({ order: 1 });
    const progress = await UserCourseProgress.findOne({ 
      courseId: course._id, 
      userId: req.user._id 
    });

    res.json({
      course: {
        ...course.toObject(),
        isEnrolled,
        lessons: lessons.map(l => {
          const lessonProgress = progress?.videos?.find(v => v.videoId === l._id.toString());
          return {
            _id: l._id,
            title: l.title,
            description: l.description,
            thumbnail: l.thumbnail,
            duration: l.duration,
            durationSeconds: l.durationSeconds,
            order: l.order,
            isPreview: l.isPreview,
            isCompleted: lessonProgress?.completed || false
          };
        })
      },
      progress: progress ? {
        percentage: progress.progressPercentage,
        completedLessons: progress.completedVideos,
        totalLessons: lessons.length,
        lessons: progress.videos,
        lastWatchedLessonId: progress.lastWatchedVideoId,
        lastWatchedAt: progress.lastWatchedAt
      } : { percentage: 0, completedLessons: 0, totalLessons: lessons.length }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/lesson/:lessonId/video', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';

    const course = await Course.findOne({ 
      _id: req.params.id, 
      isPublished: true 
    });
    
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const enrollment = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'completed'
    });

    const isEnrolled = !!enrollment || course.price === 0 || isAdmin;

    const lesson = await Lesson.findOne({ 
      _id: req.params.lessonId, 
      courseId: course._id 
    });
    
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    if (!isEnrolled && !lesson.isPreview) {
      return res.status(403).json({ 
        error: 'Course not enrolled',
        requiresEnrollment: true,
        price: course.price
      });
    }

    let progress = await UserCourseProgress.findOne({ 
      courseId: course._id, 
      userId: req.user._id 
    });

    let videoProgress = null;
    if (progress?.videos) {
      videoProgress = progress.videos.find(v => v.videoId === lesson._id.toString());
    }
    
    const viewCount = videoProgress?.viewCount || 0;
    const maxViews = lesson.maxViews || course.maxViews || 2;
    
    console.log(`[ViewCheck] User: ${req.user.email}, Role: ${req.user.role}, Lesson: ${lesson.title}, Views: ${viewCount}/${maxViews}`);

    // Check limit (Temporarily removed admin exemption for user testing)
    if (viewCount >= maxViews) {
      return res.status(403).json({ 
        error: 'Maximum view limit reached for this lesson',
        viewLimitReached: true
      });
    }

    res.json({
      videoId: lesson.videoId,
      title: lesson.title,
      duration: lesson.duration,
      courseId: course._id,
      lessonId: lesson._id,
      maxViews,
      viewsRemaining: maxViews - viewCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/lesson/:lessonId/increment-view', authenticate, async (req, res) => {
  try {
    const { id: courseId, lessonId } = req.params;
    
    const course = await Course.findById(courseId);
    const lesson = await Lesson.findById(lessonId);
    if (!course || !lesson) return res.status(404).json({ error: 'Not found' });

    const maxViews = lesson.maxViews || course.maxViews || 2;
    
    let progress = await UserCourseProgress.findOne({ 
      courseId, 
      userId: req.user._id 
    });

    const now = new Date();

    if (!progress) {
      progress = new UserCourseProgress({
        userId: req.user._id,
        courseId,
        videos: [{
          videoId: lessonId,
          viewCount: 1,
          lastViewedAt: now
        }],
        lastWatchedVideoId: lessonId,
        lastWatchedAt: now
      });
      await progress.save();
    } else {
      const videoProgress = progress.videos.find(v => v.videoId === lessonId);
      if (videoProgress) {
        const lastView = videoProgress.lastViewedAt ? new Date(videoProgress.lastViewedAt) : new Date(0);
        const diffMinutes = (now.getTime() - lastView.getTime()) / (1000 * 60);
        
        if (diffMinutes < 1) {
          console.log(`[ViewIncrement] Skipping (Debounce): ${diffMinutes.toFixed(2)} mins since last view`);
          return res.json({ success: true, message: 'Recently incremented, skipping' });
        }

        if (videoProgress.viewCount >= maxViews) {
          console.log(`[ViewIncrement] Limit hit for ${req.user.email}`);
          return res.status(403).json({ error: 'Limit reached' });
        }
        
        console.log(`[ViewIncrement] Incrementing for ${req.user.email}. New count: ${videoProgress.viewCount + 1}`);
        await UserCourseProgress.updateOne(
          { _id: progress._id, 'videos.videoId': lessonId },
          { 
            $inc: { 'videos.$.viewCount': 1 },
            $set: { 'videos.$.lastViewedAt': now }
          }
        );
      } else {
        await UserCourseProgress.updateOne(
          { _id: progress._id },
          { 
            $push: { 
              videos: { 
                videoId: lessonId,
                viewCount: 1,
                lastViewedAt: now
              }
            }
          }
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/lesson/:lessonId/complete', authenticate, async (req, res) => {
  try {
    const { courseId, id: courseIdParam } = req.params;
    
    const course = await Course.findOne({ 
      _id: courseIdParam, 
      isPublished: true 
    });
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const enrollment = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'completed'
    });

    const isEnrolled = !!enrollment || course.price === 0 || req.user.role === 'admin';
    if (!isEnrolled) {
      return res.status(403).json({ error: 'Course not enrolled' });
    }

    const lesson = await Lesson.findOne({ 
      _id: req.params.lessonId, 
      courseId: course._id 
    });
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    let progress = await UserCourseProgress.findOne({ 
      courseId: course._id, 
      userId: req.user._id 
    });

    if (!progress) {
      const allLessons = await Lesson.find({ courseId: course._id });
      progress = new UserCourseProgress({
        userId: req.user._id,
        courseId: course._id,
        videos: allLessons.map(l => ({ videoId: l._id.toString(), completed: false }))
      });
    }

    const videoIndex = progress.videos.findIndex(v => v.videoId === lesson._id.toString());
    if (videoIndex === -1) {
      progress.videos.push({ 
        videoId: lesson._id.toString(), 
        completed: true, 
        completedAt: new Date() 
      });
    } else {
      progress.videos[videoIndex].completed = true;
      progress.videos[videoIndex].completedAt = new Date();
    }

    progress.lastWatchedVideoId = lesson._id.toString();
    progress.lastWatchedAt = new Date();

    if (progress.videos.every(v => v.completed)) {
      progress.completedAt = new Date();
    }

    await progress.save();

    res.json({
      progress: {
        percentage: progress.progressPercentage,
        completedLessons: progress.completedVideos,
        videos: progress.videos,
        lastWatchedLessonId: progress.lastWatchedVideoId
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/lesson/:lessonId/incomplete', authenticate, async (req, res) => {
  try {
    const course = await Course.findOne({ 
      _id: req.params.id, 
      isPublished: true 
    });
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const enrollment = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'completed'
    });

    const isEnrolled = !!enrollment || course.price === 0 || req.user.role === 'admin';
    if (!isEnrolled) {
      return res.status(403).json({ error: 'Course not enrolled' });
    }

    const videoIndex = progress.videos.findIndex(v => v.videoId === req.params.lessonId);
    if (videoIndex !== -1) {
      progress.videos[videoIndex].completed = false;
      progress.videos[videoIndex].completedAt = null;
      progress.completedAt = null;
    }

    await progress.save();

    res.json({
      progress: {
        percentage: progress.progressPercentage,
        completedLessons: progress.completedVideos,
        videos: progress.videos
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/lesson/:lessonId/progress', authenticate, async (req, res) => {
  try {
    const course = await Course.findOne({ 
      _id: req.params.id, 
      isPublished: true 
    });
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const enrollment = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'completed'
    });

    const isEnrolled = !!enrollment || course.price === 0 || req.user.role === 'admin';
    if (!isEnrolled) {
      return res.status(403).json({ error: 'Course not enrolled' });
    }

    const { watchTime } = req.body;
    
    let progress = await UserCourseProgress.findOne({ 
      courseId: req.params.id, 
      userId: req.user._id 
    });

    if (!progress) {
      const course = await Course.findById(req.params.id);
      if (!course) return res.status(404).json({ error: 'Course not found' });
      
      const lessons = await Lesson.find({ courseId: course._id });
      progress = new UserCourseProgress({
        userId: req.user._id,
        courseId: course._id,
        videos: lessons.map(l => ({ videoId: l._id.toString(), completed: false }))
      });
    }

    const videoIndex = progress.videos.findIndex(v => v.videoId === req.params.lessonId);
    if (videoIndex !== -1) {
      progress.videos[videoIndex].watchTime = (progress.videos[videoIndex].watchTime || 0) + (watchTime || 0);
    }

    progress.lastWatchedVideoId = req.params.lessonId;
    progress.lastWatchedAt = new Date();

    await progress.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const courses = await Course.find().sort({ order: 1, createdAt: -1 });
    const coursesWithLessons = await Promise.all(courses.map(async (course) => {
      const lessonCount = await Lesson.countDocuments({ courseId: course._id });
      return { ...course.toObject(), lessonCount };
    }));
    res.json(coursesWithLessons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin', requireAdmin, async (req, res) => {
  try {
    if (req.body.thumbnail && req.body.thumbnail.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image size too large. Max 1MB allowed.' });
    }
    const course = new Course(req.body);
    await course.save();
    res.status(201).json(course);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/:id', requireAdmin, async (req, res) => {
  try {
    if (req.body.thumbnail && req.body.thumbnail.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image size too large. Max 1MB allowed.' });
    }
    const course = await Course.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    await Course.findByIdAndDelete(req.params.id);
    await Lesson.deleteMany({ courseId: req.params.id });
    await UserCourseProgress.deleteMany({ courseId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/:id/lessons', requireAdmin, async (req, res) => {
  try {
    const lessons = await Lesson.find({ courseId: req.params.id }).sort({ order: 1 });
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/:id/lessons', requireAdmin, async (req, res) => {
  try {
    if (req.body.thumbnail && req.body.thumbnail.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image size too large. Max 1MB allowed.' });
    }
    const lesson = new Lesson({ ...req.body, courseId: req.params.id });
    await lesson.save();
    res.status(201).json(lesson);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/lessons/:lessonId', requireAdmin, async (req, res) => {
  try {
    if (req.body.thumbnail && req.body.thumbnail.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image size too large. Max 1MB allowed.' });
    }
    const lesson = await Lesson.findByIdAndUpdate(req.params.lessonId, req.body, { new: true });
    res.json(lesson);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/lessons/:lessonId', requireAdmin, async (req, res) => {
  try {
    await Lesson.findByIdAndDelete(req.params.lessonId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/enroll', authenticate, async (req, res) => {
  try {
    const { courseId, pricePaid, paymentId } = req.body;
    
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const existing = await UserCourseEnrollment.findOne({
      userId: req.user._id,
      courseId
    });
    if (existing) return res.status(400).json({ error: 'Already enrolled' });

    const enrollment = new UserCourseEnrollment({
      userId: req.user._id,
      courseId,
      pricePaid: pricePaid || course.price,
      paymentId,
      status: 'completed'
    });
    await enrollment.save();

    res.status(201).json(enrollment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/my-enrollments', authenticate, async (req, res) => {
  try {
    const enrollments = await UserCourseEnrollment.find({ 
      userId: req.user._id,
      status: 'completed'
    }).populate('courseId');
    res.json(enrollments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;