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

// ==========================================
// ПАПКА ДЛЯ ЛОГОВ
// ==========================================
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOGS_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);

function log(type, message, data = null) {
    const now = new Date();
    const time = now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    const logMessage = `[${time}] [${type}] ${message}`;
    console.log(logMessage);
    
    let fileMessage = `[${time}] [${type}] ${message}`;
    if (data) {
        fileMessage += '\n' + JSON.stringify(data, null, 2);
    }
    fileMessage += '\n' + '-'.repeat(80) + '\n';
    
    try {
        fs.appendFileSync(LOG_FILE, fileMessage);
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
// ВЕБ-СЕРВЕР
// ==========================================

const PORT = process.env.PORT || 8080;

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
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    log('SUCCESS', `Веб-сервер на порту ${PORT}`);
});

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
        connectionRetries: 5,
        retryDelay: 3000,
    });
    
    try {
        console.log('🔌 Подключение к Telegram...');
        log('CONNECT', 'Подключение к Telegram...');
        
        await client.connect();
        
        console.log('✅ Подключено!');
        log('SUCCESS', 'Подключено к Telegram');
        
        const me = await client.getMe();
        const userName = `${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'нет'})`;
        console.log(`👤 Авторизован: ${userName}`);
        log('SUCCESS', `Авторизован: ${userName}`);
        
        console.log('✅ БОТ ЗАПУЩЕН И МОНИТОРИТ ЧАТЫ');
        log('START', 'БОТ ЗАПУЩЕН');
        
        // Обработчик сообщений
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                
                if (message.out) return;
                
                totalProcessed++;
                
                const text = message.message || '';
                if (!text || text.length < 15) return;
                
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
                    chatName = chat.title || `${chat.firstName || ''} ${chat.lastName || ''}`.trim() || 'Личный чат';
                } catch (e) {}
                
                const matchedWords = [...foundPrimary, ...foundSecondary].join(', ');
                console.log(`💬 Ключевые слова в "${chatName}": ${matchedWords}`);
                
                const { isClient, reason } = isRealClient(text);
                
                if (!isClient) {
                    totalSkipped++;
                    console.log(`⏭️ Пропущено (${chatName}): ${reason}`);
                    return;
                }
                
                totalLeads++;
                
                let chatLink = '';
                let senderName = 'Неизвестный';
                let senderUsername = 'нет';
                let msgLink = '';
                
                try {
                    const chat = await message.getChat();
                    chatName = chat.title || `${chat.firstName || ''} ${chat.lastName || ''}`.trim() || 'Личный чат';
                    
                    if (chat.username) {
                        chatLink = `https://t.me/${chat.username}`;
                        msgLink = `https://t.me/${chat.username}/${message.id}`;
                    } else {
                        chatLink = `чат ID: ${chat.id}`;
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
                
                try {
                    await client.sendMessage('me', { message: leadMessage });
                    console.log(`🎯 ЛИД: ${chatName} | ${urgency}`);
                    log('LEAD', `Лид отправлен: ${chatName}`, {
                        chat: chatName,
                        sender: senderName,
                        urgency: urgency,
                        contacts: contacts
                    });
                } catch (e) {
                    console.error(`❌ Ошибка отправки: ${e.message}`);
                }
                
                leadsHistory.push({
                    date: new Date(),
                    chat: chatName,
                    sender: senderName,
                    text: text.substring(0, 100),
                    urgency: urgency,
                    city: city,
                    contacts: contacts
                });
                
                chatStats[chatName] = (chatStats[chatName] || 0) + 1;
                
            } catch (error) {
                console.error('Ошибка обработки:', error.message);
            }
        }, new NewMessage({}));
        
        // Команды
        client.addEventHandler(async (event) => {
            const message = event.message;
            const text = message.message || '';
            
            if (text === '/stats') {
                const total = leadsHistory.length;
                const today = leadsHistory.filter(l => {
                    const leadDate = new Date(l.date);
                    const now = new Date();
                    return leadDate.toDateString() === now.toDateString();
                }).length;
                const high = leadsHistory.filter(l => l.urgency.includes('HIGH')).length;
                
                const uptime = Math.floor((new Date() - botStartTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                
                let stats = `📊 СТАТИСТИКА\n\n`;
                stats += `⏱ Аптайм: ${hours}ч ${minutes}м\n`;
                stats += `🔴 Срочных: ${high}\n`;
                stats += `📝 Всего: ${total}\n`;
                stats += `📅 Сегодня: ${today}\n`;
                stats += `👀 Проверено: ${totalProcessed}\n\n`;
                stats += `📈 ТОП ЧАТОВ:\n`;
                
                const sorted = Object.entries(chatStats).sort((a, b) => b[1] - a[1]).slice(0, 5);
                
                if (sorted.length === 0) {
                    stats += `(пока пусто)\n`;
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
                    const time = new Date(l.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                    result += `${i + 1}. ${time} | ${l.urgency} | ${l.chat}\n   ${l.sender}: ${l.text}\n\n`;
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
        log('SUCCESS', 'Бот готов к работе');
        
    } catch (err) {
        console.error(`❌ Ошибка: ${err.message}`);
        log('ERROR', `Ошибка запуска: ${err.message}`);
        
        console.log('🔄 Повтор через 10 секунд...');
        setTimeout(() => {
            startBot().catch(e => console.error('Ошибка:', e.message));
        }, 10000);
    }
}

// ==========================================
// ЗАПУСК
// ==========================================

(async () => {
    console.log('🚀 ЗАПУСК ПРИЛОЖЕНИЯ');
    startBot().catch(err => {
        console.error('Критическая ошибка:', err.message);
    });
})();

// Поддержание процесса
process.on('SIGTERM', () => {
    console.log('SIGTERM');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT');
    process.exit(0);
});

// Каждые 5 минут пишем что живы
setInterval(() => {
    console.log(`💚 Жив. Лидов: ${totalLeads}, Проверено: ${totalProcessed}`);
}, 300000);
