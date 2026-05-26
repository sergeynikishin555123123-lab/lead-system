import os
import re
import sys
from datetime import datetime
from collections import defaultdict
from dotenv import load_dotenv
from telethon import TelegramClient, events
from filters import (
    PRIMARY_KEYWORDS,
    SECONDARY_KEYWORDS,
    STOP_WORDS,
    URGENCY_KEYWORDS,
    CITIES,
    CLIENT_MARKERS,
    TARGET_CHATS,
    IGNORE_CHATS
)

load_dotenv()

# ===== НАСТРОЙКИ =====
API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
PHONE = os.getenv("PHONE")

# ===== ХРАНЕНИЕ =====
leads_history = []
chat_stats = defaultdict(int)
processed_messages = set()

# ===== КЛИЕНТ =====
client = TelegramClient(
    'session/user_session',
    API_ID,
    API_HASH
)

def extract_contacts(text: str) -> str:
    """Извлечение контактов"""
    contacts = []
    
    phone_patterns = [
        r'\+7[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}',
        r'8[\s\(-]?\d{3}[\s\)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}',
    ]
    
    for pattern in phone_patterns:
        contacts.extend(re.findall(pattern, text))
    
    usernames = re.findall(r'@[\w_]+', text)
    contacts.extend(usernames)
    
    return ', '.join(set(contacts)) if contacts else 'нет'

def detect_city(text: str) -> str:
    """Определение города"""
    text_lower = text.lower()
    for city in CITIES:
        if city in text_lower:
            return city.title()
    return 'не указан'

def detect_urgency(text: str) -> str:
    """Определение срочности"""
    text_lower = text.lower()
    scores = {'HIGH': 0, 'MEDIUM': 0, 'LOW': 0}
    
    for level, keywords in URGENCY_KEYWORDS.items():
        for word in keywords:
            if word in text_lower:
                scores[level] += 1
    
    if scores['HIGH'] > 0:
        return '🔴 HIGH'
    elif scores['MEDIUM'] > 0:
        return '🟡 MEDIUM'
    elif scores['LOW'] > 0:
        return '🟢 LOW'
    else:
        return '🟡 MEDIUM'

def is_real_client(text: str) -> tuple:
    """Проверка на клиента"""
    text_lower = text.lower()
    
    for word in STOP_WORDS:
        if word in text_lower:
            return False, f"стоп-слово: {word}"
    
    client_score = sum(1 for m in CLIENT_MARKERS if m in text_lower)
    primary_score = sum(1 for w in PRIMARY_KEYWORDS if w in text_lower)
    secondary_score = sum(1 for w in SECONDARY_KEYWORDS if w in text_lower)
    
    total = primary_score * 3 + secondary_score * 2 + client_score * 2
    
    if total >= 5:
        return True, f"уверенный лид (баллы: {total})"
    elif total >= 3:
        return True, f"возможный лид (баллы: {total})"
    else:
        return False, f"мало признаков (баллы: {total})"

@client.on(events.NewMessage(incoming=True))
async def handler(event):
    """Обработчик новых сообщений"""
    
    chat_id = event.chat_id
    
    # Проверка игнорируемых чатов
    if IGNORE_CHATS and chat_id in IGNORE_CHATS:
        return
    
    # Проверка целевых чатов
    if TARGET_CHATS and chat_id not in TARGET_CHATS:
        return
    
    # Текст сообщения
    text = event.message.text or event.message.caption or ""
    
    if not text or len(text) < 15:
        return
    
    # Защита от повторов
    msg_hash = hash(text[:100] + str(chat_id))
    if msg_hash in processed_messages:
        return
    processed_messages.add(msg_hash)
    
    if len(processed_messages) > 5000:
        processed_messages.clear()
    
    # Проверка ключевых слов
    text_lower = text.lower()
    has_primary = any(w in text_lower for w in PRIMARY_KEYWORDS)
    has_secondary = any(w in text_lower for w in SECONDARY_KEYWORDS)
    
    if not (has_primary or has_secondary):
        return
    
    # Проверка на клиента
    is_client, reason = is_real_client(text)
    
    if not is_client:
        print(f"Пропущено: {reason}")
        return
    
    # Информация о чате
    chat = await event.get_chat()
    chat_name = getattr(chat, 'title', None) or f"{getattr(chat, 'first_name', '')} {getattr(chat, 'last_name', '')}".strip()
    
    # Информация об отправителе
    sender = await event.get_sender()
    sender_name = f"{getattr(sender, 'first_name', '')} {getattr(sender, 'last_name', '')}".strip() if sender else "Неизвестный"
    sender_username = f"@{sender.username}" if sender and sender.username else "нет"
    
    # Ссылка на чат
    if getattr(chat, 'username', None):
        chat_link = f"https://t.me/{chat.username}"
    else:
        chat_link = f"чат ID: {chat.id}"
    
    # Ссылка на сообщение
    if getattr(chat, 'username', None):
        msg_link = f"https://t.me/{chat.username}/{event.message.id}"
    else:
        msg_link = f"{chat_link}/{event.message.id}"
    
    # Анализ
    contacts = extract_contacts(text)
    city = detect_city(text)
    urgency = detect_urgency(text)
    
    # Формируем лид
    lead_message = f"""
{urgency} НОВЫЙ ЛИД

📌 Чат: {chat_name}
🔗 Чат: {chat_link}
👤 Отправитель: {sender_name}
📝 Username: {sender_username}
📍 Город: {city}
📞 Контакты: {contacts}

💬 Сообщение:
{text[:500]}{'...' if len(text) > 500 else ''}

🔗 Ссылка: {msg_link}

📊 {reason}
⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
    
    # Отправляем в Избранное
    try:
        await client.send_message('me', lead_message)
        print(f"✅ Лид отправлен: {chat_name}")
    except Exception as e:
        print(f"❌ Ошибка отправки: {e}")
    
    # Сохраняем
    leads_history.append({
        'date': datetime.now(),
        'chat': chat_name,
        'sender': sender_name,
        'text': text[:100],
        'urgency': urgency,
        'city': city
    })
    
    chat_stats[chat_name] += 1

@client.on(events.NewMessage(pattern='/stats', from_users='me'))
async def stats_command(event):
    """Статистика"""
    
    total = len(leads_history)
    today = sum(1 for l in leads_history if l['date'].date() == datetime.now().date())
    high = sum(1 for l in leads_history if 'HIGH' in l['urgency'])
    
    stats = f"""
📊 СТАТИСТИКА

Всего: {total}
Сегодня: {today}
Срочных: {high}

📈 ТОП ЧАТОВ:
"""
    
    for chat, count in sorted(chat_stats.items(), key=lambda x: x[1], reverse=True)[:10]:
        stats += f"• {chat}: {count}\n"
    
    await event.reply(stats)

@client.on(events.NewMessage(pattern='/last', from_users='me'))
async def last_command(event):
    """Последние лиды"""
    
    if not leads_history:
        await event.reply("📭 Пусто")
        return
    
    recent = leads_history[-10:]
    result = "📋 ПОСЛЕДНИЕ 10:\n\n"
    
    for l in reversed(recent):
        result += f"🕐 {l['date'].strftime('%H:%M')} | {l['urgency']} | {l['chat']}\n"
        result += f"   {l['sender']}: {l['text']}\n\n"
    
    await event.reply(result)

async def main():
    """Запуск"""
    
    print("🤖 Запуск юзербота Leadesystem...")
    
    await client.start(phone=PHONE)
    
    print("""
✅ ЮЗЕРБОТ ЗАПУЩЕН!

Мониторинг всех чатов...
Лиды приходят в Избранное (Saved Messages)

Команды в Избранном:
/stats - статистика
/last - последние лиды
""")
    
    await client.run_until_disconnected()

if __name__ == "__main__":
    import asyncio
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Остановлен")
    except Exception as e:
        print(f"❌ Ошибка: {e}")
