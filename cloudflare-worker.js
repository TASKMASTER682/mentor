// Cloudflare Worker - Telegram Video Proxy with Web Seed support
// Environment variables required:
// - BACKEND_API: Your Node.js backend URL (e.g. https://your-backend.com/api)
// - TELEGRAM_BOT_TOKEN: Telegram Bot API token (optional, for direct fetch)

const BACKEND_API = ''; // Set via CF Worker dashboard env vars

async function handleRequest(request) {
  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const msgId = url.searchParams.get('msgId');
  const backendUrl = BACKEND_API || url.searchParams.get('backend');

  if (!channel || !msgId) {
    return new Response('Missing channel or msgId query parameters', { status: 400 });
  }

  const origin = request.headers.get('Origin') || '*';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    const apiBase = backendUrl || 'https://api.telegram.org/bot' + (typeof TELEGRAM_BOT_TOKEN !== 'undefined' ? TELEGRAM_BOT_TOKEN : '');

    let telegramUrl;
    if (backendUrl) {
      // Fetch fresh download URL from backend
      const tgUrlResp = await fetch(
        `${backendUrl}/videos/get-tg-link?channel=${encodeURIComponent(channel)}&msgId=${encodeURIComponent(msgId)}`
      );
      if (!tgUrlResp.ok) {
        const errText = await tgUrlResp.text();
        return new Response(`Backend error: ${errText}`, { status: 502 });
      }
      const tgData = await tgUrlResp.json();
      telegramUrl = tgData.downloadUrl;
    } else {
      return new Response('No backend URL configured', { status: 500 });
    }

    const rangeHeader = request.headers.get('Range');

    const upstreamReq = new Request(telegramUrl, {
      method: request.method,
      headers: rangeHeader ? { 'Range': rangeHeader } : {},
    });

    const upstreamResp = await fetch(upstreamReq);

    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.set('Access-Control-Allow-Origin', origin);
    respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    respHeaders.set('Accept-Ranges', 'bytes');
    respHeaders.set('Cache-Control', 'public, max-age=3600');

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 500 });
  }
}

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};
