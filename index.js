import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  }),
);
app.use(express.json({ limit: '10mb' }));

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'loveapp';
const port = Number(process.env.PORT || '5000');
const apiKey = (process.env.SYNC_API_KEY || '').trim();

if (!mongoUri) {
  logger.error('MONGODB_URI is required');
  process.exit(1);
}

const client = new MongoClient(mongoUri, {
  maxPoolSize: 30,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 15000,
});

let db;
let spacesCollection;
let logsCollection;
let mediaCollection;
let accountsCollection;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use((req, res, next) => {
  if (!apiKey) return next();
  const provided = (req.header('x-api-key') || '').trim();
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
});

const CALENDAR_TEMPLATES = [
  { id: 'date-night-weekly', title: 'Date Night', description: 'Dedicated time together', recurrence: 'yearly', category: 'anniversary' },
  { id: 'monthly-checkin', title: 'Monthly Check-In', description: 'Relationship reflection and planning', recurrence: 'none', category: 'other' },
  { id: 'birthday-partner', title: 'Partner Birthday', description: 'Celebrate with love', recurrence: 'yearly', category: 'birthday' },
  { id: 'anniversary-main', title: 'Anniversary', description: 'Our relationship anniversary', recurrence: 'yearly', category: 'anniversary' },
];

function stableKey(parts) {
  return parts.map((v) => `${v ?? ''}`.trim().toLowerCase()).join('|');
}

function mergeMessages(existing = [], incoming = []) {
  const byKey = new Map();
  for (const msg of [...existing, ...incoming]) {
    const key = stableKey([
      msg.userId,
      msg.timestamp,
      msg.type,
      msg.content,
      msg.attachmentPath,
      msg.replyToId,
    ]);
    if (!byKey.has(key)) byKey.set(key, msg);
  }
  return Array.from(byKey.values()).sort((a, b) => b.timestamp - a.timestamp);
}

function mergeEvents(existing = [], incoming = []) {
  const byKey = new Map();
  for (const event of [...existing, ...incoming]) {
    const key = stableKey([event.title, event.date_time, event.category]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, event);
      continue;
    }
    const prevUpdated = prev.updatedAt || prev.date_time || 0;
    const nextUpdated = event.updatedAt || event.date_time || 0;
    byKey.set(key, nextUpdated >= prevUpdated ? event : prev);
  }
  return Array.from(byKey.values()).sort((a, b) => a.date_time - b.date_time);
}

function mergeTasks(existing = [], incoming = []) {
  const byKey = new Map();
  for (const task of [...existing, ...incoming]) {
    const key = stableKey([task.title, task.owner_id, task.responsible_id]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, task);
      continue;
    }
    const prevUpdated = prev.updatedAt || 0;
    const nextUpdated = task.updatedAt || 0;
    if ((task.is_completed ? 1 : 0) > (prev.is_completed ? 1 : 0)) {
      byKey.set(key, task);
    } else {
      byKey.set(key, nextUpdated >= prevUpdated ? task : prev);
    }
  }
  return Array.from(byKey.values());
}

function mergeMood(existing = [], incoming = []) {
  const byKey = new Map();
  for (const entry of [...existing, ...incoming]) {
    const key = stableKey([entry.userId, entry.timestamp, entry.mood]);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return Array.from(byKey.values()).sort((a, b) => b.timestamp - a.timestamp);
}

function mergeMessageReactions(existing = [], incoming = []) {
  const byKey = new Map();
  for (const reaction of [...existing, ...incoming]) {
    const key = stableKey([reaction.message_id, reaction.user_id]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, reaction);
      continue;
    }
    const prevTs = Number(prev.created_at || 0);
    const nextTs = Number(reaction.created_at || 0);
    byKey.set(key, nextTs >= prevTs ? reaction : prev);
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

function mergeHabits(existing = [], incoming = []) {
  const byKey = new Map();
  for (const habit of [...existing, ...incoming]) {
    const key = stableKey([habit.title, habit.owner_id]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, habit);
      continue;
    }
    const prevTs = Number(prev.created_at || 0);
    const nextTs = Number(habit.created_at || 0);
    byKey.set(key, nextTs >= prevTs ? habit : prev);
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

function mergeHabitLogs(existing = [], incoming = []) {
  const byKey = new Map();
  for (const log of [...existing, ...incoming]) {
    const key = stableKey([log.habit_id, log.user_id, log.date_key]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, log);
      continue;
    }
    if ((log.completed ? 1 : 0) > (prev.completed ? 1 : 0)) {
      byKey.set(key, log);
      continue;
    }
    const prevTs = Number(prev.created_at || 0);
    const nextTs = Number(log.created_at || 0);
    byKey.set(key, nextTs >= prevTs ? log : prev);
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

function mergeMedia(existing = [], incoming = []) {
  const byKey = new Map();
  for (const media of [...existing, ...incoming]) {
    const key = stableKey([media.file_path, media.type, media.added_on]);
    if (!byKey.has(key)) byKey.set(key, media);
  }
  return Array.from(byKey.values()).sort((a, b) => b.added_on - a.added_on);
}

function mergeSettings(existing = [], incoming = []) {
  const map = new Map();
  for (const item of existing) map.set(item.key, item.value);
  for (const item of incoming) map.set(item.key, item.value);
  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

function normalizeAccountName(value) {
  return String(value || '').trim().toLowerCase();
}

function createSpaceIdForAccounts(a, b) {
  const sorted = [a, b].sort();
  return `couple_${sorted[0]}_${sorted[1]}`;
}

function mergeSnapshots(currentSnapshot = {}, incomingSnapshot = {}) {
  const merged = {
    messages: mergeMessages(currentSnapshot.messages, incomingSnapshot.messages),
    message_reactions: mergeMessageReactions(currentSnapshot.message_reactions, incomingSnapshot.message_reactions),
    events: mergeEvents(currentSnapshot.events, incomingSnapshot.events),
    tasks: mergeTasks(currentSnapshot.tasks, incomingSnapshot.tasks),
    habits: mergeHabits(currentSnapshot.habits, incomingSnapshot.habits),
    habit_logs: mergeHabitLogs(currentSnapshot.habit_logs, incomingSnapshot.habit_logs),
    mood_entries: mergeMood(currentSnapshot.mood_entries, incomingSnapshot.mood_entries),
    gallery_media: mergeMedia(currentSnapshot.gallery_media, incomingSnapshot.gallery_media),
    settings: mergeSettings(currentSnapshot.settings, incomingSnapshot.settings),
  };

  return {
    snapshot: merged,
    stats: {
      messages: merged.messages.length,
      reactions: merged.message_reactions.length,
      events: merged.events.length,
      tasks: merged.tasks.length,
      habits: merged.habits.length,
      habitLogs: merged.habit_logs.length,
      moods: merged.mood_entries.length,
      media: merged.gallery_media.length,
      settings: merged.settings.length,
    },
  };
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, db: dbName });
});

app.get('/readyz', async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    return res.status(200).json({ ok: true, ready: true });
  } catch (error) {
    logger.error({ err: error }, 'readiness check failed');
    return res.status(503).json({ ok: false, ready: false });
  }
});

app.get('/calendar/templates', (_req, res) => {
  res.json({ templates: CALENDAR_TEMPLATES });
});

app.post('/accounts/register', async (req, res) => {
  try {
    const accountNameRaw = req.body?.accountName;
    const accountName = normalizeAccountName(accountNameRaw);
    if (!accountName) {
      return res.status(400).json({ error: 'accountName is required' });
    }

    const existing = await accountsCollection.findOne({ accountName });
    if (existing) {
      return res.status(409).json({ error: 'account name already exists' });
    }

    const now = Date.now();
    const accountId = `acct_${now}_${Math.floor(Math.random() * 999999)}`;
    const spaceId = `solo_${accountId}`;

    await accountsCollection.insertOne({
      accountId,
      accountName,
      spaceId,
      linkedAccountId: null,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(201).json({
      ok: true,
      accountId,
      accountName,
      spaceId,
      linkedAccountName: null,
    });
  } catch (error) {
    logger.error({ err: error }, 'account register failed');
    return res.status(500).json({ error: 'account register failed' });
  }
});

app.post('/accounts/login', async (req, res) => {
  try {
    const accountNameRaw = req.body?.accountName;
    const accountName = normalizeAccountName(accountNameRaw);
    if (!accountName) {
      return res.status(400).json({ error: 'accountName is required' });
    }

    const account = await accountsCollection.findOne({ accountName });
    if (!account) {
      return res.status(404).json({ error: 'account not found' });
    }

    let linkedAccountName = null;
    if (account.linkedAccountId) {
      const linked = await accountsCollection.findOne({
        accountId: account.linkedAccountId,
      });
      linkedAccountName = linked?.accountName || null;
    }

    return res.json({
      ok: true,
      accountId: account.accountId,
      accountName: account.accountName,
      spaceId: account.spaceId,
      linkedAccountName,
    });
  } catch (error) {
    logger.error({ err: error }, 'account login failed');
    return res.status(500).json({ error: 'account login failed' });
  }
});

app.post('/accounts/link', async (req, res) => {
  try {
    const accountName = normalizeAccountName(req.body?.accountName);
    const partnerAccountName = normalizeAccountName(req.body?.partnerAccountName);
    if (!accountName || !partnerAccountName) {
      return res
        .status(400)
        .json({ error: 'accountName and partnerAccountName are required' });
    }
    if (accountName === partnerAccountName) {
      return res.status(400).json({ error: 'cannot link account to itself' });
    }

    const me = await accountsCollection.findOne({ accountName });
    const partner = await accountsCollection.findOne({ accountName: partnerAccountName });
    if (!me || !partner) {
      return res.status(404).json({ error: 'one or both accounts not found' });
    }

    if (me.linkedAccountId && me.linkedAccountId !== partner.accountId) {
      return res.status(409).json({ error: 'account already linked to another partner' });
    }
    if (partner.linkedAccountId && partner.linkedAccountId !== me.accountId) {
      return res.status(409).json({ error: 'partner account already linked to another partner' });
    }

    const sharedSpaceId =
      me.linkedAccountId === partner.accountId && me.spaceId === partner.spaceId
        ? me.spaceId
        : createSpaceIdForAccounts(me.accountId, partner.accountId);

    const now = Date.now();
    await accountsCollection.updateOne(
      { accountId: me.accountId },
      {
        $set: {
          linkedAccountId: partner.accountId,
          spaceId: sharedSpaceId,
          updatedAt: now,
        },
      },
    );
    await accountsCollection.updateOne(
      { accountId: partner.accountId },
      {
        $set: {
          linkedAccountId: me.accountId,
          spaceId: sharedSpaceId,
          updatedAt: now,
        },
      },
    );

    return res.json({
      ok: true,
      spaceId: sharedSpaceId,
      accountName: me.accountName,
      partnerAccountName: partner.accountName,
    });
  } catch (error) {
    logger.error({ err: error }, 'account link failed');
    return res.status(500).json({ error: 'account link failed' });
  }
});

app.post('/logs', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.spaceId) {
      return res.status(400).json({ error: 'spaceId is required' });
    }

    await logsCollection.insertOne({
      spaceId: payload.spaceId,
      level: payload.level || 'info',
      message: payload.message || '',
      context: payload.context || {},
      appVersion: payload.appVersion || null,
      platform: payload.platform || null,
      createdAt: Date.now(),
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'failed to ingest log');
    return res.status(500).json({ error: 'failed to ingest log' });
  }
});

app.post('/media/register', async (req, res) => {
  try {
    const { spaceId, fileName, contentType, bytes, checksum, remoteUrl } = req.body || {};
    if (!spaceId || !fileName) {
      return res.status(400).json({ error: 'spaceId and fileName are required' });
    }
    await mediaCollection.insertOne({
      spaceId,
      fileName,
      contentType: contentType || 'application/octet-stream',
      bytes: Number(bytes || 0),
      checksum: checksum || null,
      remoteUrl: remoteUrl || null,
      createdAt: Date.now(),
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'failed to register media');
    return res.status(500).json({ error: 'failed to register media' });
  }
});

app.post('/sync/push', async (req, res) => {
  try {
    const { spaceId, deviceId, snapshot, syncAt } = req.body || {};
    if (!spaceId || !snapshot) {
      return res.status(400).json({ error: 'spaceId and snapshot are required' });
    }

    const now = Date.now();
    const current = await spacesCollection.findOne({ spaceId });
    const currentSnapshot = current?.snapshot || {};

    const { snapshot: mergedSnapshot, stats } = mergeSnapshots(currentSnapshot, snapshot);

    await spacesCollection.updateOne(
      { spaceId },
      {
        $set: {
          snapshot: mergedSnapshot,
          stats,
          updatedAt: now,
          lastSyncAt: syncAt || now,
          lastDeviceId: deviceId || null,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    return res.status(200).json({
      ok: true,
      syncAt: now,
      stats,
      rules: {
        messages: 'dedupe-by-content+timestamp',
        events: 'last-write-wins',
        tasks: 'complete-wins-then-last-write-wins',
        messageReactions: 'one-reaction-per-user-per-message-last-write-wins',
        habits: 'last-write-wins-by-title-owner',
        habitLogs: 'completion-wins-then-last-write-wins',
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'sync push failed');
    return res.status(500).json({ error: 'sync push failed' });
  }
});

app.get('/sync/pull', async (req, res) => {
  try {
    const spaceId = req.query.spaceId;
    if (!spaceId) {
      return res.status(400).json({ error: 'spaceId is required' });
    }

    const current = await spacesCollection.findOne({ spaceId });
    if (!current) {
      return res.json({ ok: true, syncAt: Date.now(), snapshot: {}, stats: {} });
    }

    return res.json({
      ok: true,
      syncAt: current.updatedAt || Date.now(),
      snapshot: current.snapshot || {},
      stats: current.stats || {},
      deviceId: current.lastDeviceId || null,
    });
  } catch (error) {
    logger.error({ err: error }, 'sync pull failed');
    return res.status(500).json({ error: 'sync pull failed' });
  }
});

app.get('/dashboard/:spaceId', async (req, res) => {
  try {
    const { spaceId } = req.params;
    const current = await spacesCollection.findOne({ spaceId });

    const snapshot = current?.snapshot || {};
    const stats = current?.stats || {
      messages: 0,
      reactions: 0,
      events: 0,
      tasks: 0,
      habits: 0,
      habitLogs: 0,
      moods: 0,
      media: 0,
      settings: 0,
    };

    const completedTasks = (snapshot.tasks || []).filter((t) => t.is_completed === 1 || t.is_completed === true).length;
    const completedHabitDays = (snapshot.habit_logs || []).filter((h) => h.completed === 1 || h.completed === true).length;

    res.json({
      ok: true,
      spaceId,
      stats,
      completedTasks,
      completedHabitDays,
      completionRate: stats.tasks ? Number((completedTasks / stats.tasks).toFixed(2)) : 0,
      updatedAt: current?.updatedAt || null,
      recommendations: [
        'Sync at least once daily',
        'Keep media files under 20MB for faster upload',
        'Use recurring templates for anniversaries and birthdays',
        'Track daily habits to maintain relationship routines',
      ],
    });
  } catch (error) {
    logger.error({ err: error }, 'dashboard failed');
    return res.status(500).json({ error: 'dashboard failed' });
  }
});

app.get('/insights/mood/:spaceId', async (req, res) => {
  try {
    const { spaceId } = req.params;
    const days = Number(req.query.days || 7);
    const current = await spacesCollection.findOne({ spaceId });

    const now = Date.now();
    const windowStart = now - days * 24 * 60 * 60 * 1000;
    const entries = (current?.snapshot?.mood_entries || []).filter((m) => Number(m.timestamp || 0) >= windowStart);

    const avgMood = entries.length
      ? Number((entries.reduce((acc, m) => acc + Number(m.mood || 0), 0) / entries.length).toFixed(2))
      : 0;

    const trend = entries.length >= 2
      ? Number(entries[0].mood || 0) - Number(entries[entries.length - 1].mood || 0)
      : 0;

    return res.json({
      ok: true,
      days,
      entries: entries.length,
      averageMood: avgMood,
      trend,
      summary:
        avgMood >= 4
          ? 'Strong emotional week overall.'
          : avgMood >= 3
          ? 'Balanced week with room for intentional connection.'
          : 'Lower mood signals this week, consider a recovery check-in.',
    });
  } catch (error) {
    logger.error({ err: error }, 'mood insights failed');
    return res.status(500).json({ error: 'mood insights failed' });
  }
});

async function start() {
  await client.connect();
  db = client.db(dbName);
  spacesCollection = db.collection('sync_spaces');
  logsCollection = db.collection('client_logs');
  mediaCollection = db.collection('media_assets');
  accountsCollection = db.collection('accounts');

  await spacesCollection.createIndex({ spaceId: 1 }, { unique: true });
  await logsCollection.createIndex({ spaceId: 1, createdAt: -1 });
  await mediaCollection.createIndex({ spaceId: 1, createdAt: -1 });
  await accountsCollection.createIndex({ accountName: 1 }, { unique: true });
  await accountsCollection.createIndex({ accountId: 1 }, { unique: true });

  app.listen(port, () => {
    logger.info(`Sync server running on ${port}`);
  });
}

start().catch((error) => {
  logger.error({ err: error }, 'failed to start sync server');
  process.exit(1);
});
