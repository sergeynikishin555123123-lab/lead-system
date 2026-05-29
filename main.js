require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
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
// ЛОГИРОВАНИЕ
// ==========================================
const LOGS_DIR = path.join(__dirname, 'logs');

// Создаём папку для логов
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOGS_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);

function log(type, message, data = null) {
    const now = new Date();
    const time = now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    const icons = {
        INFO: '📘',
        LEAD: '🎯',
        SKIP: '⏭️',
        ERROR: '❌',
        SUCCESS: '✅',
        STATS: '📊',
        START: '🚀',
        STOP: '🛑',
        CONNECT: '🔌',
        CHAT: '💬'
    };
    
    const icon = icons[type] || '📝';
    const logMessage = `[${time}] ${icon} [${type}] ${message}`;
    
    // В консоль
    console.log(logMessage);
    
    // В файл
    let fileMessage = `[${time}] [${type}] ${message}`;
    if (data) {
        fileMessage += '\n' + JSON.stringify(data, null, 2);
    }
    fileMessage += '\n' + '-'.repeat(80) + '\n';
    
    fs.appendFileSync(LOG_FILE, fileMessage);
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
// ЗАПУСК
// ==========================================

async function main() {
    log('START', 'Запуск юзербота LeadSystem...');
    log('INFO', `Версия gramJS запущена`);
    
    // Проверяем сессию
    if (!SESSION_STRING || SESSION_STRING.length < 10) {
        log('ERROR', 'SESSION_STRING не найдена в переменных окружения!');
        log('ERROR', 'Добавь SESSION_STRING в настройках приложения');
        process.exit(1);
    }
    
    const stringSession = new StringSession(SESSION_STRING);
    log('INFO', 'Сессия загружена из переменной окружения');
    
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
    });
    
    log('CONNECT', 'Подключение к серверам Telegram...');
    
    try {
        await client.connect();
        log('SUCCESS', 'Подключение установлено успешно');
    } catch (err) {
        log('ERROR', `Ошибка подключения: ${err.message}`);
        process.exit(1);
    }
    
    // Проверяем авторизацию
    const me = await client.getMe();
    log('SUCCESS', `Авторизован как: ${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'нет'})`);
    log('SUCCESS', `ID пользователя: ${me.id}`);
    
    log('START', '========================================');
    log('START', '✅ ЮЗЕРБОТ ЗАПУЩЕН И МОНИТОРИТ ЧАТЫ');
    log('START', '========================================');
    log('INFO', 'Лиды приходят в Избранное (Saved Messages)');
    log('INFO', 'Команды в Избранном: /stats, /last, /today');
    log('INFO', `Логи сохраняются в: ${LOG_FILE}`);
    
    // ==========================================
    // ОБРАБОТЧИК СООБЩЕНИЙ
    // ==========================================
    
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            
            // Пропускаем свои сообщения
            if (message.out) {
                return;
            }
            
            totalProcessed++;
            
            // Текст сообщения
            const text = message.message || '';
            
            if (!text || text.length < 15) {
                return;
            }
            
            // Защита от повторов
            const chatId = message.chatId?.toString() || '';
            const msgHash = text.substring(0, 100) + chatId;
            
            if (processedMessages.has(msgHash)) {
                return;
            }
            processedMessages.add(msgHash);
            
            if (processedMessages.size > 10000) {
                log('INFO', 'Очистка кеша обработанных сообщений (10000+)');
                processedMessages.clear();
            }
            
            // Проверка ключевых слов
            const textLower = text.toLowerCase();
            
            const foundPrimary = PRIMARY_KEYWORDS.filter(word => textLower.includes(word));
            const foundSecondary = SECONDARY_KEYWORDS.filter(word => textLower.includes(word));
            
            const hasPrimary = foundPrimary.length > 0;
            const hasSecondary = foundSecondary.length > 0;
            
            if (!hasPrimary && !hasSecondary) {
                return;
            }
            
            // Получаем информацию о чате ДО проверки на клиента
            let chatName = 'Неизвестный чат';
            
            try {
                const chat = await message.getChat();
                chatName = chat.title || `${chat.firstName || ''} ${chat.lastName || ''}`.trim() || 'Личный чат';
            } catch (e) {
                chatName = 'Неизвестный чат';
            }
            
            // Логируем совпадение ключевых слов
            const matchedWords = [...foundPrimary, ...foundSecondary].join(', ');
            log('CHAT', `Найдены ключевые слова в чате "${chatName}": ${matchedWords}`);
            
            // Проверка на клиента
            const { isClient, reason, score } = isRealClient(text);
            
            if (!isClient) {
                totalSkipped++;
                log('SKIP', `Пропущено (${chatName}): ${reason}`, {
                    chat: chatName,
                    score: score,
                    text: text.substring(0, 100),
                    matchedWords: matchedWords
                });
                return;
            }
            
            totalLeads++;
            
            // Получаем детальную информацию
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
            } catch (e) {
                log('ERROR', `Ошибка получения чата: ${e.message}`);
            }
            
            try {
                const sender = await message.getSender();
                senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Неизвестный';
                senderUsername = sender.username ? `@${sender.username}` : 'нет';
            } catch (e) {
                log('ERROR', `Ошибка получения отправителя: ${e.message}`);
            }
            
            const contacts = extractContacts(text);
            const city = detectCity(text);
            const urgency = detectUrgency(text);
            
            // Формируем лид
            const leadMessage = formatLead(
                chatName, chatLink, senderName, senderUsername,
                text, contacts, city, urgency, reason, msgLink
            );
            
            // Отправляем в Избранное
            try {
                await client.sendMessage('me', { message: leadMessage });
                log('LEAD', `✅ ЛИД ОТПРАВЛЕН!`, {
                    chat: chatName,
                    sender: senderName,
                    urgency: urgency,
                    city: city,
                    contacts: contacts,
                    score: score,
                    matchedWords: matchedWords,
                    messageLink: msgLink
                });
            } catch (e) {
                log('ERROR', `Ошибка отправки лида: ${e.message}`);
            }
            
            // Сохраняем статистику
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
            log('ERROR', `Критическая ошибка обработки: ${error.message}`);
            log('ERROR', error.stack);
        }
    }, new NewMessage({}));
    
    // ==========================================
    // КОМАНДЫ
    // ==========================================
    
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.message || '';
        
        // /stats
        if (text === '/stats') {
            const total = leadsHistory.length;
            const today = leadsHistory.filter(l => {
                const leadDate = new Date(l.date);
                const now = new Date();
                return leadDate.toDateString() === now.toDateString();
            }).length;
            const high = leadsHistory.filter(l => l.urgency.includes('HIGH')).length;
            const medium = leadsHistory.filter(l => l.urgency.includes('MEDIUM')).length;
            const low = leadsHistory.filter(l => l.urgency.includes('LOW')).length;
            
            let stats = `📊 СТАТИСТИКА\n\n`;
            stats += `🔴 Срочных: ${high}\n`;
            stats += `🟡 Средних: ${medium}\n`;
            stats += `🟢 Низких: ${low}\n`;
            stats += `📝 Всего лидов: ${total}\n`;
            stats += `📅 Сегодня: ${today}\n`;
            stats += `👀 Проверено сообщений: ${totalProcessed}\n`;
            stats += `⏭️ Пропущено: ${totalSkipped}\n\n`;
            stats += `📈 ТОП-10 ЧАТОВ:\n`;
            
            const sortedChats = Object.entries(chatStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);
            
            if (sortedChats.length === 0) {
                stats += `(пока пусто)\n`;
            } else {
                sortedChats.forEach(([chat, count]) => {
                    stats += `• ${chat}: ${count} лидов\n`;
                });
            }
            
            await message.reply({ message: stats });
            log('STATS', `Запрошена статистика`);
        }
        
        // /last
        if (text === '/last') {
            if (leadsHistory.length === 0) {
                await message.reply({ message: '📭 Лидов пока нет' });
                return;
            }
            
            const recent = leadsHistory.slice(-10).reverse();
            let result = `📋 ПОСЛЕДНИЕ 10 ЛИДОВ:\n\n`;
            
            recent.forEach((l, i) => {
                const time = new Date(l.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                result += `${i + 1}. 🕐 ${time} | ${l.urgency} | ${l.chat}\n`;
                result += `   👤 ${l.sender}: ${l.text}\n`;
                if (l.contacts && l.contacts !== 'нет') {
                    result += `   📞 ${l.contacts}\n`;
                }
                result += `\n`;
            });
            
            await message.reply({ message: result });
            log('INFO', 'Отправлен список последних 10 лидов');
        }
        
        // /today
        if (text === '/today') {
            const today = leadsHistory.filter(l => {
                const leadDate = new Date(l.date);
                const now = new Date();
                return leadDate.toDateString() === now.toDateString();
            });
            
            if (today.length === 0) {
                await message.reply({ message: '📭 Сегодня лидов нет' });
                return;
            }
            
            let result = `📅 ЛИДЫ ЗА СЕГОДНЯ (${today.length}):\n\n`;
            
            today.reverse().forEach((l, i) => {
                const time = new Date(l.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                result += `${i + 1}. 🕐 ${time} | ${l.urgency} | ${l.chat}\n`;
                result += `   👤 ${l.sender}\n`;
                if (l.city && l.city !== 'не указан') {
                    result += `   📍 ${l.city}\n`;
                }
                if (l.contacts && l.contacts !== 'нет') {
                    result += `   📞 ${l.contacts}\n`;
                }
                result += `\n`;
            });
            
            await message.reply({ message: result });
            log('INFO', `Отправлены лиды за сегодня (${today.length})`);
        }
        
    }, new NewMessage({ fromUsers: ['me'] }));
    
    log('SUCCESS', 'Обработчики событий добавлены');
    log('SUCCESS', '========================================');
    log('SUCCESS', '✅ БОТ ГОТОВ К РАБОТЕ');
    log('SUCCESS', '========================================');
}

// ==========================================
// ОБРАБОТКА ОШИБОК
// ==========================================

process.on('uncaughtException', (error) => {
    log('ERROR', `Необработанное исключение: ${error.message}`);
    log('ERROR', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    log('ERROR', `Необработанный reject: ${reason}`);
});

process.on('SIGINT', () => {
    log('STOP', 'Получен сигнал завершения (SIGINT)');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('STOP', 'Получен сигнал завершения (SIGTERM)');
    process.exit(0);
});

// ==========================================
// ЗАПУСК
// ==========================================

main().catch(err => {
    log('ERROR', `Критическая ошибка при запуске: ${err.message}`);
    log('ERROR', err.stack);
    process.exit(1);
});
