const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOAL = 5;
// The customer group new users are invited to after their first stamp
// (https://t.me/ibtaphouse). A numeric chat id also works here; the bot must
// be an admin of this group to receive chat_member updates for it.
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '@ibtaphouse';
const GROUP_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Talks to Supabase over its REST API (PostgREST) with the service-role key,
// which bypasses RLS — this bot is a trusted backend, not a signed-in app
// user, same role node-fetch already played against the Telegram API.
async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase request failed (${res.status}): ${text}`);
  }
  // Prefer: return=minimal makes writes come back 201 Created with an empty
  // body (not 204), so res.json() on that would throw a JSON parse error —
  // read as text first and only parse if there's actually content.
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function getCustomer(userId) {
  const rows = await supabaseRequest(`point_card_customers?telegram_user_id=eq.${encodeURIComponent(userId)}&select=*`);
  return rows[0] || null;
}

async function getPoints(userId) {
  const customer = await getCustomer(userId);
  return customer ? Number(customer.points) || 0 : 0;
}

// One row per stamp/redeem event — this is what lets the POS dashboard show
// a customer's visit history and per-store usage counts, which a single
// running total (the old Google Sheet) couldn't do.
async function insertEvent({ userId, username, storeId, eventType, pointsAfter }) {
  await supabaseRequest('point_card_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      telegram_user_id: userId,
      telegram_username: username,
      store_id: storeId || null,
      event_type: eventType,
      points_after: pointsAfter,
    }),
  });
}

async function upsertAndAdd(userId, username, storeId, addNum) {
  const now = new Date().toISOString();
  const today = new Date().toDateString();
  const customer = await getCustomer(userId);

  if (customer) {
    const cur = Number(customer.points) || 0;
    const lastUpdated = customer.last_stamped_at ? new Date(customer.last_stamped_at).toDateString() : '';
    if (lastUpdated === today) {
      return { points: cur, bonusMsg: '', alreadyStamped: true, isNewUser: false };
    }
    let next = cur + addNum;
    let bonusMsg = '';
    let eventType = 'stamp';
    if (next >= GOAL) {
      bonusMsg = `Thanks so much for coming by as always! 🍺 You've reached ${GOAL} points! Pick your favorite beer and let our staff know 🎁\nWe'll keep brewing great beer, so enjoy your time at TAPHOUSE!`;
      next = 0;
      eventType = 'redeem';
    }
    await supabaseRequest(`point_card_customers?telegram_user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_username: username, points: next, last_stamped_at: now }),
    });
    await insertEvent({ userId, username, storeId, eventType, pointsAfter: next });
    return { points: next, bonusMsg, alreadyStamped: false, isNewUser: false };
  }

  // 新規ユーザー
  await supabaseRequest('point_card_customers', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ telegram_user_id: userId, telegram_username: username, points: addNum, last_stamped_at: now }),
  });
  await insertEvent({ userId, username, storeId, eventType: 'stamp', pointsAfter: addNum });
  return { points: addNum, bonusMsg: '', alreadyStamped: false, isNewUser: true };
}

async function sendMessage(chatId, text, retry = 3) {
  for (let i = 0; i < retry; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return;
    } catch (err) {
      console.error(`sendMessage attempt ${i + 1} failed:`, err.message);
      if (i < retry - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function telegramRequest(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const body = await res.json().catch(() => null);
  if (!body || !body.ok) {
    throw new Error(`Telegram ${method} failed: ${body ? body.description : res.status}`);
  }
  return body.result;
}

// ---------- Customer group membership ----------
// point_card_customers.group_status is what lets the POS list who left the
// group, alongside the store they registered their point card at.
//   'member'     — currently in the group
//   'left'       — seen in the group, then left or was removed
//   'not_member' — not in the group, and the bot never saw them in it (never
//                  joined, or left before this tracking existed)

function isGroupChat(chat) {
  if (!chat) return false;
  if (String(GROUP_CHAT_ID).startsWith('@')) {
    return chat.username && `@${chat.username}`.toLowerCase() === String(GROUP_CHAT_ID).toLowerCase();
  }
  return String(chat.id) === String(GROUP_CHAT_ID);
}

function isInGroup(chatMember) {
  const status = chatMember && chatMember.status;
  if (status === 'creator' || status === 'administrator' || status === 'member') return true;
  return status === 'restricted' && Boolean(chatMember.is_member);
}

// PATCH only touches existing point card customers — people who are in the
// group without ever having stamped aren't tracked.
async function updateGroupStatus(userId, fields) {
  await supabaseRequest(`point_card_customers?telegram_user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...fields, group_checked_at: new Date().toISOString() }),
  });
}

// Real-time join/leave, delivered as a chat_member update.
async function handleChatMemberUpdate(update) {
  if (!isGroupChat(update.chat)) return;
  const member = update.new_chat_member;
  if (!member || !member.user || member.user.is_bot) return;
  const userId = String(member.user.id);
  if (isInGroup(member)) {
    await updateGroupStatus(userId, { group_status: 'member', group_left_at: null });
  } else {
    const leftAt = new Date((update.date || Date.now() / 1000) * 1000).toISOString();
    await updateGroupStatus(userId, { group_status: 'left', group_left_at: leftAt });
  }
}

// Telegram has no "list group members" API, so the sweep asks getChatMember
// for each known customer. This covers customers who left before the bot was
// receiving chat_member updates, and any update missed while the bot was down.
async function sweepGroupMembership() {
  const customers = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabaseRequest(`point_card_customers?select=telegram_user_id,group_status&order=telegram_user_id&limit=1000&offset=${offset}`);
    customers.push(...rows);
    if (rows.length < 1000) break;
  }
  let changed = 0;
  for (const customer of customers) {
    try {
      const member = await telegramRequest('getChatMember', { chat_id: GROUP_CHAT_ID, user_id: Number(customer.telegram_user_id) });
      const prev = customer.group_status;
      if (isInGroup(member)) {
        if (prev !== 'member') changed += 1;
        await updateGroupStatus(customer.telegram_user_id, { group_status: 'member', group_left_at: null });
      } else if (prev === 'member') {
        // Left while no chat_member update reached us — the exact time is
        // unknown, so this records when the sweep noticed.
        changed += 1;
        await updateGroupStatus(customer.telegram_user_id, { group_status: 'left', group_left_at: new Date().toISOString() });
      } else if (prev !== 'left') {
        if (prev !== 'not_member') changed += 1;
        await updateGroupStatus(customer.telegram_user_id, { group_status: 'not_member' });
      }
    } catch (err) {
      console.error(`group sweep failed for ${customer.telegram_user_id}:`, err.message);
    }
    // Stay well under Telegram's ~30 requests/second limit.
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`group sweep done: ${customers.length} customers, ${changed} changed`);
}

// chat_member updates are only delivered when explicitly listed in the
// webhook's allowed_updates, so re-register the existing webhook URL with it.
async function ensureWebhookAllowsChatMember() {
  const info = await telegramRequest('getWebhookInfo');
  if (!info.url) return;
  const allowed = info.allowed_updates || [];
  if (allowed.includes('chat_member')) return;
  await telegramRequest('setWebhook', {
    url: info.url,
    allowed_updates: ['message', 'edited_message', 'chat_member'],
  });
  console.log('webhook now receives chat_member updates');
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
    if (update.chat_member) {
      await handleChatMemberUpdate(update.chat_member);
      return;
    }
    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const username = msg.from.username ||
      [msg.from.first_name || '', msg.from.last_name || ''].join(' ').trim();
    const text = (msg.text || '').trim();

    // Each store's QR encodes its own deep link (.../start=stamp_<store id>),
    // so the store id rides along in the /start payload and gets logged with
    // the event — this is the only per-store signal the bot ever sees.
    const startMatch = text.match(/^\/start(?:@\w+)?\s+stamp_(\S+)/i);
    if (startMatch) {
      const storeId = startMatch[1];
      const result = await upsertAndAdd(userId, username, storeId, 1);
      if (result.alreadyStamped) {
        await sendMessage(chatId, `You've already got your stamp today! 😊\nCome back tomorrow for your next one.\nCurrently ${result.points} / ${GOAL}`);
        return;
      }
      const displayPoints = result.bonusMsg ? GOAL : result.points;
      let reply = `Stamp added!! Currently ${displayPoints} / ${GOAL}`;
      if (result.bonusMsg) reply += '\n\n' + result.bonusMsg;
      await sendMessage(chatId, reply);
      if (result.isNewUser) {
        setTimeout(async () => {
          await sendMessage(chatId, `🎉 Welcome to TAPHOUSE!\n\nJoin our exclusive customer group here:\nhttps://t.me/ibtaphouse\n\nWe look forward to seeing you again! 🍺`);
        }, 3000);
      }
      return;
    }

    if (/^\/mypoints(?:@\w+)?$/i.test(text)) {
      const p = await getPoints(userId);
      await sendMessage(chatId, `Currently ${p} / ${GOAL}`);
      return;
    }

    if (/^\/help(?:@\w+)?$/i.test(text)) {
      await sendMessage(chatId, 'How to use:\n- Each time you visit, scan the QR code to earn 1 point. Collect 5 points and get a free pint of your favorite beer!\n- You can check your current points with /mypoints.');
      return;
    }
  } catch (err) {
    console.error('webhook error:', err);
  }
});

app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  ensureWebhookAllowsChatMember().catch(err => console.error('setWebhook error:', err.message));
  const runSweep = () => sweepGroupMembership().catch(err => console.error('group sweep error:', err.message));
  setTimeout(runSweep, 10000);
  setInterval(runSweep, GROUP_SWEEP_INTERVAL_MS);
});
