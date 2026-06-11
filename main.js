require('dotenv').config();

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const {
  PRIMARY_KEYWORDS,
  SECONDARY_KEYWORDS,
  STOP_WORDS,
  CLIENT_MARKERS,
  CITIES,
  URGENCY_KEYWORDS,
  IGNORE_CHATS
} = require('./filters');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';

let processedMessages = new Set();
let totalLeads = 0;
let totalProcessed = 0;
let totalSkipped = 0;

function extractContacts(text) {
  const phones = text.match(/\+7[\d\s()-]{10,}/g);
  const tg = text.match(/@[\w_]+/g);
  return [...new Set([...(phones || []), ...(tg || [])])].join(', ') || 'нет';
}

function detectCity(text) {
  const lower = text.toLowerCase();
  return CITIES.find(c => lower.includes(c)) || 'не указан';
}

function detectUrgency(text) {
  const lower = text.toLowerCase();
  if (URGENCY_KEYWORDS.HIGH.some(w => lower.includes(w))) return 'HIGH';
  if (URGENCY_KEYWORDS.MEDIUM.some(w => lower.includes(w))) return 'MEDIUM';
  return 'LOW';
}

function isLead(text) {
  const lower = text.toLowerCase();
  if (STOP_WORDS.some(w => lower.includes(w))) return false;
  let score = 0;
  PRIMARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 3; });
  SECONDARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 2; });
  CLIENT_MARKERS.forEach(w => { if (lower.includes(w)) score += 2; });
  return score >= 3;
}

async function start() {
  console.log('🚀 Bot starting with TCP mode on port 443...');

  const client = new TelegramClient(
    new StringSession(SESSION_STRING),
    API_ID,
    API_HASH,
    {
      connectionRetries: 5,
      useWSS: false,           // Полностью отключаем WebSocket
      port: 443,               // Только 443 порт
      deviceModel: 'Desktop',
      systemVersion: 'Ubuntu 22.04',
      appVersion: '4.9.0',
      langCode: 'ru',
      autoReconnect: true,
      retryDelay: 3000,
      timeout: 30
    }
  );

  try {
    await client.connect();
    const me = await client.getMe();
    console.log('✅ Logged in as', me.firstName);
    console.log('✅ Connection: TCP on port 443');

    client.addEventHandler(async (event) => {
      try {
        const msg = event.message;
        if (!msg || msg.out) return;
        const text = msg.message;
        if (!text || text.length < 10) return;

        const msgId = `${msg.chatId}_${msg.id}`;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        totalProcessed++;

        const lower = text.toLowerCase();
        const hasKeyword = PRIMARY_KEYWORDS.some(w => lower.includes(w)) || 
                           SECONDARY_KEYWORDS.some(w => lower.includes(w));
        if (!hasKeyword) return;

        if (!isLead(text)) {
          totalSkipped++;
          return;
        }

        totalLeads++;

        const chat = await msg.getChat().catch(() => null);
        const sender = await msg.getSender().catch(() => null);
        const chatName = chat?.title || 'Личка';
        const senderName = sender?.firstName || 'user';
        const senderLink = sender?.username 
          ? `https://t.me/${sender.username}` 
          : (sender?.id ? `tg://user?id=${sender.id}` : 'нет ссылки');
        const messageLink = chat?.username
          ? `https://t.me/${chat.username}/${msg.id}`
          : '';

        const lead = `
🔴 НОВЫЙ ЛИД

📍 Чат: ${chatName}
👤 Отправитель: ${senderName}
🔗 Ссылка на отправителя: ${senderLink}
📞 Контакты: ${extractContacts(text)}
📍 Город: ${detectCity(text)}
⚡ Срочность: ${detectUrgency(text)}

💬 Сообщение:
${text.slice(0, 400)}

🔗 Ссылка на сообщение: ${messageLink || 'нет (приватный чат)'}
        `;

        await client.sendMessage('me', { message: lead });
        console.log(`🎯 LEAD #${totalLeads} | ${chatName}`);

      } catch (e) {
        console.log('ERROR in handler:', e.message);
      }
    }, new NewMessage({}));

    console.log('🤖 Bot is running...');
    
    // Проверка соединения каждую минуту
    setInterval(async () => {
      try {
        await client.getMe();
        console.log('💓 Connection alive');
      } catch(e) {
        console.log('⚠️ Connection lost, reconnecting...');
        try { await client.connect(); } catch(connErr) { console.log('Reconnect failed:', connErr.message); }
      }
    }, 60000);

  } catch (err) {
    console.log('❌ FATAL ERROR:', err.message);
    console.log('Restarting in 10 seconds...');
    setTimeout(start, 10000);
  }
}

start();
