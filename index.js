const express = require('express');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Users';
const GOAL = 5;

async function getSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

async function getPoints(userId) {
  const sheets = await getSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) return Number(rows[i][2]) || 0;
  }
  return 0;
}

async function upsertAndAdd(userId, username, addNum) {
  const sheets = await getSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });
  const rows = res.data.values || [];
  const now = new Date().toISOString();
  const today = new Date().toDateString();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) {
      const cur = Number(rows[i][2]) || 0;
      const lastUpdated = rows[i][3] ? new Date(rows[i][3]).toDateString() : '';
      if (lastUpdated === today) {
        return { points: cur, bonusMsg: '', alreadyStamped: true, isNewUser: false };
      }
      let next = cur + addNum;
      let bonusMsg = '';
      if (next >= GOAL) {
        bonusMsg = `Thanks so much for coming by as always! 🍺 You've reached ${GOAL} points! Pick your favorite beer and let our staff know 🎁\nWe'll keep brewing great beer, so enjoy your time at TAPHOUSE!`;
        next = 0;
      }
      const rowNum = i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!C${rowNum}:D${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[next, now]] },
      });
      return { points: next, bonusMsg, alreadyStamped: false, isNewUser: false };
    }
  }

  // 新規ユーザー
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: [[userId, username, addNum, now]] },
  });
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

    if (/^\/start(?:@\w+)?\s+stamp_/i.test(text)) {
      const result = await upsertAndAdd(userId, username, 1);
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
