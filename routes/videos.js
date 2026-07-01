import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getFileDownloadUrl, parseTelegramUrl } from '../services/telegramService.js';
import https from 'https';
import http from 'http';

const router = express.Router();

router.get('/get-tg-link', async (req, res) => {
  try {
    const { channel, msgId } = req.query;
    if (!channel || !msgId) {
      return res.status(400).json({ error: 'channel and msgId are required' });
    }
    const downloadUrl = await getFileDownloadUrl(channel, msgId);
    res.json({ downloadUrl, channel, msgId });
  } catch (err) {
    console.error('Telegram link fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch Telegram video link' });
  }
});

router.get('/stream', async (req, res) => {
  try {
    const { channel, msgId } = req.query;
    if (!channel || !msgId) {
      return res.status(400).json({ error: 'channel and msgId are required' });
    }

    const downloadUrl = await getFileDownloadUrl(channel, msgId);
    const rangeHeader = req.headers.range;
    const urlObj = new URL(downloadUrl);
    const mod = urlObj.protocol === 'https:' ? https : http;

    const upstreamOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {},
    };

    if (rangeHeader) {
      upstreamOpts.headers['Range'] = rangeHeader;
    }

    const upstreamReq = mod.request(upstreamOpts, (upstreamRes) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      if (upstreamRes.headers['content-range']) {
        res.setHeader('Content-Range', upstreamRes.headers['content-range']);
      }
      if (upstreamRes.headers['content-length']) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      if (upstreamRes.headers['content-type']) {
        res.setHeader('Content-Type', upstreamRes.headers['content-type']);
      }

      res.statusCode = upstreamRes.statusCode || 200;
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error('Upstream request failed:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream fetch failed' });
      }
    });

    upstreamReq.end();
  } catch (err) {
    console.error('Stream proxy failed:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
    }
  }
});

router.post('/parse-tg-url', authenticate, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    const parsed = parseTelegramUrl(url);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid Telegram URL format' });
    }
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
