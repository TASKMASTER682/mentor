import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');

import TelegramVideo from '../models/TelegramVideo.js';

let client = null;
let isConnecting = false;
const clientQueue = [];
const metadataCache = new Map();

async function getClient() {
  const API_ID = parseInt(process.env.TELEGRAM_API_ID);
  const API_HASH = process.env.TELEGRAM_API_HASH;
  const SESSION_STRING = process.env.TELEGRAM_SESSION;
  if (client && client.connected) return client;
  if (isConnecting) {
    return new Promise((resolve, reject) => { clientQueue.push({ resolve, reject }); });
  }
  isConnecting = true;
  try {
    const session = new StringSession(SESSION_STRING);
    client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: true,
      requestTimeout: 30000,
    });
    await client.connect();
    if (!client.connected) throw new Error('Failed to connect to Telegram');
    console.log('Telegram MTProto client connected');
    isConnecting = false;
    while (clientQueue.length > 0) clientQueue.shift().resolve(client);
    return client;
  } catch (err) {
    isConnecting = false;
    while (clientQueue.length > 0) clientQueue.shift().reject(err);
    throw err;
  }
}

function resolveChatId(channel) {
  if (/^-?\d+$/.test(channel)) {
    if (!channel.startsWith('-100') && !channel.startsWith('-')) return `-100${channel}`;
    return channel;
  }
  return channel.startsWith('@') ? channel : `@${channel}`;
}

export function parseTelegramUrl(url) {
  const privateMatch = url.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (privateMatch) return { channel: privateMatch[1], msgId: privateMatch[2], isPrivate: true };
  const publicMatch = url.match(/t\.me\/([^/]+)\/(\d+)/);
  if (publicMatch) return { channel: publicMatch[1], msgId: publicMatch[2], isPrivate: false };
  return null;
}

export async function resolveVideo(channel, msgId) {
  const cacheKey = `${channel}:${msgId}`;
  const cached = metadataCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300000) return cached.data;

  const existing = await TelegramVideo.findOne({ channel, msgId }).lean();
  if (existing) {
    metadataCache.set(cacheKey, { data: existing, ts: Date.now() });
    return existing;
  }

  const tgClient = await getClient();
  const entity = await tgClient.getEntity(resolveChatId(channel));
  const messages = await tgClient.getMessages(entity, { ids: [parseInt(msgId)] });

  if (!messages || messages.length === 0 || !messages[0]) {
    throw new Error(`Message ${msgId} not found in channel`);
  }

  const message = messages[0];
  if (!message.media || !message.media.document) {
    throw new Error(`Message ${msgId} has no video document`);
  }

  const doc = message.media.document;
  let duration = 0, width = 0, height = 0;
  if (doc.attributes) {
    for (const attr of doc.attributes) {
      if (attr.className === 'DocumentAttributeVideo') {
        duration = attr.duration || 0;
        width = attr.w || 0;
        height = attr.h || 0;
      }
    }
  }

  const videoData = {
    channel,
    msgId,
    fileId: doc.id.toString(),
    accessHash: doc.accessHash.toString(),
    fileReference: Buffer.from(doc.fileReference),
    size: parseInt(doc.size?.toString() || '0'),
    mimeType: doc.mimeType || 'video/mp4',
    duration,
    width,
    height,
    dcId: doc.dcId || null,
  };

  try {
    await TelegramVideo.findOneAndUpdate(
      { channel, msgId },
      { $set: videoData },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (dbErr) {
    console.warn('Failed to cache video metadata in DB:', dbErr.message);
  }

  metadataCache.set(cacheKey, { data: videoData, ts: Date.now() });
  return videoData;
}

export async function streamVideo(videoData, start, end, res) {
  const tgClient = await getClient();

  const fileRef = videoData.fileReference instanceof Buffer
    ? videoData.fileReference
    : Buffer.from(videoData.fileReference.buffer || videoData.fileReference);

  const inputLocation = new Api.InputDocumentFileLocation({
    id: typeof videoData.fileId === 'bigint' ? videoData.fileId : BigInt(videoData.fileId),
    accessHash: typeof videoData.accessHash === 'bigint' ? videoData.accessHash : BigInt(videoData.accessHash),
    fileReference: fileRef,
    thumbSize: '',
  });

  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Type': videoData.mimeType || 'video/mp4',
    'Content-Length': chunkSize,
    'Content-Range': `bytes ${start}-${end}/${videoData.size}`,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
  });

  console.log('Stream debug: dcId=%s, start=%s, end=%s, total=%s', videoData.dcId, start, end, videoData.size);

  const CHUNK = 64 * 1024;
  let offset = start;

  while (offset <= end && !res.destroyed) {
    const requestEnd = Math.min(offset + CHUNK - 1, end);
    const requestSize = requestEnd - offset + 1;

    try {
      const result = await tgClient.invoke(
        new Api.upload.GetFile({
          location: inputLocation,
          offset: offset,
          limit: requestSize,
        })
      );

      if (!result || !result.bytes || result.bytes.length === 0) break;

      if (!res.destroyed) {
        const canWrite = res.write(result.bytes);
        offset += result.bytes.length;
        if (!canWrite) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      console.log('Stream chunk error:', err.message);
      if (!res.headersSent) throw err;
      break;
    }
  }

  if (!res.destroyed) res.end();
}
