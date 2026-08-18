const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOAL = 5;

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
  if (res.status === 204) return null;
  return res.json();
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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
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
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
