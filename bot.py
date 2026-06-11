#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import re
from datetime import datetime
from dotenv import load_dotenv
from pyrogram import Client, filters
from pyrogram.types import Message

load_dotenv()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
SESSION_STRING = os.getenv("SESSION_STRING")

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
            return 'HIGH'
    for word in URGENCY_MEDIUM:
        if word in text_lower:
            return 'MEDIUM'
    return 'LOW'

def is_lead(text):
    text_lower = text.lower()
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

app = Client("lead_bot", api_id=API_ID, api_hash=API_HASH, session_string=SESSION_STRING)

@app.on_message(filters.text & ~filters.me)
async def handle_message(client: Client, message: Message):
    global total_leads, total_processed, total_skipped
    try:
        text = message.text or ""
        if len(text) < 10:
            return
        msg_id = f"{message.chat.id}_{message.id}"
        if msg_id in processed_messages:
            return
        processed_messages.add(msg_id)
        total_processed += 1
        text_lower = text.lower()
        has_keyword = any(kw in text_lower for kw in PRIMARY_KEYWORDS + SECONDARY_KEYWORDS)
        if not has_keyword:
            return
        if not is_lead(text):
            total_skipped += 1
            return
        total_leads += 1
        sender = message.from_user
        chat = message.chat
        sender_name = sender.first_name or "User"
        if sender.last_name:
            sender_name += f" {sender.last_name}"
        sender_link = f"https://t.me/{sender.username}" if sender.username else f"tg://user?id={sender.id}"
        chat_name = chat.title or "Личка"
        message_link = f"https://t.me/{chat.username}/{message.id}" if chat.username else "нет (приватный чат)"
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
        """
        await client.send_message("me", lead_text)
        print(f"🎯 LEAD #{total_leads} | {chat_name}")
    except Exception as e:
        print(f"ERROR: {e}")

@app.on_message(filters.me & filters.command("stats", prefixes="/"))
async def stats_command(client: Client, message: Message):
    stats_text = f"📊 СТАТИСТИКА\n\n🎯 Лидов: {total_leads}\n👀 Проверено: {total_processed}\n⏭️ Пропущено: {total_skipped}"
    await message.reply(stats_text)

@app.on_message(filters.me & filters.command("ping", prefixes="/"))
async def ping_command(client: Client, message: Message):
    await message.reply("🏓 Pong!")

def main():
    print("🚀 Bot starting with Pyrogram...")
    app.run()

if __name__ == "__main__":
    main()
