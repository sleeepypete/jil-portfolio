const { randomUUID } = require('crypto');

const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 1200;
const MAX_MESSAGES_PER_THREAD = 120;
const MAX_THREADS = 60;
const THREAD_LIST_KEY = 'jil-portfolio-chat:threads';
const THREAD_KEY_PREFIX = 'jil-portfolio-chat:thread:';

// Rate limiting for visitor writes: max 5 messages per IP per 60 seconds
const WRITE_RATE_LIMIT_MAX = 5;
// Rate limiting for reads: max 20 loads per IP per 60 seconds
const READ_RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_WRITE_PREFIX = 'jil-portfolio-chat:ratelimit:write:';
const RATE_LIMIT_READ_PREFIX = 'jil-portfolio-chat:ratelimit:read:';

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

function readQuery(req) {
  const baseUrl = `https://${req.headers.host || 'localhost'}`;
  return new URL(req.url || '/', baseUrl).searchParams;
}

function cleanString(value) {
  return String(value || '').trim();
}

function validateText(text, label, maxLength) {
  const cleaned = cleanString(text);
  if (!cleaned) {
    return { error: `${label} is required` };
  }
  if (cleaned.length > maxLength) {
    return { error: `${label} is too long` };
  }
  return { value: cleaned };
}

function publicThread(thread) {
  return {
    id: thread.id,
    name: thread.name,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages || []
  };
}

function publicThreadSummary(summary) {
  const { email, ...publicSummary } = summary;
  return publicSummary;
}

// Rejects requests from origins that don't match the host.
// Protects against other websites calling your API from their frontend.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin requests don't send an Origin header
  const host = req.headers.host;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

function storageConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('Chat storage is not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel.');
  }

  return { url, token };
}

async function kvCommand(command, ...args) {
  const { url, token } = storageConfig();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command, ...args])
  });

  if (!response.ok) {
    throw new Error(`Storage request failed with status ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data.result;
}

async function kvGetJson(key, fallbackValue) {
  const raw = await kvCommand('GET', key);
  if (!raw) return fallbackValue;
  return JSON.parse(raw);
}

async function kvSetJson(key, value) {
  await kvCommand('SET', key, JSON.stringify(value));
}

// Extracts the real client IP from Vercel's request headers.
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

// Rate limiting using KV INCR + EXPIRE.
// keyPrefix distinguishes read vs write counters per IP.
async function checkRateLimit(ip, keyPrefix, max) {
  if (!ip) return { limited: false };

  const key = `${keyPrefix}${ip}`;
  const count = await kvCommand('INCR', key);

  if (count === 1) {
    await kvCommand('EXPIRE', key, RATE_LIMIT_WINDOW_SECONDS);
  }

  return { limited: count > max };
}

async function getThread(threadId) {
  if (!threadId) return null;
  return kvGetJson(`${THREAD_KEY_PREFIX}${threadId}`, null);
}

async function saveThread(thread) {
  await kvSetJson(`${THREAD_KEY_PREFIX}${thread.id}`, thread);
}

async function getThreadList() {
  return kvGetJson(THREAD_LIST_KEY, []);
}

async function saveThreadSummary(thread) {
  const list = await getThreadList();
  const lastMessage = thread.messages[thread.messages.length - 1];
  const summary = {
    id: thread.id,
    name: thread.name,
    updatedAt: thread.updatedAt,
    preview: lastMessage ? lastMessage.text.slice(0, 120) : ''
  };
  const nextList = [summary, ...list.filter((item) => item.id !== thread.id)]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_THREADS);

  await kvSetJson(THREAD_LIST_KEY, nextList);
}

function createMessage(author, name, text) {
  return {
    id: randomUUID(),
    author,
    name,
    text,
    createdAt: new Date().toISOString()
  };
}

function addMessage(thread, message) {
  const now = new Date().toISOString();
  const messages = [...(thread.messages || []), message].slice(-MAX_MESSAGES_PER_THREAD);
  return { ...thread, messages, updatedAt: now };
}

function visitorTokenMatches(thread, providedToken) {
  if (!thread.visitorToken) return true;
  return cleanString(providedToken) === thread.visitorToken;
}

function verifyOwner(body, req) {
  const configuredKey = process.env.CHAT_OWNER_KEY;
  if (!configuredKey) {
    return { error: 'Owner access is not configured. Add CHAT_OWNER_KEY in Vercel.' };
  }

  const providedKey = cleanString(body.ownerKey || req.headers['x-chat-owner-key']);
  if (providedKey !== configuredKey) {
    return { error: 'Invalid owner access code', statusCode: 401 };
  }

  return { ok: true };
}

async function handleVisitorMessage(body, req, res) {
  const ip = getClientIp(req);
  const rateLimit = await checkRateLimit(ip, RATE_LIMIT_WRITE_PREFIX, WRITE_RATE_LIMIT_MAX);
  if (rateLimit.limited) {
    return sendJson(res, 429, { error: 'Too many messages. Please wait a moment before sending again.' });
  }

  const textResult = validateText(body.text, 'Message', MAX_TEXT_LENGTH);
  if (textResult.error) return sendJson(res, 400, { error: textResult.error });

  let thread = await getThread(cleanString(body.threadId));
  if (!thread) {
    const nameResult = validateText(body.name, 'Name', MAX_NAME_LENGTH);
    if (nameResult.error) return sendJson(res, 400, { error: nameResult.error });

    const now = new Date().toISOString();
    thread = {
      id: randomUUID(),
      visitorToken: randomUUID(),
      name: nameResult.value,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  } else {
    if (!visitorTokenMatches(thread, body.visitorToken)) {
      return sendJson(res, 403, { error: 'Conversation access expired. Start a new chat from this browser.' });
    }
    if (!thread.visitorToken) thread = { ...thread, visitorToken: randomUUID() };
  }

  thread = addMessage(thread, createMessage('visitor', thread.name, textResult.value));
  await saveThread(thread);
  await saveThreadSummary(thread);

  return sendJson(res, 200, { threadId: thread.id, visitorToken: thread.visitorToken, thread: publicThread(thread) });
}

async function handleOwnerList(body, req, res) {
  const owner = verifyOwner(body, req);
  if (owner.error) return sendJson(res, owner.statusCode || 500, { error: owner.error });

  const threads = (await getThreadList()).map(publicThreadSummary);
  return sendJson(res, 200, { threads });
}

async function handleOwnerThread(body, req, res) {
  const owner = verifyOwner(body, req);
  if (owner.error) return sendJson(res, owner.statusCode || 500, { error: owner.error });

  const thread = await getThread(cleanString(body.threadId));
  if (!thread) return sendJson(res, 404, { error: 'Conversation not found' });

  return sendJson(res, 200, { thread: publicThread(thread) });
}

async function handleOwnerReply(body, req, res) {
  const owner = verifyOwner(body, req);
  if (owner.error) return sendJson(res, owner.statusCode || 500, { error: owner.error });

  const textResult = validateText(body.text, 'Reply', MAX_TEXT_LENGTH);
  if (textResult.error) return sendJson(res, 400, { error: textResult.error });

  let thread = await getThread(cleanString(body.threadId));
  if (!thread) return sendJson(res, 404, { error: 'Conversation not found' });

  thread = addMessage(thread, createMessage('owner', 'Jil', textResult.value));
  await saveThread(thread);
  await saveThreadSummary(thread);

  return sendJson(res, 200, { thread: publicThread(thread) });
}

module.exports = async function handler(req, res) {
  try {
    // Block requests from foreign origins (e.g. other sites calling your API)
    if (!checkOrigin(req)) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    if (req.method === 'GET') {
      const ip = getClientIp(req);
      const rateLimit = await checkRateLimit(ip, RATE_LIMIT_READ_PREFIX, READ_RATE_LIMIT_MAX);
      if (rateLimit.limited) {
        return sendJson(res, 429, { error: 'Too many requests. Please slow down.' });
      }

      const query = readQuery(req);
      const threadId = query.get('threadId');
      const thread = await getThread(cleanString(threadId));
      if (!thread) return sendJson(res, 404, { error: 'Conversation not found' });
      if (!visitorTokenMatches(thread, query.get('visitorToken'))) {
        return sendJson(res, 403, { error: 'Conversation access expired. Start a new chat from this browser.' });
      }
      return sendJson(res, 200, { thread: publicThread(thread), visitorToken: thread.visitorToken || '' });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const body = getBody(req);
    const action = cleanString(body.action || 'visitor-message');

    if (action === 'visitor-message') return handleVisitorMessage(body, req, res);
    if (action === 'owner-login') {
      const owner = verifyOwner(body, req);
      return sendJson(res, owner.error ? owner.statusCode || 500 : 200, owner.error ? { error: owner.error } : { ok: true });
    }
    if (action === 'owner-list') return handleOwnerList(body, req, res);
    if (action === 'owner-thread') return handleOwnerThread(body, req, res);
    if (action === 'owner-reply') return handleOwnerReply(body, req, res);

    return sendJson(res, 400, { error: 'Unknown chat action' });
  } catch (error) {
    console.error('Chat API error:', error);
    return sendJson(res, 500, { error: 'Chat is unavailable' });
  }
};