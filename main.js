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
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;
const HISTORY_MINUTES = parseInt(process.env.HISTORY_MINUTES) || 10; // Загружаем только за 10 минут

// ==========================================
// ПАПКА ДЛЯ ЛОГОВ
// ==========================================
const LOGS_DIR = '/tmp/lead-logs';
const LOG_FILE = path.join(LOGS_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);
const STATS_FILE = '/tmp/lead-stats.json';
const PROCESSED_IDS_FILE = '/tmp/processed-ids.json';

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
// ЗАГРУЗКА/СОХРАНЕНИЕ СТАТИСТИКИ
// ==========================================
function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            totalLeads = data.totalLeads || 0;
            totalProcessed = data.totalProcessed || 0;
            totalSkipped = data.totalSkipped || 0;
            console.log(`📂 Загружена статистика: ${totalLeads} лидов`);
        }
    } catch (e) {}
}

function saveStats() {
    try {
        const data = {
            totalLeads,
            totalProcessed,
            totalSkipped,
            lastSave: new Date().toISOString()
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(data));
    } catch (e) {}
}

// ==========================================
// ЗАГРУЗКА/СОХРАНЕНИЕ ID ОБРАБОТАННЫХ СООБЩЕНИЙ
// ==========================================
function loadProcessedIds() {
    try {
        if (fs.existsSync(PROCESSED_IDS_FILE)) {
            const ids = JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8'));
            ids.forEach(id => processedMessages.add(id));
            console.log(`📂 Загружено ${processedMessages.size} ID обработанных сообщений`);
        }
    } catch (e) {}
}

function saveProcessedId(msgId) {
    try {
        const data = JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf8') || '[]');
        data.push(msgId);
        // Оставляем только последние 10000 ID
        while (data.length > 10000) data.shift();
        fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify(data));
    } catch (e) {
        try {
            fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([msgId]));
        } catch(e2) {}
    }
}

// ==========================================
// ВЕБ-СЕРВЕР
// ==========================================
const server = http.createServer((req, res) => {
    const uptime = Math.floor((new Date() - botStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    let healthData = {
        status: 'running',
        uptime: `${hours}ч ${minutes}м ${seconds}с`,
        totalLeads: totalLeads,
        totalProcessed: totalProcessed,
        totalSkipped: totalSkipped,
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        port: PORT
    };
    
    if (req.url === '/health') {
        healthData = { status: 'alive', timestamp: Date.now() };
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(healthData, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Веб-сервер на порту ${PORT}`);
    log('SUCCESS', `Веб-сервер на порту ${PORT}`);
});

// ==========================================
// KEEP-ALIVE ДЛЯ RENDER FREE TIER
// ==========================================
function startKeepAlive() {
    console.log(`🔄 Keep-Alive активирован для Render Free`);
    console.log(`📍 Пингую: ${RENDER_URL}/health`);
    
    const ping = async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(`${RENDER_URL}/health`, {
                method: 'GET',
                headers: { 'User-Agent': 'Keep-Alive-Bot' },
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            console.log(`💓 Пинг OK (${response.status}) - ${new Date().toISOString()}`);
        } catch (error) {
            console.log(`⚠️ Пинг ошибка: ${error.message}`);
        }
    };
    
    setTimeout(ping, 30000);
    setInterval(ping, 10 * 60 * 1000);
    
    setInterval(() => {
        console.log(`💚 Бот активен. Лидов: ${totalLeads}, Проверено: ${totalProcessed}, RAM: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    }, 5 * 60 * 1000);
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
// ЗАГРУЗКА ПРОПУЩЕННЫХ СООБЩЕНИЙ (ТОЛЬКО ЗА N МИНУТ)
// ==========================================
async function loadMissedMessages(client, minutesBack = HISTORY_MINUTES) {
    console.log(`\n📖 ЗАГРУЗКА ПРОПУЩЕННЫХ СООБЩЕНИЙ`);
    console.log(`   За последние ${minutesBack} минут...`);
    
    const dialogs = await client.getDialogs({});
    const cutoffDate = new Date(Date.now() - minutesBack * 60 * 1000);
    let totalMessagesChecked = 0;
    let totalLeadsFound = 0;
    let totalSkippedDuplicate = 0;
    
    console.log(`📋 Доступно чатов: ${dialogs.length}\n`);
    
    for (const dialog of dialogs) {
        if (dialog.isBot) continue;
        if (dialog.name === 'Saved Messages') continue;
        
        try {
            console.log(`  🔍 ${dialog.name || 'Личный чат'}...`);
            
            const messages = await client.getMessages(dialog.id, { limit: 50 });
            let chatMessagesChecked = 0;
            let chatLeadsFound = 0;
            let chatDuplicates = 0;
            
            for (const msg of messages) {
                if (msg.out) continue;
                
                const msgDate = msg.date ? new Date(msg.date * 1000) : new Date();
                if (msgDate < cutoffDate) continue;
                
                // Проверяем не обрабатывали ли уже это сообщение
                const msgUniqueId = `${dialog.id}_${msg.id}`;
                if (processedMessages.has(msgUniqueId)) {
                    chatDuplicates++;
                    continue;
                }
                
                const text = msg.message || '';
                if (!text || text.length < 15) continue;
                if (text.startsWith('/')) continue;
                
                totalMessagesChecked++;
                chatMessagesChecked++;
                
                const textLower = text.toLowerCase();
                const foundPrimary = PRIMARY_KEYWORDS.filter(word => textLower.includes(word));
                const foundSecondary = SECONDARY_KEYWORDS.filter(word => textLower.includes(word));
                
                if (foundPrimary.length === 0 && foundSecondary.length === 0) continue;
                
                const { isClient, reason } = isRealClient(text);
                if (!isClient) continue;
                
                totalLeadsFound++;
                chatLeadsFound++;
                totalLeads++;
                
                // Добавляем ID в обработанные
                processedMessages.add(msgUniqueId);
                saveProcessedId(msgUniqueId);
                
                let chatName = dialog.name || 'Личный чат';
                let chatLink = '';
                let senderName = 'Неизвестный';
                let senderUsername = 'нет';
                let msgLink = '';
                
                try {
                    if (dialog.username) {
                        chatLink = `https://t.me/${dialog.username}`;
                        msgLink = `https://t.me/${dialog.username}/${msg.id}`;
                    } else {
                        msgLink = `https://t.me/c/${dialog.id.toString().replace('-100', '')}/${msg.id}`;
                    }
                } catch (e) {}
                
                try {
                    const sender = await msg.getSender();
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
                    console.log(`     🎯 ВОССТАНОВЛЕН ЛИД: ${urgency}`);
                    
                    leadsHistory.push({
                        date: msgDate,
                        chat: chatName,
                        sender: senderName,
                        text: text.substring(0, 100),
                        urgency: urgency,
                        city: city,
                        contacts: contacts
                    });
                    
                    if (chatStats[chatName]) {
                        chatStats[chatName]++;
                    } else {
                        chatStats[chatName] = 1;
                    }
                    
                    await new Promise(r => setTimeout(r, 300));
                    
                } catch (e) {
                    console.error(`     ❌ Ошибка отправки: ${e.message}`);
                }
            }
            
            if (chatMessagesChecked > 0 || chatLeadsFound > 0 || chatDuplicates > 0) {
                console.log(`     📊 Проверено: ${chatMessagesChecked}, Лидов: ${chatLeadsFound}, Дублей: ${chatDuplicates}`);
            }
            
        } catch (err) {
            console.log(`  ⚠️ Ошибка чата ${dialog.name}: ${err.message}`);
        }
    }
    
    console.log(`\n✅ ЗАГРУЗКА ЗАВЕРШЕНА!`);
    console.log(`   • Проверено новых сообщений: ${totalMessagesChecked}`);
    console.log(`   • Найдено новых лидов: ${totalLeadsFound}`);
    console.log(`   • Пропущено дублей: ${totalSkippedDuplicate}`);
    console.log(`   • Всего лидов теперь: ${totalLeads}\n`);
    
    return { totalMessagesChecked, totalLeadsFound };
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
        requestRetries: 5,
        receiveRetryDelay: 5000,
        useWSS: true,
        useIPv6: false,
        deviceModel: 'Desktop',
        systemVersion: 'Windows 11',
        appVersion: '10.5.0',
        langCode: 'ru',
        autoReconnect: true,
        maxConcurrentDownloads: 1,
        baseLogger: console
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
        
        // Загружаем сохраненные ID обработанных сообщений
        loadProcessedIds();
        
        // Загружаем статистику
        loadStats();
        
        // Загружаем пропущенные сообщения (только за последние N минут)
        await loadMissedMessages(client, HISTORY_MINUTES);
        
        console.log('✅ БОТ ЗАПУЩЕН И МОНИТОРИТ ЧАТЫ');
        log('START', 'БОТ ЗАПУЩЕН');
        
        // ==========================================
        // ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
        // ==========================================
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                
                if (message.out) return;
                
                const text = message.message || '';
                
                if (text.startsWith('/')) return;
                if (!text || text.length < 15) return;
                
                // Уникальный ID сообщения
                const chatId = message.chatId?.toString() || '';
                const msgUniqueId = `${chatId}_${message.id}`;
                
                // Проверяем не обрабатывали ли уже
                if (processedMessages.has(msgUniqueId)) return;
                processedMessages.add(msgUniqueId);
                saveProcessedId(msgUniqueId);
                
                totalProcessed++;
                
                if (processedMessages.size > 10000) {
                    processedMessages.clear();
                    loadProcessedIds();
                }
                
                const textLower = text.toLowerCase();
                
                const foundPrimary = PRIMARY_KEYWORDS.filter(word => textLower.includes(word));
                const foundSecondary = SECONDARY_KEYWORDS.filter(word => textLower.includes(word));
                
                if (foundPrimary.length === 0 && foundSecondary.length === 0) {
                    totalSkipped++;
                    return;
                }
                
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
                
                saveStats();
                
            } catch (error) {
                console.error('Ошибка обработки:', error.message);
            }
        }, new NewMessage({}));
        
        // ==========================================
        // ОБРАБОТЧИК КОМАНД
        // ==========================================
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
                stats += `📝 Всего лидов: ${total}\n`;
                stats += `📅 Сегодня: ${today}\n`;
                stats += `👀 Проверено сообщений: ${totalProcessed}\n`;
                stats += `⏭️ Пропущено: ${totalSkipped}\n`;
                stats += `💾 Память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`;
                stats += `📝 В кэше ID: ${processedMessages.size}\n\n`;
                stats += `📈 ТОП ЧАТОВ:\n`;
                
                const sorted = Object.entries(chatStats).sort((a, b) => b[1] - a[1]).slice(0, 5);
                
                if (sorted.length === 0) {
                    stats += `(пока пусто)\n`;
                } else {
                    sorted.forEach(([chat, count]) => {
                        stats += `• ${chat}: ${count} лидов\n`;
                    });
                }
                
                await message.reply({ message: stats });
            }
            
            if (text === '/last') {
                if (leadsHistory.length === 0) {
                    await message.reply({ message: '📭 Лидов пока нет' });
                    return;
                }
                
                const recent = leadsHistory.slice(-5).reverse();
                let result = `📋 ПОСЛЕДНИЕ 5 ЛИДОВ:\n\n`;
                
                recent.forEach((l, i) => {
                    const time = new Date(l.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                    result += `${i + 1}. ${time} | ${l.urgency} | ${l.chat}\n   ${l.sender}: ${l.text.substring(0, 50)}${l.text.length > 50 ? '...' : ''}\n\n`;
                });
                
                await message.reply({ message: result });
            }
            
            if (text === '/ping') {
                const uptime = Math.floor((new Date() - botStartTime) / 1000);
                await message.reply({ 
                    message: `🏓 Понг!\n⏱ Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м ${uptime%60}с\n🔄 Соединение: ${client.connected ? '✅ активно' : '❌ разорвано'}`
                });
            }
            
            if (text === '/reset') {
                totalProcessed = 0;
                totalSkipped = 0;
                totalLeads = 0;
                leadsHistory.length = 0;
                Object.keys(chatStats).forEach(key => delete chatStats[key]);
                saveStats();
                await message.reply({ message: '✅ Статистика сброшена!' });
            }
            
            if (text === '/history') {
                await message.reply({ message: `📖 Загружаю историю за последние ${HISTORY_MINUTES} минут...` });
                await loadMissedMessages(client, HISTORY_MINUTES);
                await message.reply({ message: `✅ История загружена! Всего лидов: ${totalLeads}` });
            }
            
        }, new NewMessage({ fromUsers: ['me'] }));
        
        console.log('✅ БОТ ГОТОВ К РАБОТЕ');
        log('SUCCESS', 'Бот готов к работе');
        
        // Запускаем Keep-Alive
        startKeepAlive();
        
        // Сохраняем статистику каждые 30 секунд
        setInterval(saveStats, 30000);
        
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
    console.log(`📦 Node.js ${process.version}`);
    console.log(`🕐 Время запуска: ${new Date().toLocaleString('ru-RU')}`);
    console.log(`📖 Загрузка истории за ${HISTORY_MINUTES} минут`);
    console.log(`🌐 Render Keep-Alive: включен (каждые 10 минут)`);
    
    startBot().catch(err => {
        console.error('Критическая ошибка:', err.message);
    });
})();

// ==========================================
// ОБРАБОТКА ЗАВЕРШЕНИЯ
// ==========================================
process.on('SIGTERM', () => {
    console.log('📡 SIGTERM - сохраняю статистику...');
    saveStats();
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('📡 SIGINT - сохраняю статистику...');
    saveStats();
    server.close(() => process.exit(0));
});
