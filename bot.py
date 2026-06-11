#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import re
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from pyrogram import Client, filters
from pyrogram.types import Message

# Загружаем .env
load_dotenv()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
SESSION_STRING = os.getenv("SESSION_STRING")

# Ключевые слова
PRIMARY_KEYWORDS = [
    'электрик', 'электрика', 'электромонтаж', 'электромонтажник',
    'проводка', 'щит', 'электрощит', 'розетка', 'освещение', 'кабель',
    'штроба', 'нужен электрик', 'электрика под ключ'
]

SECONDARY_KEYWORDS = [
    'коротнул', 'искрит', 'выбивает', 'нет света',
    'подключить', 'новостройка', 'ремонт'
]

STOP_WORDS = [
    'вакансия', 'резюме', 'ищу работу', 'обучение',
    'продам', 'куплю', 'кот', 'собака', 'репетитор', 'маникюр'
]

CITIES = ['москва', 'зеленоград', 'химки', 'лобня', 'солнечногорск']

URGENCY_HIGH = ['срочно', 'сейчас', 'авария', 'горит', 'искрит']
URGENCY_MEDIUM = ['завтра', 'скоро', 'на неделе']

# Статистика
processed_messages = set()
total_leads = 0
total_processed = 0
total_skipped = 0

def extract_contacts(text):
    phones = re.findall(r'\+7[\d\s()-]{10,}', text)
    usernames = re.findall(r'@[\w_]+', text)
    contacts = list(set(phones + usernames))
    return ', '.join(contacts) if contacts else 'нет'

def detect_city(text):
    text_lower = text.lower()
    for city in CITIES:
        if city in text_lower:
            return city
    return 'не указан'

def detect_urgency(text):
    text_lower = text.lower()
    for word in URGENCY_HIGH:
        if word in text_lower:
            return '🔴 HIGH'
    for word in URGENCY_MEDIUM:
        if word in text_lower:
            return '🟡 MEDIUM'
    return '🟢 LOW'

def is_lead(text):
    text_lower = text.lower()
    
    # Стоп-слова
    for word in STOP_WORDS:
        if word in text_lower:
            return False
    
    score = 0
    for word in PRIMARY_KEYWORDS:
        if word in text_lower:
            score += 3
    for word in SECONDARY_KEYWORDS:
        if word in text_lower:
            score += 2
    
    return score >= 3

app = Client(
    "lead_bot",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING
)

@app.on_message(filters.text & ~filters.me)
async def handle_message(client: Client, message: Message):
    global total_leads, total_processed, total_skipped
    
    try:
        text = message.text or ""
        if len(text) < 10:
            return
        
        # Защита от дублей
        msg_id = f"{message.chat.id}_{message.id}"
        if msg_id in processed_messages:
            return
        processed_messages.add(msg_id)
        total_processed += 1
        
        # Проверка ключевых слов
        text_lower = text.lower()
        has_keyword = any(kw in text_lower for kw in PRIMARY_KEYWORDS + SECONDARY_KEYWORDS)
        if not has_keyword:
            return
        
        # Проверка на лида
        if not is_lead(text):
            total_skipped += 1
            return
        
        total_leads += 1
        
        # Получаем информацию
        sender = message.from_user
        chat = message.chat
        
        sender_name = sender.first_name or "User"
        if sender.last_name:
            sender_name += f" {sender.last_name}"
        
        sender_link = f"https://t.me/{sender.username}" if sender.username else f"tg://user?id={sender.id}"
        chat_name = chat.title or "Личка"
        message_link = f"https://t.me/{chat.username}/{message.id}" if chat.username else "нет (приватный чат)"
        
        # Формируем сообщение
        lead_text = f"""
🔴 НОВЫЙ ЛИД

📌 Чат: {chat_name}
👤 Отправитель: {sender_name}
🔗 Ссылка на отправителя: {sender_link}
📞 Контакты: {extract_contacts(text)}
📍 Город: {detect_city(text)}
⚡ Срочность: {detect_urgency(text)}

💬 Сообщение:
{text[:400]}

🔗 Ссылка на сообщение: {message_link}

📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        """
        
        await client.send_message("me", lead_text)
        print(f"[+] LEAD #{total_leads} | {chat_name} | {sender_name}")
        
    except Exception as e:
        print(f"[-] Error: {e}")

@app.on_message(filters.me & filters.command("stats", prefixes="/"))
async def stats_command(client: Client, message: Message):
    stats_text = f"""
📊 СТАТИСТИКА

🎯 Лидов: {total_leads}
👀 Проверено: {total_processed}
⏭️ Пропущено: {total_skipped}
📈 Конверсия: {round(total_leads / total_processed * 100, 1) if total_processed > 0 else 0}%
        """
    await message.reply(stats_text)

@app.on_message(filters.me & filters.command("ping", prefixes="/"))
async def ping_command(client: Client, message: Message):
    await message.reply("🏓 Pong! Bot is alive")

def main():
    print("🚀 Bot starting with Pyrogram...")
    print(f"📡 API_ID: {API_ID}")
    print(f"🔐 Session string length: {len(SESSION_STRING) if SESSION_STRING else 0}")
    print("✅ Bot is running. Waiting for messages...")
    
    app.run()

if __name__ == "__main__":
    main()
