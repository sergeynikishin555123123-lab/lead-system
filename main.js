require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const http = require('http');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';
const PORT = process.env.PORT || 8080;

const PRIMARY_KEYWORDS = ['электрик', 'электромонтаж', 'проводка', 'щит', 'розетка', 'освещение', 'кабель', 'штроба', 'нужен электрик'];
const SECONDARY_KEYWORDS = ['коротнул', 'искрит', 'выбивает', 'нет света', 'подключить', 'новостройка'];
const STOP_WORDS = ['вакансия', 'ищу работу', 'резюме', 'продам', 'куплю'];
const CLIENT_MARKERS = ['мне нужно', 'нужно сделать', 'ищу мастера', 'кто может сделать', 'посоветуйте', 'квартира', 'ремонт'];
const CITIES = ['москва', 'зеленоград', 'химки', 'лобня'];
const URGENCY_KEYWORDS = {
    HIGH: ['срочно', 'сегодня', 'сейчас', 'авария'],
    MEDIUM: ['завтра', 'на неделе', 'скоро']
};

let totalProcessed = 0, totalLeads = 0, totalSkipped = 0;
const processedMessages = new Set();
const botStartTime = Date.now();

const server = http.createServer((req, res) => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    res.end(JSON.stringify({ status: 'ok', uptime, totalLeads, totalProcessed }));
});
server.listen(PORT, '0.0.0.0');

function extractContacts(text) {
    const phones = text.match(/\+7[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g);
    const usernames = text.match(/@[\w_]+/g);
    return [...new Set([...(phones || []), ...(usernames || [])])].join(', ') || 'нет';
}

function detectCity(text) {
    const lower = text.toLowerCase();
    for (const city of CITIES) if (lower.includes(city)) return city;
    return 'не указан';
}

function detectUrgency(text) {
    const lower = text.toLowerCase();
    if (URGENCY_KEYWORDS.HIGH.some(w => lower.includes(w))) return 'HIGH';
    if (URGENCY_KEYWORDS.MEDIUM.some(w => lower.includes(w))) return 'MEDIUM';
    return 'LOW';
}

function isRealClient(text) {
    const lower = text.toLowerCase();
    if (STOP_WORDS.some(w => lower.includes(w))) return false;
    let score = 0;
    PRIMARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 3; });
    SECONDARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 2; });
    CLIENT_MARKERS.forEach(w => { if (lower.includes(w)) score += 2; });
    return score >= 3;
}

async function startBot() {
    console.log('Запуск...');
    const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay: 3000,
        autoReconnect: true
    });
    
    try {
        await client.connect();
        const me = await client.getMe();
        console.log(`Авторизован: ${me.firstName}`);
        console.log('Бот запущен');
        
        client.addEventHandler(async (event) => {
            try {
                const msg = event.message;
                if (msg.out) return;
                const text = msg.message || '';
                if (text.length < 15 || text.startsWith('/')) return;
                
                const msgId = `${msg.chatId}_${msg.id}`;
                if (processedMessages.has(msgId)) return;
                processedMessages.add(msgId);
                totalProcessed++;
                
                const lower = text.toLowerCase();
                const hasKeyword = PRIMARY_KEYWORDS.some(w => lower.includes(w)) || SECONDARY_KEYWORDS.some(w => lower.includes(w));
                if (!hasKeyword) return;
                
                if (!isRealClient(text)) {
                    totalSkipped++;
                    return;
                }
                
                totalLeads++;
                let chatName = 'Чат', sender = 'Пользователь', link = '';
                try {
                    const chat = await msg.getChat();
                    chatName = chat.title || 'Личка';
                    const s = await msg.getSender();
                    sender = s.firstName || 'Пользователь';
                    if (chat.username) link = `https://t.me/${chat.username}/${msg.id}`;
                } catch(e) {}
                
                const leadMsg = `НОВЫЙ ЛИД\nЧат: ${chatName}\nОт: ${sender}\nКонтакты: ${extractContacts(text)}\nГород: ${detectCity(text)}\nСрочность: ${detectUrgency(text)}\n\n${text.substring(0, 300)}\n\n${link}`;
                await client.sendMessage('me', { message: leadMsg });
                console.log(`Лид! Всего: ${totalLeads}`);
            } catch(err) {
                console.error('Ошибка обработки:', err.message);
            }
        }, new NewMessage({}));
        
        client.addEventHandler(async (event) => {
            const msg = event.message;
            const text = msg.message || '';
            if (text === '/stats') {
                const reply = `Лидов: ${totalLeads}\nПроверено: ${totalProcessed}`;
                await client.sendMessage(msg.chatId, { message: reply, replyTo: msg.id });
            }
            if (text === '/ping') {
                await client.sendMessage(msg.chatId, { message: 'pong', replyTo: msg.id });
            }
        }, new NewMessage({ fromUsers: ['me'] }));
        
    } catch(err) {
        console.error('Ошибка:', err.message);
        setTimeout(startBot, 10000);
    }
}

startBot();
