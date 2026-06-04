require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
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
    console.log('✅ Логи будут писаться в /tmp/lead-logs');
} catch (error) {
    console.warn('⚠️ Не могу создать папку для логов, пишу только в консоль');
}

function log(type, message, data = null) {
    const now = new Date();
    const time = now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    const logMessage = `[${time}] [${type}] ${message}`;
    console.log(logMessage);
    
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
    console.log('-'.repeat(80));
    
    try {
        if (fs.existsSync(LOGS_DIR)) {
            let fileMessage = `[${time}] [${type}] ${message}`;
            if (data) {
                fileMessage += '\n' + JSON.stringify(data, null, 2);
            }
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
// ВЕБ-СЕРВЕР
// ==========================================

let server = null;

function killProcessOnPort(port) {
    return new Promise((resolve) => {
        console.log(`🔍 Проверяю порт ${port}...`);
        const command = `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`;
        exec(command, (error, stdout, stderr) => {
            if (stdout && stdout.trim()) {
                console.log(`✅ Убит процесс на порту ${port}`);
            }
            setTimeout(resolve, 1000);
        });
    });
}

async function startServer() {
    await killProcessOnPort(PORT);
    
    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
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
                memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                port: PORT,
                pid: process.pid
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(healthData, null, 2));
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`⚠️ Порт ${PORT} занят, убиваем процесс...`);
                killProcessOnPort(PORT).then(() => {
                    server.listen(PORT, '0.0.0.0');
                });
            } else {
                reject(err);
            }
        });

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Веб-сервер запущен на порту ${PORT} (PID: ${process.pid})`);
            log('SUCCESS', `Веб-сервер на порту ${PORT}`);
            resolve(server);
        });
    });
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
// ЗАПУСК БОТА - МАКСИМАЛЬНЫЙ ОБХОД БЛОКИРОВОК
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
    
    // ==========================================
    // КРИТИЧЕСКИЕ НАСТРОЙКИ ДЛЯ ОБХОДА БЛОКИРОВОК
    // ==========================================
    const clientConfig = {
        // Основные настройки
        connectionRetries: 15,              // Больше попыток
        retryDelay: 3000,                   // Задержка между попытками
        requestRetries: 10,                 // Ретри на запросы
        
        // Обход блокировок
        useWSS: true,                       // WebSocket Secure (важно!)
        useIPv6: false,                     // Отключаем IPv6 (часто блокируют)
        
        // Таймауты
        receiveRetryDelay: 5000,            // Задержка получения
        floodSleepThreshold: 60,            // Порог флуда
        
        // Эмуляция реального клиента
        deviceModel: 'iPhone 15 Pro',       // Маскировка под iPhone
        systemVersion: 'iOS 18.0',          // iOS система
        appVersion: '11.0.0',               // Версия приложения
        langCode: 'ru',                     // Русский язык
        
        // Автоматическое восстановление
        autoReconnect: true,                // Автопереподключение
        maxConcurrentDownloads: 1,          // Ограничение загрузок
        
        // Логирование для отладки
        baseLogger: console,
        
        // Альтернативные порты (пробует разные)
        connectionRetriesConfig: {
            maxAttempts: 10,
            retryInterval: 5000,
            statusCodeHandlers: {
                429: () => 30000,            // Если флуд - ждем 30 сек
                500: () => 10000,            // Ошибка сервера - ждем 10 сек
                default: () => 5000
            }
        }
    };
    
    console.log('📡 Настройки подключения:');
    console.log(`   • WebSocket Secure: ${clientConfig.useWSS ? '✅ ДА' : '❌ НЕТ'}`);
    console.log(`   • Устройство: ${clientConfig.deviceModel}`);
    console.log(`   • Ретриев: ${clientConfig.connectionRetries}`);
    console.log(`   • Авто-переподключение: ${clientConfig.autoReconnect ? '✅ ДА' : '❌ НЕТ'}`);
    
    const client = new TelegramClient(stringSession, API_ID, API_HASH, clientConfig);
    
    // ==========================================
    // ОБРАБОТКА РАЗРЫВОВ СВЯЗИ
    // ==========================================
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 20;
    
    client.addEventHandler((error) => {
        console.error(`❌ Ошибка соединения: ${error.message}`);
        log('ERROR', `Ошибка соединения: ${error.message}`);
    });
    
    // Функция переподключения
    async function reconnect() {
        reconnectAttempts++;
        console.log(`🔄 Попытка переподключения ${reconnectAttempts}/${maxReconnectAttempts}...`);
        
        if (reconnectAttempts >= maxReconnectAttempts) {
            console.error('❌ Достигнут лимит переподключений, перезапуск процесса...');
            process.exit(1);
        }
        
        const delay = Math.min(30000, reconnectAttempts * 2000);
        console.log(`⏳ Следующая попытка через ${delay/1000} секунд...`);
        
        setTimeout(() => {
            if (!client.connected) {
                startBot().catch(console.error);
            }
        }, delay);
    }
    
    try {
        console.log('🔌 Подключение к Telegram...');
        log('CONNECT', 'Подключение к Telegram...');
        
        // Устанавливаем таймаут подключения
        const connectTimeout = setTimeout(() => {
            console.error('❌ Таймаут подключения (>30 секунд)');
            reconnect();
        }, 30000);
        
        await client.connect();
        clearTimeout(connectTimeout);
        
        console.log('✅ Подключено!');
        log('SUCCESS', 'Подключено к Telegram');
        
        // Сбрасываем счетчик попыток при успешном подключении
        reconnectAttempts = 0;
        
        const me = await client.getMe();
        const userName = `${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'нет'})`;
        console.log(`👤 Авторизован: ${userName}`);
        console.log(`🆔 ID: ${me.id}`);
        console.log(`📱 Устройство: ${me.isBot ? 'Бот' : 'Пользователь'}`);
        log('SUCCESS', `Авторизован: ${userName}`);
        
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
                stats += `👀 Проверено: ${totalProcessed}\n`;
                stats += `⏭️ Пропущено: ${totalSkipped}\n`;
                stats += `🔄 Подключение: ${client.connected ? '✅' : '❌'}\n\n`;
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
                const uptime = Math.floor((new Date() - botStartTime) / 1000);
                await message.reply({ 
                    message: `🏓 Понг!\n⏱ Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м\n🔄 Соединение: ${client.connected ? '✅ активно' : '❌ разорвано'}`
                });
            }
            
            if (text === '/reset') {
                totalProcessed = 0;
                totalSkipped = 0;
                totalLeads = 0;
                leadsHistory.length = 0;
                Object.keys(chatStats).forEach(key => delete chatStats[key]);
                await message.reply({ message: '✅ Статистика сброшена!' });
            }
            
            if (text === '/reconnect') {
                await message.reply({ message: '🔄 Принудительное переподключение...' });
                await client.disconnect();
                setTimeout(() => startBot(), 3000);
            }
            
        }, new NewMessage({ fromUsers: ['me'] }));
        
        // ==========================================
        // ХРАНИЛИЩЕ ДЛЯ ОТСЛЕЖИВАНИЯ ЖИЗНИ
        // ==========================================
        let lastPing = Date.now();
        
        // Пинг каждые 30 секунд чтобы держать соединение живым
        const keepAlive = setInterval(() => {
            if (client.connected) {
                lastPing = Date.now();
                // Не отправляем реальный пинг, чтобы не спамить
            } else {
                console.log('⚠️ Соединение потеряно, попытка восстановления...');
                reconnect();
            }
        }, 30000);
        
        console.log('✅ ГОТОВ К РАБОТЕ');
        console.log('📡 Keep-Alive включен (каждые 30 сек)');
        log('SUCCESS', 'Бот готов к работе');
        
        // Отслеживание разрыва соединения
        client.addEventHandler((disconnect) => {
            console.error('❌ Соединение разорвано!');
            log('ERROR', 'Соединение разорвано');
            clearInterval(keepAlive);
            reconnect();
        });
        
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
    console.log(`🆔 PID: ${process.pid}`);
    console.log(`🕐 Время запуска: ${new Date().toLocaleString('ru-RU')}`);
    
    // Запускаем веб-сервер
    try {
        await startServer();
    } catch (err) {
        console.error('❌ Ошибка сервера:', err.message);
    }
    
    // Запускаем бота
    startBot().catch(err => {
        console.error('Критическая ошибка:', err.message);
    });
})();

// Поддержание процесса
process.on('SIGTERM', () => {
    console.log('📡 SIGTERM');
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📡 SIGINT');
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
});

// Каждые 5 минут статус
setInterval(() => {
    const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`💚 Жив. Лидов: ${totalLeads}, Проверено: ${totalProcessed}, RAM: ${memUsage}MB`);
}, 300000);
