#!/usr/bin/env python3
import asyncio
from pyrogram import Client

API_ID = 36915299
API_HASH = "8f6f4afed9be4056445006b6f179e788"

async def main():
    async with Client("temp", api_id=API_ID, api_hash=API_HASH) as app:
        print("\n" + "=" * 60)
        print("НОВАЯ СЕССИЯ (скопируйте полностью):")
        print("=" * 60)
        session = await app.export_session_string()
        print(session)
        print("=" * 60)
        print(f"\nДлина строки: {len(session)} символов")
        print("\n✅ Вставьте эту строку в .env как SESSION_STRING=")

if __name__ == "__main__":
    asyncio.run(main())
