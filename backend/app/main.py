from fastapi import FastAPI
from telethon import TelegramClient, events
from openai import OpenAI
from dotenv import load_dotenv

import asyncio
import os

load_dotenv()

app = FastAPI()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

client_ai = OpenAI(api_key=OPENAI_API_KEY)

telegram = TelegramClient(
    'session',
    API_ID,
    API_HASH
)

KEYWORDS = [
    'электрик',
    'электрика',
    'щит',
    'проводка',
    'розетки',
    'монтаж'
]

@app.get("/")
async def root():
    return {"status": "working"}

async def analyze_message(text):

    response = client_ai.chat.completions.create(
        model='gpt-4o-mini',
        messages=[
            {
                'role': 'system',
                'content': '''
                Ты анализируешь сообщения из Telegram.

                Определи:
                1. Это реальный клиент или нет.
                2. Нужен ли электрик.
                3. Насколько лид горячий.

                Ответ:
                HIGH
                MEDIUM
                LOW
                '''
            },
            {
                'role': 'user',
                'content': text
            }
        ]
    )

    return response.choices[0].message.content

@telegram.on(events.NewMessage)
async def handler(event):

    if event.out:
        return

    text = event.raw_text

    if not text:
        return

    text_lower = text.lower()

    if not any(word in text_lower for word in KEYWORDS):
        return

    result = await analyze_message(text)

    if "HIGH" not in result:
        return

    chat = await event.get_chat()

    sender = await event.get_sender()

    message = f'''
🔥 HOT LEAD

CHAT:
{getattr(chat, "title", "Unknown")}

SENDER:
{getattr(sender, "first_name", "Unknown")}

MESSAGE:
{text}

AI:
{result}
'''

    await telegram.send_message('me', message)

async def start_bot():

    await telegram.start()

    print("BOT STARTED")

    await telegram.run_until_disconnected()

@app.on_event("startup")
async def startup_event():

    asyncio.create_task(start_bot())
