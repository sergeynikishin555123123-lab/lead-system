#!/usr/bin/env python3
from pyrogram import Client

API_ID = 36915299
API_HASH = "8f6f4afed9be4056445006b6f179e788"

print("🚀 Создание новой сессии для Pyrogram")
print(f"API_ID: {API_ID}")
print("Введите номер телефона в формате +79850118357")
print("Затем введите код из Telegram\n")

app = Client("new_session", api_id=API_ID, api_hash=API_HASH)

async def main():
    async with app:
        session_string = await app.export_session_string()
        print("\n" + "="*50)
        print("✅ НОВАЯ СЕССИЯ (скопируйте целиком):")
        print("="*50)
        print(session_string)
        print("="*50)

app.run(main())
