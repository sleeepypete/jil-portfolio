const { randomUUID } = require('crypto');

const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 1200;
const MAX_EMAIL_LENGTH = 160;
const MAX_MESSAGES_PER_THREAD = 120;
const MAX_THREADS = 60;
const THREAD_LIST_KEY = 'jil-portfolio-chat:threads';
const THREAD_KEY_PREFIX = 'jil-portfolio-chat:thread:';

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

function validateOptionalEmail(email) {
  const cleaned = cleanString(email).toLowerCase();
  if (!cleaned) return { value: '' };
  if (cleaned.length > MAX_EMAIL_LENGTH) {
    return { error: 'Email is too long' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return { error: 'Enter a valid email address' };
  }
  return { value: cleaned };
}

function requestOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || '';
  return host ? `${protocol}://${host}` : '';
}

function emailConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const configuredFrom = process.env.CHAT_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || '';
  const from = configuredFrom || 'Jil Portfolio <onboarding@resend.dev>';
  const replyTo = process.env.CHAT_REPLY_TO_EMAIL || process.env.RESEND_REPLY_TO_EMAIL || process.env.REPLY_TO_EMAIL || configuredFrom;

  if (!apiKey) {
    return { error: 'Email notices need RESEND_API_KEY in Vercel.' };
  }

  return {
    apiKey,
    from,
    replyTo,
    usingDefaultFrom: !configuredFrom
  };
}

function parseEmailError(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return parsed.message || parsed.error || text;
  } catch (error) {
    return text;
  }
}

function emailHtml(text, siteUrl) {
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
  const link = siteUrl ? `<p><a href="${siteUrl}">Open the portfolio chat</a></p>` : '';
  return `<p>Jil replied to your portfolio chat:</p><blockquote>${escapedText}</blockquote>${link}<p>You can continue the conversation from the same browser where you started it.</p>`;
}

function publicThread(thread) {
  return {
    id: thread.id,
    name: thread.name,
    email: thread.email || '',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages || []
  };
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
    email: thread.email || '',
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

async function sendReplyEmail(thread, replyText, req) {
  if (!thread.email) return { sent: false, reason: 'no-email' };

  const config = emailConfig();
  if (config.error) return { sent: false, reason: 'not-configured', message: config.error };

  const siteUrl = process.env.CHAT_SITE_URL || requestOrigin(req);
  const emailPayload = {
    from: config.from,
    to: thread.email,
    subject: 'Jil replied to your portfolio chat',
    text: `Jil replied to your portfolio chat:\n\n${replyText}\n\nOpen the portfolio chat from the same browser where you started it: ${siteUrl}`,
    html: emailHtml(replyText, siteUrl)
  };

  if (config.replyTo) {
    emailPayload.reply_to = config.replyTo;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'jil-portfolio-chat/1.0'
      },
      body: JSON.stringify(emailPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let message = parseEmailError(errorText);
      if (config.usingDefaultFrom) {
        message = `${message || 'Email request failed'} Set CHAT_FROM_EMAIL or RESEND_FROM_EMAIL to a verified Resend sender in Vercel.`;
      }
      console.error('Reply email failed:', response.status, errorText);
      return { sent: false, reason: 'failed', status: response.status, message };
    }

    return { sent: true };
  } catch (error) {
    console.error('Reply email failed:', error);
    return { sent: false, reason: 'failed', message: error.message || 'Email request failed' };
  }
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

async function handleVisitorMessage(body, res) {
  const textResult = validateText(body.text, 'Message', MAX_TEXT_LENGTH);
  if (textResult.error) return sendJson(res, 400, { error: textResult.error });

  const emailResult = validateOptionalEmail(body.email);
  if (emailResult.error) return sendJson(res, 400, { error: emailResult.error });

  let thread = await getThread(cleanString(body.threadId));
  if (!thread) {
    const nameResult = validateText(body.name, 'Name', MAX_NAME_LENGTH);
    if (nameResult.error) return sendJson(res, 400, { error: nameResult.error });

    const now = new Date().toISOString();
    thread = {
      id: randomUUID(),
      visitorToken: randomUUID(),
      name: nameResult.value,
      email: emailResult.value,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  } else {
    if (!visitorTokenMatches(thread, body.visitorToken)) {
      return sendJson(res, 403, { error: 'Conversation access expired. Start a new chat from this browser.' });
    }
    if (!thread.visitorToken) thread = { ...thread, visitorToken: randomUUID() };
    if (emailResult.value && emailResult.value !== thread.email) {
      thread = { ...thread, email: emailResult.value };
    }
  }

  thread = addMessage(thread, createMessage('visitor', thread.name, textResult.value));
  await saveThread(thread);
  await saveThreadSummary(thread);

  return sendJson(res, 200, { threadId: thread.id, visitorToken: thread.visitorToken, thread: publicThread(thread) });
}

async function handleOwnerList(body, req, res) {
  const owner = verifyOwner(body, req);
  if (owner.error) return sendJson(res, owner.statusCode || 500, { error: owner.error });

  const threads = await getThreadList();
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

  const emailNotice = await sendReplyEmail(thread, textResult.value, req);
  return sendJson(res, 200, { thread: publicThread(thread), emailNotice });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
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

    if (action === 'visitor-message') return handleVisitorMessage(body, res);
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
    return sendJson(res, 500, { error: error.message || 'Chat is unavailable' });
  }
};
