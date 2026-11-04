import asyncio
from main import SessionLocal, run_website_orders_sync

async def main():
    print("Starting backfill of all past website orders...")
    async with SessionLocal() as session:
        success = await run_website_orders_sync(session, sync_all=True)
        if success:
            print("Successfully backfilled all past website orders.")
        else:
            print("Failed to backfill website orders. Check logs.")

if __name__ == "__main__":
    asyncio.run(main())
