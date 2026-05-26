require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
    PRIMARY_KEYWORDS,
    SECONDARY_KEYWORDS,
    STOP_WORDS,
    URGENCY_KEYWORDS,
    CITIES,
    CLIENT_MARKERS
} = require('./filters');

// ===== НАСТРОЙКИ =====
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PHONE = process.env.PHONE;

// ===== ХРАНЕНИЕ =====
const leadsHistory = [];
const chatStats = {};
const processedMessages = new Set();

// ===== СЕССИЯ =====
const SESSION_FILE = path.join(__dirname, 'session', 'user_session.txt');

// ===== ФУНКЦИИ =====

function extractContacts(text) {
    const contacts = [];
    
    // Телефон
    const phonePatterns = [
        /\+7[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
        /8[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
    ];
    
    phonePatterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) contacts.push(...matches);
    });
    
    // @username
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
    
    // Стоп-слова
    for (const word of STOP_WORDS) {
        if (textLower.includes(word)) {
            return { isClient: false, reason: `стоп-слово: ${word}` };
        }
    }
    
    // Признаки клиента
    let clientScore = 0;
    CLIENT_MARKERS.forEach(marker => {
        if (textLower.includes(marker)) clientScore++;
    });
    
    // Ключевые слова
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
        return { isClient: true, reason: `уверенный лид (баллы: ${total})` };
    } else if (total >= 3) {
        return { isClient: true, reason: `возможный лид (баллы: ${total})` };
    } else {
        return { isClient: false, reason: `мало признаков (баллы: ${total})` };
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

// ===== ЗАПРОС КОДА В КОНСОЛИ =====

function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

// ===== ЗАПУСК =====

async function startClient() {
    // Загружаем или создаём сессию
    let stringSession;
    
    if (fs.existsSync(SESSION_FILE)) {
        stringSession = new StringSession(fs.readFileSync(SESSION_FILE, 'utf8'));
        console.log('📂 Сессия загружена из файла');
    } else {
        stringSession = new StringSession('');
        console.log('🆕 Создана новая сессия');
    }
    
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
    });
    
    // Запуск с авторизацией
    await client.start({
        phoneNumber: async () => PHONE,
        password: async () => await askQuestion('Введите пароль 2FA (если нет - нажмите Enter): '),
        phoneCode: async () => await askQuestion('Введите код из Telegram: '),
        onError: (err) => console.log('Ошибка авторизации:', err),
    });
    
    // Сохраняем сессию
    const sessionString = client.session.save();
    const sessionDir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    fs.writeFileSync(SESSION_FILE, sessionString);
    console.log('💾 Сессия сохранена');
    
    console.log(`
✅ ЮЗЕРБОТ ЗАПУЩЕН!

Мониторинг всех чатов...
Лиды приходят в Избранное (Saved Messages)

Команды в Избранном:
/stats - статистика
/last - последние лиды
`);
    
    // ===== ОБРАБОТЧИК СООБЩЕНИЙ =====
    
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            
            // Только входящие
            if (message.out) return;
            
            // Текст сообщения
            const text = message.message || '';
            
            if (!text || text.length < 15) return;
            
            // Защита от повторов
            const chatId = message.chatId?.toString() || message.peerId?.toString() || '';
            const msgHash = text.substring(0, 100) + chatId;
            
            if (processedMessages.has(msgHash)) return;
            processedMessages.add(msgHash);
            
            if (processedMessages.size > 5000) {
                processedMessages.clear();
            }
            
            // Проверка ключевых слов
            const textLower = text.toLowerCase();
            
            const hasPrimary = PRIMARY_KEYWORDS.some(word => textLower.includes(word));
            const hasSecondary = SECONDARY_KEYWORDS.some(word => textLower.includes(word));
            
            if (!hasPrimary && !hasSecondary) return;
            
            // Проверка на клиента
            const { isClient, reason } = isRealClient(text);
            
            if (!isClient) {
                console.log(`Пропущено: ${reason}`);
                return;
            }
            
            // Получаем информацию о чате
            let chatName = 'Личный чат';
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
                    msgLink = `${chatLink}/${message.id}`;
                }
            } catch (e) {
                console.log('Ошибка получения чата:', e.message);
            }
            
            // Отправитель
            try {
                const sender = await message.getSender();
                senderName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Неизвестный';
                senderUsername = sender.username ? `@${sender.username}` : 'нет';
            } catch (e) {
                // Игнорируем
            }
            
            // Анализ
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
                console.log(`✅ Лид: ${chatName}`);
            } catch (e) {
                console.log(`❌ Ошибка: ${e.message}`);
            }
            
            // Сохраняем
            leadsHistory.push({
                date: new Date(),
                chat: chatName,
                sender: senderName,
                text: text.substring(0, 100),
                urgency: urgency,
                city: city
            });
            
            chatStats[chatName] = (chatStats[chatName] || 0) + 1;
            
        } catch (error) {
            console.error('Ошибка обработки:', error.message);
        }
    }, new NewMessage({}));
    
    // ===== КОМАНДЫ =====
    
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
            
            let stats = `📊 СТАТИСТИКА\n\nВсего: ${total}\nСегодня: ${today}\nСрочных: ${high}\n\n📈 ТОП ЧАТОВ:\n`;
            
            const sortedChats = Object.entries(chatStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);
            
            sortedChats.forEach(([chat, count]) => {
                stats += `• ${chat}: ${count}\n`;
            });
            
            await message.reply({ message: stats });
        }
        
        if (text === '/last') {
            if (leadsHistory.length === 0) {
                await message.reply({ message: '📭 Пусто' });
                return;
            }
            
            const recent = leadsHistory.slice(-10).reverse();
            let result = '📋 ПОСЛЕДНИЕ 10:\n\n';
            
            recent.forEach(l => {
                const time = new Date(l.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                result += `🕐 ${time} | ${l.urgency} | ${l.chat}\n   ${l.sender}: ${l.text}\n\n`;
            });
            
            await message.reply({ message: result });
        }
    }, new NewMessage({ fromUsers: ['me'] }));
    
    console.log('✅ Юзербот готов к работе');
}

// ===== MAIN =====

async function main() {
    console.log('🤖 Запуск юзербота LeadSystem...');
    
    try {
        await startClient();
    } catch (error) {
        console.error('❌ Критическая ошибка:', error.message);
        process.exit(1);
    }
}

main();
