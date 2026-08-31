import { google } from 'googleapis';

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

async function verifyYouTube() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  const smokeTestVideoId = process.env.YT_SMOKE_TEST_VIDEO_ID;
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

    if (smokeTestVideoId) {
      const videoResponse = await youtube.videos.list({ part: ['snippet'], id: [smokeTestVideoId] });
      const video = videoResponse.data.items?.[0];
      if (!video) {
        console.error(`YouTube analytics smoke test failed: video ${smokeTestVideoId} was not found.`);
        return;
      }

      const analytics = google.youtubeAnalytics({ version: 'v2', auth });
      const startDate = isoDate(video.snippet?.publishedAt);
      const endDate = isoDate(new Date());
      const report = await analytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        filters: `video==${smokeTestVideoId}`,
        metrics: 'engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments'
      });

      const headers = report.data.columnHeaders || [];
      const row = report.data.rows?.[0] || [];
      const metrics = {};
      headers.forEach((header, index) => {
        metrics[header.name] = row[index] ?? null;
      });
      if (metrics.estimatedMinutesWatched != null) {
        metrics.watchHours = Math.round((Number(metrics.estimatedMinutesWatched) / 60) * 100) / 100;
      }
      console.log(`YouTube analytics smoke test verified. Video: ${video.snippet?.title || smokeTestVideoId}`);
      console.log(`YouTube analytics smoke metrics: ${JSON.stringify(metrics)}`);
    }
  } catch (error) {
    const detail = error?.response?.data?.error?.message || error?.message || String(error);
    console.error(`YouTube startup probe failed: ${detail}`);
  }
}

await verifyYouTube();
await import('./server.js');
