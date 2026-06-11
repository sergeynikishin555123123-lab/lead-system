require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || '';

// КЛЮЧЕВЫЕ СЛОВА
const PRIMARY_KEYWORDS = ['электрик', 'электромонтаж', 'проводка', 'щит', 'розетка', 'освещение', 'кабель', 'штроба', 'нужен электрик'];
const SECONDARY_KEYWORDS = ['коротнул', 'искрит', 'выбивает', 'нет света', 'подключить'];
const STOP_WORDS = ['вакансия', 'ищу работу', 'резюме', 'продам', 'куплю', 'кот', 'собака'];
const CITIES = ['москва', 'зеленоград', 'химки', 'лобня', 'солнечногорск'];

// КУДА ОТПРАВЛЯТЬ ЛИДЫ (ВАША ГРУППА)
const MONITOR_CHAT_ID = -5196059875;

let totalProcessed = 0, totalLeads = 0, totalSkipped = 0;
const processedMessages = new Set();
const botStartTime = Date.now();

function extractContacts(text) {
    const phones = text.match(/\+7[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g);
    const usernames = text.match(/@[\w_]+/g);
    return [...new Set([...(phones || []), ...(usernames || [])])].join(', ') || 'нет';
}

function detectCity(text) {
    const lower = text.toLowerCase();
    for (const city of CITIES) {
        if (lower.includes(city)) return city.charAt(0).toUpperCase() + city.slice(1);
    }
    return 'не указан';
}

function isRealClient(text) {
    const lower = text.toLowerCase();
    if (STOP_WORDS.some(w => lower.includes(w))) return false;
    let score = 0;
    PRIMARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 3; });
    SECONDARY_KEYWORDS.forEach(w => { if (lower.includes(w)) score += 2; });
    return score >= 3;
}

async function startBot() {
    console.log('🚀 Запуск бота...');
    
    const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
        connectionRetries: 5,
        retryDelay: 3000,
        autoReconnect: true
    });
    
    try {
        await client.start({
            phone: () => Promise.resolve(''),
            phoneCode: () => Promise.resolve(''),
            password: () => Promise.resolve(''),
            onError: (err) => console.log(err)
        });
        
        const me = await client.getMe();
        console.log(`✅ Авторизован: ${me.firstName}`);
        console.log(`✅ Бот запущен, отправляем в группу ${MONITOR_CHAT_ID}`);
        
        await client.sendMessage(MONITOR_CHAT_ID, { message: `🤖 Бот запущен\n⏰ ${new Date().toLocaleString('ru-RU')}` });
        
        client.addEventHandler(async (event) => {
            try {
                const message = event.message;
                if (message.out) return;
                
                const text = message.message || '';
                if (text.length < 15 || text.startsWith('/')) return;
                
                const msgHash = `${message.chatId}_${message.id}`;
                if (processedMessages.has(msgHash)) return;
                processedMessages.add(msgHash);
                if (processedMessages.size > 5000) processedMessages.clear();
                
                totalProcessed++;
                
                const hasKeyword = PRIMARY_KEYWORDS.some(w => text.toLowerCase().includes(w)) || 
                                 SECONDARY_KEYWORDS.some(w => text.toLowerCase().includes(w));
                if (!hasKeyword) return;
                
                if (!isRealClient(text)) {
                    totalSkipped++;
                    return;
                }
                
                totalLeads++;
                
                let chatName = 'Неизвестный чат', senderName = 'Неизвестный', msgLink = '';
                try {
                    const chat = await message.getChat();
                    chatName = chat.title || 'Личный чат';
                    if (chat.username) msgLink = `https://t.me/${chat.username}/${message.id}`;
                    else if (String(chat.id).startsWith('-100')) msgLink = `https://t.me/c/${String(chat.id).replace('-100', '')}/${message.id}`;
                } catch(e) {}
                
                try {
                    const sender = await message.getSender();
                    senderName = sender.firstName || 'Пользователь';
                } catch(e) {}
                
                const contacts = extractContacts(text);
                const city = detectCity(text);
                const urgency = text.toLowerCase().includes('срочно') ? '🔴 СРОЧНО' : '🟢 Обычный';
                
                const leadMessage = `🎯 НОВЫЙ ЛИД!\n\n📌 Чат: ${chatName}\n👤 Отправитель: ${senderName}\n📍 Город: ${city}\n📞 Контакты: ${contacts}\n⚡️ ${urgency}\n\n💬 Сообщение:\n${text.substring(0, 400)}\n\n${msgLink}\n⏰ ${new Date().toLocaleString('ru-RU')}`;
                
                await client.sendMessage(MONITOR_CHAT_ID, { message: leadMessage });
                console.log(`🎯 ЛИД! Всего: ${totalLeads} | ${chatName}`);
                
            } catch(err) {
                console.error('Ошибка:', err.message);
            }
        }, new NewMessage({}));
        
        // ТОЛЬКО КОМАНДА /status
        client.addEventHandler(async (event) => {
            const msg = event.message;
            if (msg.message === '/status') {
                const uptime = Math.floor((Date.now() - botStartTime) / 1000);
                const statusMsg = `📊 СТАТУС БОТА\n\n🕐 Аптайм: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м\n🎯 Лидов: ${totalLeads}\n👀 Проверено: ${totalProcessed}\n⏭️ Пропущено: ${totalSkipped}\n📈 Конверсия: ${totalProcessed > 0 ? ((totalLeads/totalProcessed)*100).toFixed(1) : 0}%\n\n✅ Бот работает`;
                await client.sendMessage(msg.chatId, { message: statusMsg });
            }
        }, new NewMessage({ fromUsers: ['me'] }));
        
    } catch(err) {
        console.error('❌ Ошибка:', err.message);
        setTimeout(startBot, 10000);
    }
}

startBot();
