require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const http = require('http');
const fs = require('fs');
const {
    PRIMARY_KEYWORDS,
    SECONDARY_KEYWORDS,
    STOP_WORDS,
    URGENCY_KEYWORDS,
    CITIES,
    CLIENT_MARKERS,
    IGNORE_CHATS,
    MONITOR_CHAT_ID
} = require('./filters');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';
const PORT = process.env.PORT || 8080;

let totalProcessed = 0;
let totalLeads = 0;
let totalSkipped = 0;
let botStartTime = Date.now();
let lastActivityTime = Date.now();
let isBotRunning = true;
let botClient = null;

// Хранилище последних обработанных сообщений для отчета
const recentMessages = [];
const MAX_RECENT = 20;

const processedMessages = new Set();

// Функция для сохранения логов в файл
function logToFile(type, data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        data: data
    };
    fs.appendFileSync('bot.log', JSON.stringify(logEntry) + '\n');
}

// Веб-сервер для мониторинга
const server = http.createServer((req, res) => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: isBotRunning ? 'running' : 'stopped',
            uptime: `${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м ${uptime%60}с`,
            totalLeads,
            totalProcessed,
            totalSkipped,
            lastActivity: new Date(lastActivityTime).toLocaleString('ru-RU'),
            recentMessages: recentMessages.slice(-5)
        }));
    } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Lead Bot Stats</title><meta charset="UTF-8"></head>
            <body>
                <h1>📊 Статистика бота</h1>
                <p>Статус: ${isBotRunning ? '🟢 Работает' : '🔴 Остановлен'}</p>
                <p>Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м</p>
                <p>🎯 Лидов найдено: ${totalLeads}</p>
                <p>👀 Проверено сообщений: ${totalProcessed}</p>
                <p>⏭️ Пропущено: ${totalSkipped}</p>
                <p>⏰ Последняя активность: ${new Date(lastActivityTime).toLocaleString('ru-RU')}</p>
                <h2>Последние 10 обработанных сообщений:</h2>
                <pre>${JSON.stringify(recentMessages.slice(-10), null, 2)}</pre>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`📊 Веб-сервер мониторинга запущен на порту ${PORT}`);
});

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
    return [...new Set(contacts)].join(', ') || 'нет';
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
    if (URGENCY_KEYWORDS.HIGH.some(w => textLower.includes(w))) return '🔴 HIGH';
    if (URGENCY_KEYWORDS.MEDIUM.some(w => textLower.includes(w))) return '🟡 MEDIUM';
    return '🟢 LOW';
}

function isRealClient(text) {
    const textLower = text.toLowerCase();
    for (const word of STOP_WORDS) {
        if (textLower.includes(word)) {
            return { isClient: false, reason: `стоп-слово: "${word}"` };
        }
    }
    let score = 0;
    PRIMARY_KEYWORDS.forEach(w => { if (textLower.includes(w)) score += 3; });
    SECONDARY_KEYWORDS.forEach(w => { if (textLower.includes(w)) score += 2; });
    CLIENT_MARKERS.forEach(w => { if (textLower.includes(w)) score += 2; });
    if (score >= 5) return { isClient: true, reason: `уверенный (${score})` };
    if (score >= 3) return { isClient: true, reason: `возможный (${score})` };
    return { isClient: false, reason: `мало баллов (${score})` };
}

function formatLead(chatName, chatLink, senderName, senderUsername, text, contacts, city, urgency, reason, msgLink) {
    return `${urgency} НОВЫЙ ЛИД\n\n📌 Чат: ${chatName}\n🔗 ${chatLink}\n👤 Отправитель: ${senderName}\n📝 ${senderUsername}\n📍 Город: ${city}\n📞 Контакты: ${contacts}\n\n💬 Сообщение:\n${text.substring(0, 500)}${text.length > 500 ? '...' : ''}\n\n🔗 Ссылка: ${msgLink}\n📊 ${reason}\n⏰ ${new Date().toLocaleString('ru-RU')}`;
}

async function sendToMonitorChat(client, message, parseMode = null) {
    try {
        if (MONITOR_CHAT_ID) {
            await client.sendMessage(MONITOR_CHAT_ID, { message: message, parseMode: parseMode });
        } else {
            // Если ID не указан, отправляем в "Избранное"
            await client.sendMessage('me', { message: message });
        }
        return true;
    } catch (error) {
        console.error('Ошибка отправки в мониторинг-чат:', error.message);
        // Пробуем отправить в Избранное как fallback
        try {
            await client.sendMessage('me', { message: message });
        } catch(e) {}
        return false;
    }
}

async function sendStatus(client) {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    const statusMessage = `🤖 СТАТУС БОТА

🟢 Статус: ${isBotRunning ? 'РАБОТАЕТ' : 'ОСТАНОВЛЕН'}
⏱ Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м ${uptime%60}с
📊 Статистика:
   • 🎯 Лидов: ${totalLeads}
   • 👀 Проверено: ${totalProcessed}
   • ⏭️ Пропущено: ${totalSkipped}
   • 📈 Конверсия: ${totalProcessed > 0 ? ((totalLeads/totalProcessed)*100).toFixed(1) : 0}%
⏰ Последняя активность: ${new Date(lastActivityTime).toLocaleString('ru-RU')}
💾 Память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB

🔄 Активные команды:
   /status - этот отчет
   /stats - детальная статистика
   /last - последние 10 обработанных сообщений
   /reset - сбросить счетчики
   /ping - проверка связи`;
    
    await sendToMonitorChat(client, statusMessage);
}

async function showLastMessages(client) {
    if (recentMessages.length === 0) {
        await sendToMonitorChat(client, "📭 Нет недавних обработанных сообщений");
        return;
    }
    
    let message = "📜 ПОСЛЕДНИЕ 10 ОБРАБОТАННЫХ СООБЩЕНИЙ:\n\n";
    recentMessages.slice(-10).forEach((msg, index) => {
        message += `${index+1}. ${msg.time}\n`;
        message += `   📌 Чат: ${msg.chat}\n`;
        message += `   📊 Результат: ${msg.result}\n`;
        if (msg.reason) message += `   💡 ${msg.reason}\n`;
        message += `   📝 Сообщение: ${msg.preview}\n\n`;
    });
    
    await sendToMonitorChat(client, message);
}

async function showDetailedStats(client) {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    const statsMessage = `📊 ДЕТАЛЬНАЯ СТАТИСТИКА

📈 Общие показатели:
   • Лидов найдено: ${totalLeads}
   • Проверено сообщений: ${totalProcessed}
   • Пропущено: ${totalSkipped}
   • Конверсия: ${totalProcessed > 0 ? ((totalLeads/totalProcessed)*100).toFixed(1) : 0}%
   • Уникальных сообщений в кэше: ${processedMessages.size}

⏱ Временные показатели:
   • Старт бота: ${new Date(botStartTime).toLocaleString('ru-RU')}
   • Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м ${uptime%60}с
   • Последняя активность: ${new Date(lastActivityTime).toLocaleString('ru-RU')}
   • Задержка: ${Date.now() - lastActivityTime}ms назад

💻 Система:
   • Платформа: ${process.platform}
   • Node.js: ${process.version}
   • Память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB
   • Процессор: ${require('os').cpus()[0].model}

🔧 Настройки:
   • ID приложения: ${API_ID ? '✅' : '❌'}
   • Сессия: ${SESSION_STRING ? '✅' : '❌'}
   • Мониторинг чат: ${MONITOR_CHAT_ID ? '✅' : '❌ (Избранное)'}
   • Игнорируемые чаты: ${IGNORE_CHATS.length}`;
    
    await sendToMonitorChat(client, statsMessage);
}

async function startBot() {
    console.log('🚀 Запуск бота на VDSina...');
    console.log('📱 Мониторинг будет отправляться в чат ID:', MONITOR_CHAT_ID || 'Избранное');
    
    if (!SESSION_STRING || SESSION_STRING.length < 10) {
        console.error('❌ SESSION_STRING не найдена!');
        return;
    }
    
    botClient = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay: 3000,
        useWSS: false,
        autoReconnect: true,
        baseLogger: console
    });
    
    try {
        await botClient.start({
            phone: () => Promise.resolve(''),
            phoneCode: () => Promise.resolve(''),
            password: () => Promise.resolve(''),
            onError: (err) => console.log(err)
        });
        
        const me = await botClient.getMe();
        console.log(`✅ Авторизован: ${me.firstName} ${me.lastName || ''} (@${me.username || 'нет'})`);
        console.log('✅ БОТ ЗАПУЩЕН И РАБОТАЕТ 24/7');
        
        // Отправляем приветственное сообщение в мониторинг-чат
        await sendToMonitorChat(botClient, `🤖 БОТ ЗАПУЩЕН\n⏰ ${new Date().toLocaleString('ru-RU')}\n👤 Аккаунт: ${me.firstName}\n🆔 ID: ${me.id}`);
        
        // Периодическая отправка статуса (каждые 30 минут)
        setInterval(async () => {
            if (isBotRunning) {
                const uptime = Math.floor((Date.now() - botStartTime) / 60000);
                if (uptime % 60 === 0 && uptime > 0) { // Каждый час
                    await sendStatus(botClient);
                }
                // Проверка активности
                if (Date.now() - lastActivityTime > 300000) { // 5 минут без активности
                    await sendToMonitorChat(botClient, "⚠️ ВНИМАНИЕ: Нет активности более 5 минут! Бот может не получать сообщения.");
                }
            }
        }, 60000); // Каждую минуту проверяем
        
        botClient.addEventHandler(async (event) => {
            try {
                const message = event.message;
                if (message.out) return;
                
                const text = message.message || '';
                if (!text || text.length < 15) return;
                if (text.startsWith('/')) return;
                
                const msgHash = `${message.chatId}_${message.id}`;
                if (processedMessages.has(msgHash)) return;
                processedMessages.add(msgHash);
                if (processedMessages.size > 10000) processedMessages.clear();
                
                totalProcessed++;
                lastActivityTime = Date.now();
                
                const lowerText = text.toLowerCase();
                const hasPrimary = PRIMARY_KEYWORDS.some(w => lowerText.includes(w));
                const hasSecondary = SECONDARY_KEYWORDS.some(w => lowerText.includes(w));
                
                // Сохраняем информацию о сообщении для отчета
                let chatInfo = "Неизвестный чат";
                try {
                    const chat = await message.getChat();
                    chatInfo = chat.title || "Личный чат";
                } catch(e) {}
                
                if (!hasPrimary && !hasSecondary) {
                    recentMessages.push({
                        time: new Date().toLocaleString('ru-RU'),
                        chat: chatInfo,
                        result: '❌ ПРОПУЩЕНО',
                        preview: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                        reason: 'нет ключевых слов'
                    });
                    if (recentMessages.length > MAX_RECENT) recentMessages.shift();
                    return;
                }
                
                const { isClient, reason } = isRealClient(text);
                if (!isClient) {
                    totalSkipped++;
                    recentMessages.push({
                        time: new Date().toLocaleString('ru-RU'),
                        chat: chatInfo,
                        result: '⏭️ ПРОПУЩЕНО',
                        preview: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                        reason: reason
                    });
                    if (recentMessages.length > MAX_RECENT) recentMessages.shift();
                    return;
                }
                
                totalLeads++;
                
                recentMessages.push({
                    time: new Date().toLocaleString('ru-RU'),
                    chat: chatInfo,
                    result: '🎯 ЛИД!',
                    preview: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                    reason: reason
                });
                if (recentMessages.length > MAX_RECENT) recentMessages.shift();
                
                let chatName = 'Неизвестный чат';
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
                        msgLink = `https://t.me/c/${chat.id.toString().replace('-100', '')}/${message.id}`;
                    }
                } catch(e) {}
                
                try {
                    const sender = await message.getSender();
                    senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Неизвестный';
                    senderUsername = sender.username ? `@${sender.username}` : 'нет';
                } catch(e) {}
                
                const contacts = extractContacts(text);
                const city = detectCity(text);
                const urgency = detectUrgency(text);
                
                const leadMessage = formatLead(chatName, chatLink, senderName, senderUsername, text, contacts, city, urgency, reason, msgLink);
                
                // Отправляем лид в мониторинг-чат
                await sendToMonitorChat(botClient, leadMessage);
                console.log(`🎯 ЛИД! Всего: ${totalLeads} | ${chatName} | ${urgency}`);
                
                // Логируем в файл
                logToFile('lead', { chat: chatName, text: text.substring(0, 200), contacts, city });
                
            } catch(err) {
                console.error('Ошибка обработки:', err.message);
                logToFile('error', err.message);
            }
        }, new NewMessage({}));
        
        botClient.addEventHandler(async (event) => {
            const msg = event.message;
            const text = msg.message || '';
            
            if (text === '/status') {
                await sendStatus(botClient);
            }
            if (text === '/stats') {
                await showDetailedStats(botClient);
            }
            if (text === '/last') {
                await showLastMessages(botClient);
            }
            if (text === '/ping') {
                const startTime = Date.now();
                await sendToMonitorChat(botClient, '🏓 Понг!');
                const endTime = Date.now();
                await sendToMonitorChat(botClient, `⏱ Время ответа: ${endTime - startTime}ms`);
            }
            if (text === '/reset') {
                totalProcessed = 0;
                totalLeads = 0;
                totalSkipped = 0;
                processedMessages.clear();
                await sendToMonitorChat(botClient, '✅ Статистика сброшена!');
                console.log('📊 Статистика сброшена');
            }
            if (text === '/help') {
                const helpMessage = `🤖 Доступные команды:
/status - статус бота и общая статистика
/stats - детальная статистика
/last - последние 10 обработанных сообщений
/reset - сбросить счетчики
/ping - проверка связи
/help - эта справка`;
                await sendToMonitorChat(botClient, helpMessage);
            }
        }, new NewMessage({ fromUsers: ['me'] }));
        
        // Обработка отключения
        botClient.addEventHandler(async () => {
            console.log('⚠️ Бот отключен');
            isBotRunning = false;
            await sendToMonitorChat(botClient, '⚠️ БОТ ОТКЛЮЧЕН! Попытка переподключения...');
        });
        
    } catch(err) {
        console.error('❌ Ошибка подключения:', err.message);
        logToFile('fatal', err.message);
        isBotRunning = false;
        setTimeout(startBot, 10000);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Получен сигнал остановки...');
    if (botClient) {
        await sendToMonitorChat(botClient, '🛑 Бот останавливается...');
        await botClient.disconnect();
    }
    process.exit(0);
});

startBot();
