require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const http = require('http');
const {
    PRIMARY_KEYWORDS,
    SECONDARY_KEYWORDS,
    STOP_WORDS,
    URGENCY_KEYWORDS,
    CITIES,
    CLIENT_MARKERS,
    MONITOR_CHAT_ID
} = require('./filters');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';
const PORT = process.env.PORT || 8080;

let totalProcessed = 0;
let totalLeads = 0;
let totalSkipped = 0;
const processedMessages = new Set();
const botStartTime = Date.now();

// Веб-сервер для мониторинга
const server = http.createServer((req, res) => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        uptime: `${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м`,
        totalLeads,
        totalProcessed,
        totalSkipped
    }));
});
server.listen(PORT, '0.0.0.0');

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

async function startBot() {
    console.log('🚀 Запуск бота на VDSina...');
    
    if (!SESSION_STRING || SESSION_STRING.length < 10) {
        console.error('❌ SESSION_STRING не найдена!');
        return;
    }
    
    const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay: 3000,
        useWSS: false,
        autoReconnect: true,
        baseLogger: console
    });
    
    try {
        await client.start({
            phone: () => Promise.resolve(''),
            phoneCode: () => Promise.resolve(''),
            password: () => Promise.resolve(''),
            onError: (err) => console.log(err)
        });
        
        const me = await client.getMe();
        console.log(`✅ Авторизован: ${me.firstName} ${me.lastName || ''} (@${me.username || 'нет'})`);
        console.log('✅ БОТ ЗАПУЩЕН И РАБОТАЕТ 24/7');
        
        // Отправляем приветствие в мониторинг чат или в избранное
        const targetChat = MONITOR_CHAT_ID || 'me';
        await client.sendMessage(targetChat, { message: `🤖 Бот запущен\n⏰ ${new Date().toLocaleString('ru-RU')}` });
        
        client.addEventHandler(async (event) => {
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
                
                const lowerText = text.toLowerCase();
                const hasPrimary = PRIMARY_KEYWORDS.some(w => lowerText.includes(w));
                const hasSecondary = SECONDARY_KEYWORDS.some(w => lowerText.includes(w));
                
                if (!hasPrimary && !hasSecondary) return;
                
                const { isClient, reason } = isRealClient(text);
                if (!isClient) {
                    totalSkipped++;
                    return;
                }
                
                totalLeads++;
                
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
                
                await client.sendMessage(targetChat, { message: leadMessage });
                console.log(`🎯 ЛИД! Всего: ${totalLeads} | ${chatName} | ${urgency}`);
                
            } catch(err) {
                console.error('Ошибка обработки:', err.message);
            }
        }, new NewMessage({}));
        
        // Обработка команд от вас (только status и stats)
        client.addEventHandler(async (event) => {
            const msg = event.message;
            const text = msg.message || '';
            
            if (text === '/status') {
                const uptime = Math.floor((Date.now() - botStartTime) / 1000);
                const statusMsg = `📊 СТАТУС БОТА\n\n⏱ Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м\n🎯 Лидов найдено: ${totalLeads}\n👀 Проверено сообщений: ${totalProcessed}\n⏭️ Пропущено: ${totalSkipped}\n📈 Конверсия: ${totalProcessed > 0 ? ((totalLeads/totalProcessed)*100).toFixed(1) : 0}%\n\n✅ Бот работает нормально`;
                await client.sendMessage(msg.chatId, { message: statusMsg });
                console.log('📊 Отправлен статус по команде');
            }
            
            if (text === '/stats') {
                const uptime = Math.floor((Date.now() - botStartTime) / 1000);
                const statsMsg = `📈 ДЕТАЛЬНАЯ СТАТИСТИКА\n\n📊 Всего обработано: ${totalProcessed}\n🎯 Найдено лидов: ${totalLeads}\n⏭️ Пропущено: ${totalSkipped}\n📈 Конверсия: ${totalProcessed > 0 ? ((totalLeads/totalProcessed)*100).toFixed(1) : 0}%\n⏱ Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м ${uptime%60}с\n🕐 Запущен: ${new Date(botStartTime).toLocaleString('ru-RU')}\n💾 Уникальных сообщений в кэше: ${processedMessages.size}`;
                await client.sendMessage(msg.chatId, { message: statsMsg });
                console.log('📊 Отправлена детальная статистика по команде');
            }
        }, new NewMessage({ fromUsers: ['me'] }));
        
    } catch(err) {
        console.error('❌ Ошибка подключения:', err.message);
        setTimeout(startBot, 10000);
    }
}

startBot();
