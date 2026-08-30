import { google } from 'googleapis';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET || 'dev-only-change-me';
const MCP_PATH = `/mcp/${MCP_PATH_SECRET}`;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_BASE_URL}/oauth2callback`;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

let runtimeRefreshToken = null;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
];

function createGoogleOAuthClient({ requireRefreshToken = true } = {}) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, GOOGLE_REDIRECT_URI);
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || runtimeRefreshToken;

  if (requireRefreshToken && !refreshToken) {
    throw new Error(`YouTube is not authorized yet. Open ${APP_BASE_URL}/auth/google and complete Google consent.`);
  }

  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  return oauth2Client;
}

function analyticsClient() {
  return google.youtubeAnalytics({ version: 'v2', auth: createGoogleOAuthClient() });
}

function youtubeClient() {
  return google.youtube({ version: 'v3', auth: createGoogleOAuthClient() });
}

function reportingClient() {
  return google.youtubereporting({ version: 'v1', auth: createGoogleOAuthClient() });
}

function isoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysInclusive(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86400000) + 1;
}

function jsonResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function rowsToObjects(response) {
  const headers = response.columnHeaders || [];
  const rows = response.rows || [];
  return rows.map((row) => {
    const out = {};
    headers.forEach((header, index) => {
      out[header.name] = cleanNumber(row[index]);
    });
    return out;
  });
}

async function getVideoMeta(videoId) {
  const yt = youtubeClient();
  const response = await yt.videos.list({
    part: ['snippet', 'contentDetails'],
    id: [videoId]
  });
  const video = response.data.items?.[0];
  if (!video) throw new Error(`Video ${videoId} was not found.`);
  return {
    videoId,
    title: video.snippet?.title || null,
    publishedAt: video.snippet?.publishedAt || null,
    duration: video.contentDetails?.duration || null
  };
}

async function queryAnalytics({ videoId, startDate, endDate, metrics, dimensions, sort }) {
  const analytics = analyticsClient();
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics,
    ...(dimensions ? { dimensions } : {}),
    ...(videoId ? { filters: `video==${videoId}` } : {}),
    ...(sort ? { sort } : {})
  });
  return response.data;
}

async function getVideoReport(videoId, startDate, endDate) {
  const meta = await getVideoMeta(videoId);
  const start = startDate || isoDate(meta.publishedAt);
  const end = endDate || isoDate(new Date());

  const data = await queryAnalytics({
    videoId,
    startDate: start,
    endDate: end,
    metrics: [
      'engagedViews',
      'estimatedMinutesWatched',
      'averageViewDuration',
      'averageViewPercentage',
      'subscribersGained',
      'subscribersLost',
      'likes',
      'comments'
    ].join(',')
  });

  const row = rowsToObjects(data)[0] || {};
  const minutes = Number(row.estimatedMinutesWatched || 0);
  return {
    ...meta,
    startDate: start,
    endDate: end,
    engagedViews: row.engagedViews ?? 0,
    watchHours: Math.round((minutes / 60) * 100) / 100,
    estimatedMinutesWatched: minutes,
    averageViewDurationSeconds: row.averageViewDuration ?? null,
    averageViewPercentage: row.averageViewPercentage ?? null,
    subscribersGained: row.subscribersGained ?? 0,
    subscribersLost: row.subscribersLost ?? 0,
    netSubscribers: Number(row.subscribersGained || 0) - Number(row.subscribersLost || 0),
    likes: row.likes ?? 0,
    comments: row.comments ?? 0,
    metricPolicy: 'Use engagedViews for historical comparisons. Public views are intentionally omitted.'
  };
}

async function getRetention(videoId, startDate, endDate) {
  const meta = await getVideoMeta(videoId);
  const start = startDate || isoDate(meta.publishedAt);
  const end = endDate || isoDate(new Date());
  const data = await queryAnalytics({
    videoId,
    startDate: start,
    endDate: end,
    metrics: 'audienceWatchRatio,relativeRetentionPerformance',
    dimensions: 'elapsedVideoTimeRatio'
  });

  return {
    ...meta,
    startDate: start,
    endDate: end,
    retention: rowsToObjects(data)
  };
}

async function getTrafficSources(videoId, startDate, endDate) {
  const meta = await getVideoMeta(videoId);
  const start = startDate || isoDate(meta.publishedAt);
  const end = endDate || isoDate(new Date());
  const data = await queryAnalytics({
    videoId,
    startDate: start,
    endDate: end,
    metrics: 'engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
    dimensions: 'insightTrafficSourceType',
    sort: '-engagedViews'
  });

  return {
    ...meta,
    startDate: start,
    endDate: end,
    trafficSources: rowsToObjects(data).map((row) => ({
      ...row,
      watchHours: row.estimatedMinutesWatched == null
        ? null
        : Math.round((Number(row.estimatedMinutesWatched) / 60) * 100) / 100
    }))
  };
}

async function getLatestVideos(limit = 10) {
  const yt = youtubeClient();
  const channel = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('Could not find the uploads playlist for the authorized channel.');

  const playlist = await yt.playlistItems.list({
    part: ['snippet', 'contentDetails'],
    playlistId: uploads,
    maxResults: Math.min(Math.max(limit, 1), 50)
  });

  return (playlist.data.items || []).map((item) => ({
    videoId: item.contentDetails?.videoId,
    title: item.snippet?.title,
    publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt
  }));
}

async function compareVideosSameAge(videoA, videoB, requestedAgeDays) {
  const [metaA, metaB] = await Promise.all([getVideoMeta(videoA), getVideoMeta(videoB)]);
  const today = isoDate(new Date());
  const startA = isoDate(metaA.publishedAt);
  const startB = isoDate(metaB.publishedAt);
  const availableA = Math.max(1, daysInclusive(startA, today));
  const availableB = Math.max(1, daysInclusive(startB, today));
  const ageDays = requestedAgeDays || Math.min(availableA, availableB);

  if (ageDays < 1) throw new Error('ageDays must be at least 1.');
  if (ageDays > availableA || ageDays > availableB) {
    throw new Error(`Requested ${ageDays} days, but the videos only have ${availableA} and ${availableB} days available.`);
  }

  const endA = addDays(startA, ageDays - 1);
  const endB = addDays(startB, ageDays - 1);
  const [reportA, reportB] = await Promise.all([
    getVideoReport(videoA, startA, endA),
    getVideoReport(videoB, startB, endB)
  ]);

  const pct = (a, b) => {
    const base = Number(b || 0);
    if (!base) return null;
    return Math.round((((Number(a || 0) - base) / base) * 100) * 10) / 10;
  };

  return {
    comparisonGranularity: 'calendar-day age match (YouTube Analytics API does not expose an hourly dimension)',
    ageDays,
    videoA: reportA,
    videoB: reportB,
    deltaA_vs_B_percent: {
      engagedViews: pct(reportA.engagedViews, reportB.engagedViews),
      watchHours: pct(reportA.watchHours, reportB.watchHours),
      averageViewDurationSeconds: pct(reportA.averageViewDurationSeconds, reportB.averageViewDurationSeconds),
      averageViewPercentage: pct(reportA.averageViewPercentage, reportB.averageViewPercentage),
      netSubscribers: pct(reportA.netSubscribers, reportB.netSubscribers)
    }
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

async function getReachMetrics(videoId, startDate, endDate) {
  const meta = await getVideoMeta(videoId);
  const start = startDate || isoDate(meta.publishedAt);
  const end = endDate || isoDate(new Date());
  const reporting = reportingClient();

  const jobsResp = await reporting.jobs.list({ includeSystemManaged: true });
  let job = (jobsResp.data.jobs || []).find((j) => j.reportTypeId === 'channel_reach_basic_a1');

  if (!job) {
    const created = await reporting.jobs.create({
      requestBody: {
        reportTypeId: 'channel_reach_basic_a1',
        name: 'FIO YouTube Reach Metrics'
      }
    });
    job = created.data;
    return {
      ...meta,
      status: 'reach_job_created',
      jobId: job.id,
      message: 'The reach reporting job was created. YouTube bulk reports are generated daily and the first report can take up to 24 hours.'
    };
  }

  const reportsResp = await reporting.jobs.reports.list({ jobId: job.id, pageSize: 30 });
  const reports = [...(reportsResp.data.reports || [])]
    .filter((r) => r.downloadUrl)
    .sort((a, b) => new Date(a.createTime || 0) - new Date(b.createTime || 0));

  if (!reports.length) {
    return {
      ...meta,
      status: 'waiting_for_reach_report',
      jobId: job.id,
      message: 'The reach job exists, but YouTube has not generated a downloadable report yet.'
    };
  }

  const oauth = createGoogleOAuthClient();
  const rowsByKey = new Map();

  for (const report of reports) {
    const response = await oauth.request({ url: report.downloadUrl, method: 'GET' });
    for (const row of parseCsv(response.data)) {
      if (row.video_id !== videoId) continue;
      if (row.date < start || row.date > end) continue;
      rowsByKey.set(`${row.date}:${row.video_id}`, row);
    }
  }

  const rows = [...rowsByKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  let totalImpressions = 0;
  let weightedClicks = 0;

  const daily = rows.map((row) => {
    const impressions = Number(row.video_thumbnail_impressions || 0);
    const ctr = Number(row.video_thumbnail_impressions_ctr || 0);
    totalImpressions += impressions;
    weightedClicks += impressions * ctr;
    return {
      date: row.date,
      thumbnailImpressions: impressions,
      thumbnailImpressionsCtr: ctr
    };
  });

  return {
    ...meta,
    startDate: start,
    endDate: end,
    thumbnailImpressions: totalImpressions,
    thumbnailImpressionsCtr: totalImpressions ? weightedClicks / totalImpressions : null,
    daily,
    source: 'YouTube Reporting API channel_reach_basic_a1'
  };
}

function buildMcpServer() {
  const server = new McpServer({
    name: 'fio-youtube-analytics',
    version: '0.1.0'
  });

  server.registerTool(
    'youtube_connection_status',
    { description: 'Check whether the private Freedom Income Options YouTube analytics connector is configured and authorized.' },
    async () => jsonResult({
      configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      authorized: Boolean(process.env.YOUTUBE_REFRESH_TOKEN || runtimeRefreshToken),
      refreshTokenPersisted: Boolean(process.env.YOUTUBE_REFRESH_TOKEN),
      authorizeUrl: `${APP_BASE_URL}/auth/google`,
      metricPolicy: 'Use engagedViews for historical comparisons; do not compare public views across the counting-method change.'
    })
  );

  server.registerTool(
    'youtube_latest_videos',
    {
      description: 'List the most recent videos from the authorized YouTube channel.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() })
    },
    async ({ limit }) => jsonResult(await getLatestVideos(limit || 10))
  );

  server.registerTool(
    'youtube_video_report',
    {
      description: 'Get a private analytics report for one YouTube video using engaged views, watch time, AVD, average percentage viewed, subscribers, likes, and comments. Public view count is intentionally omitted.',
      inputSchema: z.object({
        videoId: z.string().min(1),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      })
    },
    async ({ videoId, startDate, endDate }) => jsonResult(await getVideoReport(videoId, startDate, endDate))
  );

  server.registerTool(
    'youtube_retention',
    {
      description: 'Get the audience retention curve for a YouTube video.',
      inputSchema: z.object({
        videoId: z.string().min(1),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      })
    },
    async ({ videoId, startDate, endDate }) => jsonResult(await getRetention(videoId, startDate, endDate))
  );

  server.registerTool(
    'youtube_traffic_sources',
    {
      description: 'Break down a video by YouTube traffic source using engaged views and watch-time metrics.',
      inputSchema: z.object({
        videoId: z.string().min(1),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      })
    },
    async ({ videoId, startDate, endDate }) => jsonResult(await getTrafficSources(videoId, startDate, endDate))
  );

  server.registerTool(
    'youtube_compare_videos_same_age',
    {
      description: 'Compare two videos at the same number of calendar days since publication using engaged views, watch time, retention averages, and subscriber conversion.',
      inputSchema: z.object({
        videoA: z.string().min(1),
        videoB: z.string().min(1),
        ageDays: z.number().int().min(1).optional()
      })
    },
    async ({ videoA, videoB, ageDays }) => jsonResult(await compareVideosSameAge(videoA, videoB, ageDays))
  );

  server.registerTool(
    'youtube_reach_metrics',
    {
      description: 'Get thumbnail impressions and thumbnail CTR from the YouTube Reporting API. On first use this may create the required daily reach reporting job.',
      inputSchema: z.object({
        videoId: z.string().min(1),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      })
    },
    async ({ videoId, startDate, endDate }) => jsonResult(await getReachMetrics(videoId, startDate, endDate))
  );

  return server;
}

const mcpHandler = createMcpHandler(() => buildMcpServer());
const nodeHandler = toNodeHandler(mcpHandler);

const appOptions = ALLOWED_HOSTS.length
  ? { host: '0.0.0.0', allowedHosts: ALLOWED_HOSTS }
  : { host: '0.0.0.0' };
const app = createMcpExpressApp(appOptions);

app.get('/', (_req, res) => {
  res.json({
    service: 'FIO YouTube Analytics MCP',
    status: 'ok',
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    authorized: Boolean(process.env.YOUTUBE_REFRESH_TOKEN || runtimeRefreshToken),
    authorizeUrl: `${APP_BASE_URL}/auth/google`
  });
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/auth/google', (_req, res) => {
  try {
    const oauth2Client = createGoogleOAuthClient({ requireRefreshToken: false });
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES
    });
    res.redirect(url);
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) throw new Error('Google did not return an authorization code.');
    const oauth2Client = createGoogleOAuthClient({ requireRefreshToken: false });
    const { tokens } = await oauth2Client.getToken(String(req.query.code));
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Retry /auth/google and make sure consent is granted with prompt=consent.');
    }
    runtimeRefreshToken = tokens.refresh_token;
    const escaped = String(tokens.refresh_token)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    res.type('html').send(`<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.5"><h1>YouTube connected</h1><p>The connector can use this authorization immediately. To keep it connected after a restart or deploy, save the following value as the Railway variable <strong>YOUTUBE_REFRESH_TOKEN</strong>.</p><pre style="white-space:pre-wrap;word-break:break-all;padding:16px;background:#f4f4f4;border-radius:8px">${escaped}</pre><p>Do not put this token in GitHub.</p></body></html>`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.all(MCP_PATH, (req, res) => void nodeHandler(req, res, req.body));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FIO YouTube Analytics MCP listening on port ${PORT}`);
  console.log(`MCP endpoint path: ${MCP_PATH}`);
});
