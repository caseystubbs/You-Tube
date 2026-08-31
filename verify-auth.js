import { google } from 'googleapis';

async function verifyYouTube() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  const baseUrl = process.env.APP_BASE_URL || 'https://youtube-analytics-mcp-production-d8e7.up.railway.app';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${baseUrl}/oauth2callback`;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log('YouTube startup probe skipped: OAuth variables are incomplete.');
    return;
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    auth.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: 'v3', auth });
    const response = await youtube.channels.list({ part: ['snippet'], mine: true });
    const channel = response.data.items?.[0];
    if (!channel) {
      console.error('YouTube startup probe failed: authorization worked but no channel was returned for this Google account.');
      return;
    }
    console.log(`YouTube authorization verified. Channel: ${channel.snippet?.title || channel.id}`);
  } catch (error) {
    const detail = error?.response?.data?.error?.message || error?.message || String(error);
    console.error(`YouTube startup probe failed: ${detail}`);
  }
}

await verifyYouTube();
await import('./server.js');
