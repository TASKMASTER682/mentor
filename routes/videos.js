import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { parseTelegramUrl, resolveVideo, streamVideo } from '../services/telegramService.js';

const router = express.Router();

router.get('/get-tg-link', async (req, res) => {
  try {
    const { channel, msgId } = req.query;
    if (!channel || !msgId) {
      return res.status(400).json({ error: 'channel and msgId are required' });
    }
    const metadata = await resolveVideo(channel, msgId);
    res.json({
      channel: metadata.channel,
      msgId: metadata.msgId,
      mimeType: metadata.mimeType,
      size: metadata.size,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
    });
  } catch (err) {
    console.error('Telegram resolve failed:', err.message);
    res.status(500).json({ error: 'Failed to resolve Telegram video: ' + err.message });
  }
});

router.get('/stream', async (req, res) => {
  try {
    const { channel, msgId } = req.query;
    if (!channel || !msgId) {
      return res.status(400).json({ error: 'channel and msgId are required' });
    }

    const videoData = await resolveVideo(channel, msgId);
    const totalSize = videoData.size;
    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.setHeader('Content-Type', videoData.mimeType || 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', totalSize);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      if (req.method === 'HEAD') return res.status(200).end();

      const start = 0;
      const end = Math.min(256 * 1024 - 1, totalSize - 1);
      return await streamVideo(videoData, start, end, res);
    }

    const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!rangeMatch) {
      return res.status(416).json({ error: 'Invalid Range header' });
    }

    let start = rangeMatch[1] ? parseInt(rangeMatch[1]) : 0;
    let end = rangeMatch[2] ? parseInt(rangeMatch[2]) : totalSize - 1;
    end = Math.min(end, totalSize - 1);
    start = Math.max(0, start);

    if (start > end || start >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).json({ error: 'Range not satisfiable' });
    }

    const MAX_CHUNK = 2 * 1024 * 1024;
    if (end - start + 1 > MAX_CHUNK) {
      end = start + MAX_CHUNK - 1;
    }

    try {
      await streamVideo(videoData, start, end, res);
    } catch (err) {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    }
  } catch (err) {
    console.error('Stream proxy failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed: ' + err.message });
  }
});

router.post('/parse-tg-url', authenticate, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const parsed = parseTelegramUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Invalid Telegram URL format' });
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
