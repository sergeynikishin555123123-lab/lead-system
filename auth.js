require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PHONE = process.env.PHONE;

const SESSION_FILE = path.join(__dirname, 'session', 'user_session.txt');

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

async function auth() {
    console.log('🔐 Авторизация в Telegram...\n');
    
    const stringSession = new StringSession('');
    
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => PHONE,
        password: async () => await askQuestion('Пароль 2FA (если нет - Enter): '),
        phoneCode: async () => await askQuestion('Код из Telegram: '),
        onError: (err) => console.log('Ошибка:', err),
    });
    
    console.log('✅ Авторизация успешна!');
    
    // Сохраняем сессию
    const sessionString = client.session.save();
    
    const sessionDir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    fs.writeFileSync(SESSION_FILE, sessionString);
    console.log(`💾 Сессия сохранена в ${SESSION_FILE}`);
    console.log('\nТеперь можешь деплоить на Timeweb!');
    
    await client.disconnect();
    process.exit(0);
}

auth().catch(err => {
    console.error('Ошибка:', err);
    process.exit(1);
});
