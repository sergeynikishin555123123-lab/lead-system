require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
    PRIMARY_KEYWORDS,
    SECONDARY_KEYWORDS,
    STOP_WORDS,
    URGENCY_KEYWORDS,
    CITIES,
    CLIENT_MARKERS
} = require('./filters');

// ==========================================
// НАСТРОЙКИ
// ==========================================
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';
const PORT = parseInt(process.env.PORT) || 8080;

// ==========================================
// ПАПКА ДЛЯ ЛОГОВ
// ==========================================
const LOGS_DIR = '/tmp/lead-logs';
const LOG_FILE = path.join(LOGS_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);

try {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    console.log('✅ Логи в /tmp/lead-logs');
} catch (error) {
    console.warn('⚠️ Логи только в консоль');
}

function log(type, message, data = null) {
    const now = new Date();
    const time = now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    const logMessage = `[${time}] [${type}] ${message}`;
    console.log(logMessage);
    
    if (data) console.log(JSON.stringify(data, null, 2));
    console.log('-'.repeat(80));
    
    try {
        if (LOGS_DIR && fs.existsSync(LOGS_DIR)) {
            let fileMessage = `[${time}] [${type}] ${message}`;
            if (data) fileMessage += '\n' + JSON.stringify(data, null, 2);
            fileMessage += '\n' + '-'.repeat(80) + '\n';
            fs.appendFileSync(LOG_FILE, fileMessage);
        }
    } catch (e) {}
}

// ==========================================
// ХРАНЕНИЕ
// ==========================================
const leadsHistory = [];
const chatStats = {};
const processedMessages = new Set();
let totalProcessed = 0;
let totalSkipped = 0;
let totalLeads = 0;
const botStartTime = new Date();

// ==========================================
// ВЕБ-СЕРВЕР (для Render health check)
// ==========================================
const server = http.createServer((req, res) => {
    const uptime = Math.floor((new Date() - botStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    const healthData = {
        status: 'running',
        uptime: `${hours}ч ${minutes}м ${seconds}с`,
        totalLeads: totalLeads,
        totalProcessed: totalProcessed,
        totalSkipped: totalSkipped,
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(healthData, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Веб-сервер на порту ${PORT}`);
});

// ==========================================
// ФУНКЦИЯ ПОДДЕРЖАНИЯ АКТИВНОСТИ (сам себе пишет)
// ==========================================
async function keepAlive(client) {
    console.log('🔄 Запущена система поддержания активности (каждые 4 минуты)');
    
    // Функция отправки keep-alive сообщения
    const sendKeepAlive = async () => {
        try {
            if (client && client.connected) {
                const now = new Date();
                const time = now.toLocaleTimeString('ru-RU');
                // Отправляем себе невидимое сообщение (с точкой, чтобы не засорять)
                await client.sendMessage('me', { message: `.` });
                console.log(`💓 Keep-alive отправлен в ${time}`);
            } else {
                console.log(`⚠️ Keep-alive: клиент не подключен`);
            }
        } catch (error) {
            console.log(`❌ Keep-alive ошибка: ${error.message}`);
        }
    };
    
    // Первый раз через 2 минуты после запуска
    setTimeout(sendKeepAlive, 2 * 60 * 1000);
    
    // Дальше каждые 4 минуты (Render отключает через 15 минут без активности)
    setInterval(sendKeepAlive, 4 * 60 * 1000);
}

// ==========================================
// ФУНКЦИИ
// ==========================================
function extractContacts(text) {
    const contacts = [];
    
    const phonePatterns = [
        /\+7[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
        /8[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
    ];
    
    phonePatterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) contacts.push(...matches);
    });
    
    const usernames = text.match(/@[\w_]+/g);
    if (usernames) contacts.push(...usernames);
    
    const unique = [...new Set(contacts)];
    return unique.length > 0 ? unique.join(', ') : 'нет';
}

function detectCity(text) {
    const textLower = text.toLowerCase();
    for (const city of CITIES) {
        if (textLower.includes(city)) {
            return city.charAt(0).toUpperCase() + city.slice(1);
        }
    }
    return 'не указан';
}

function detectUrgency(text) {
    const textLower = text.toLowerCase();
    const scores = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    
    for (const [level, keywords] of Object.entries(URGENCY_KEYWORDS)) {
        keywords.forEach(word => {
            if (textLower.includes(word)) scores[level]++;
        });
    }
    
    if (scores.HIGH > 0) return '🔴 HIGH';
    if (scores.MEDIUM > 0) return '🟡 MEDIUM';
    if (scores.LOW > 0) return '🟢 LOW';
    return '🟡 MEDIUM';
}

function isRealClient(text) {
    const textLower = text.toLowerCase();
    
    for (const word of STOP_WORDS) {
        if (textLower.includes(word)) {
            return { isClient: false, reason: `стоп-слово: "${word}"` };
        }
    }
    
    let clientScore = 0;
    CLIENT_MARKERS.forEach(marker => {
        if (textLower.includes(marker)) clientScore++;
    });
    
    let primaryScore = 0;
    PRIMARY_KEYWORDS.forEach(word => {
        if (textLower.includes(word)) primaryScore++;
    });
    
    let secondaryScore = 0;
    SECONDARY_KEYWORDS.forEach(word => {
        if (textLower.includes(word)) secondaryScore++;
    });
    
    const total = primaryScore * 3 + secondaryScore * 2 + clientScore * 2;
    
    if (total >= 5) {
        return { isClient: true, reason: `уверенный лид (баллы: ${total})`, score: total };
    } else if (total >= 3) {
        return { isClient: true, reason: `возможный лид (баллы: ${total})`, score: total };
    } else {
        return { isClient: false, reason: `мало признаков (баллы: ${total})`, score: total };
    }
}

function formatLead(chatName, chatLink, senderName, senderUsername, text, contacts, city, urgency, reason, msgLink) {
    return `
${urgency} НОВЫЙ ЛИД

📌 Чат: ${chatName}
🔗 Чат: ${chatLink}
👤 Отправитель: ${senderName}
📝 Username: ${senderUsername}
📍 Город: ${city}
📞 Контакты: ${contacts}

💬 Сообщение:
${text.substring(0, 500)}${text.length > 500 ? '...' : ''}

🔗 Ссылка: ${msgLink}

📊 ${reason}
⏰ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
`.trim();
}

// ==========================================
// ЗАПУСК БОТА
// ==========================================
async function startBot() {
    console.log('🤖 Запуск юзербота...');
    log('START', 'Запуск юзербота');
    
    if (!SESSION_STRING || SESSION_STRING.length < 10) {
        console.error('❌ SESSION_STRING не найдена!');
        log('ERROR', 'SESSION_STRING не найдена');
        return;
    }
    
    const stringSession = new StringSession(SESSION_STRING);
    
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 10,
        retryDelay: 3000,
        useWSS: true,
        deviceModel: 'Desktop',
        systemVersion: 'Windows 11',
        autoReconnect: true,
        baseLogger: console
    });
    
    try {
        console.log('🔌 Подключение к Telegram...');
        await client.connect();
        
        console.log('✅ Подключено!');
        
        const me = await client.getMe();
        console.log(`👤 Авторизован: ${me.firstName || ''} @${me.username || 'нет'}`);
        
        console.log('✅ БОТ ЗАПУЩЕН И МОНИТОРИТ ЧАТЫ');
        
        // ЗАПУСКАЕМ KEEP-ALIVE (сам себе пишет каждые 4 минуты)
        keepAlive(client);
        
        // ==========================================
        // ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
        // ==========================================
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                
                if (message.out) return;
                
                const text = message.message || '';
                if (!text || text.length < 15) return;
                if (text.startsWith('/')) return;
                
                // Пропускаем keep-alive сообщения (точка)
                if (text === '.') return;
                
                totalProcessed++;
                
                const chatId = message.chatId?.toString() || '';
                const msgHash = text.substring(0, 100) + chatId;
                
                if (processedMessages.has(msgHash)) return;
                processedMessages.add(msgHash);
                
                if (processedMessages.size > 10000) {
                    processedMessages.clear();
                }
                
                const textLower = text.toLowerCase();
                
                const foundPrimary = PRIMARY_KEYWORDS.filter(word => textLower.includes(word));
                const foundSecondary = SECONDARY_KEYWORDS.filter(word => textLower.includes(word));
                
                if (foundPrimary.length === 0 && foundSecondary.length === 0) return;
                
                let chatName = 'Неизвестный чат';
                try {
                    const chat = await message.getChat();
                    chatName = chat.title || 'Личный чат';
                } catch (e) {}
                
                const { isClient, reason } = isRealClient(text);
                
                if (!isClient) {
                    totalSkipped++;
                    return;
                }
                
                totalLeads++;
                
                let chatLink = '';
                let senderName = 'Неизвестный';
                let senderUsername = 'нет';
                let msgLink = '';
                
                try {
                    const chat = await message.getChat();
                    chatName = chat.title || 'Личный чат';
                    
                    if (chat.username) {
                        chatLink = `https://t.me/${chat.username}`;
                        msgLink = `https://t.me/${chat.username}/${message.id}`;
                    } else {
                        msgLink = `https://t.me/c/${chat.id.toString().replace('-100', '')}/${message.id}`;
                    }
                } catch (e) {}
                
                try {
                    const sender = await message.getSender();
                    senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Неизвестный';
                    senderUsername = sender.username ? `@${sender.username}` : 'нет';
                } catch (e) {}
                
                const contacts = extractContacts(text);
                const city = detectCity(text);
                const urgency = detectUrgency(text);
                
                const leadMessage = formatLead(
                    chatName, chatLink, senderName, senderUsername,
                    text, contacts, city, urgency, reason, msgLink
                );
                
                await client.sendMessage('me', { message: leadMessage });
                console.log(`🎯 ЛИД: ${chatName} | ${urgency}`);
                
                leadsHistory.push({
                    date: new Date(),
                    chat: chatName,
                    sender: senderName,
                    text: text.substring(0, 100),
                    urgency: urgency
                });
                
                chatStats[chatName] = (chatStats[chatName] || 0) + 1;
                
            } catch (error) {
                console.error('Ошибка:', error.message);
            }
        }, new NewMessage({}));
        
        // ==========================================
        // КОМАНДЫ
        // ==========================================
        client.addEventHandler(async (event) => {
            const message = event.message;
            const text = message.message || '';
            
            if (text === '/stats') {
                const total = leadsHistory.length;
                const today = leadsHistory.filter(l => {
                    return new Date(l.date).toDateString() === new Date().toDateString();
                }).length;
                const high = leadsHistory.filter(l => l.urgency.includes('HIGH')).length;
                
                const uptime = Math.floor((new Date() - botStartTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                
                let stats = `📊 СТАТИСТИКА\n\n`;
                stats += `⏱ Аптайм: ${hours}ч ${minutes}м\n`;
                stats += `🔴 Срочных: ${high}\n`;
                stats += `📝 Всего лидов: ${total}\n`;
                stats += `📅 Сегодня: ${today}\n`;
                stats += `👀 Проверено: ${totalProcessed}\n\n`;
                stats += `📈 ТОП ЧАТОВ:\n`;
                
                const sorted = Object.entries(chatStats).sort((a, b) => b[1] - a[1]).slice(0, 5);
                if (sorted.length === 0) {
                    stats += `(пока пусто)`;
                } else {
                    sorted.forEach(([chat, count]) => {
                        stats += `• ${chat}: ${count}\n`;
                    });
                }
                
                await message.reply({ message: stats });
            }
            
            if (text === '/last') {
                if (leadsHistory.length === 0) {
                    await message.reply({ message: '📭 Пусто' });
                    return;
                }
                
                const recent = leadsHistory.slice(-5).reverse();
                let result = `📋 ПОСЛЕДНИЕ 5:\n\n`;
                recent.forEach((l, i) => {
                    const time = new Date(l.date).toLocaleTimeString('ru-RU');
                    result += `${i+1}. ${time} | ${l.urgency} | ${l.chat}\n   ${l.sender}: ${l.text}\n\n`;
                });
                await message.reply({ message: result });
            }
            
            if (text === '/ping') {
                await message.reply({ message: '🏓 Понг! Бот работает!' });
            }
            
            if (text === '/reset') {
                totalProcessed = 0;
                totalSkipped = 0;
                totalLeads = 0;
                leadsHistory.length = 0;
                Object.keys(chatStats).forEach(key => delete chatStats[key]);
                await message.reply({ message: '✅ Статистика сброшена!' });
            }
            
        }, new NewMessage({ fromUsers: ['me'] }));
        
        console.log('✅ ГОТОВ К РАБОТЕ');
        console.log('⏰ Keep-alive: каждые 4 минуты бот пишет себе точку');
        
        // Каждые 5 минут пишем в консоль статус
        setInterval(() => {
            console.log(`💚 Жив. Лидов: ${totalLeads}, Проверено: ${totalProcessed}`);
        }, 300000);
        
    } catch (err) {
        console.error(`❌ Ошибка: ${err.message}`);
        setTimeout(() => startBot(), 10000);
    }
}

// ==========================================
// ЗАПУСК
// ==========================================
(async () => {
    console.log('🚀 ЗАПУСК ПРИЛОЖЕНИЯ');
    startBot();
})();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
