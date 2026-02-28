

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import cron from 'node-cron';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import libraryRoutes from './routes/library.js';
import missionRoutes from './routes/missions.js';
import trackerRoutes from './routes/tracker.js';
import scheduleRoutes from './routes/schedule.js';
import mentorRoutes from './routes/mentor.js';
import testRoutes from './routes/tests.js';
import mockTestRoutes from './routes/mockTest.js';          // NEW
import ddayRoutes from './routes/dday.js';
import { schedulerService } from './services/schedulerService.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000', methods: ['GET', 'POST'] }
});

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '50mb' }));                   // CHANGED: was 10mb
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => { req.io = io; next(); });
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/tracker', trackerRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/mentor', mentorRoutes);
app.use('/api/tests', testRoutes);
app.use('/api/mock-tests', mockTestRoutes);                 // NEW
app.use('/api/d-day', ddayRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
});

const keepAliveUrl = process.env.KEEP_ALIVE_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/health` : null);
if (keepAliveUrl) {
  cron.schedule('*/13 * * * *', async () => {
    try {
      const response = await fetch(keepAliveUrl);
      if (!response.ok) {
        console.warn(`Keep-alive ping failed with status ${response.status}`);
      }
    } catch (error) {
      console.error('Keep-alive ping error:', error.message);
    }
  });
}

cron.schedule('0 23 * * *', async () => {
  await schedulerService.generateNightlySchedules();
});

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/upsc-pos')
  .then(() => {
    const PORT = process.env.PORT || 5000;
    httpServer.listen(PORT, () => {
      console.info(`Server running on port ${PORT}`);
      console.info('MongoDB connected');
    });
  })
  .catch(err => console.error('MongoDB connection error:', err));

export { io };
