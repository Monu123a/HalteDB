import os
import logging
from datetime import datetime, timezone
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from crud import upsert_orders_batch, update_website_orders_sync_time

logger = logging.getLogger("haltedb")

UPSERT_CHUNK_SIZE = 50


def _clean_optional_str(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _parse_order_time(raw_time: object) -> datetime | None:
    if not raw_time:
        return None
    text = str(raw_time).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _build_order_record(order: dict) -> dict | None:
    order_id = _clean_optional_str(order.get("order_id"))
    sku = _clean_optional_str(order.get("sku"))
    parsed_time = _parse_order_time(order.get("order_time"))

    if not order_id or not sku or parsed_time is None:
        logger.warning(
            "Skipping invalid website order record: order_id=%r sku=%r order_time=%r",
            order.get("order_id"),
            order.get("sku"),
            order.get("order_time"),
        )
        return None

    quantity = int(order.get("quantity") or 0)
    unit_price = float(order.get("price_at_purchase") or 0)
    item_price = round(unit_price * (quantity if quantity > 0 else 1), 2)
    order_state = _clean_optional_str(order.get("order_state"))

    return {
        "amazon_order_id": f"HN-{order_id}",
        "purchase_date": parsed_time,
        "last_updated_date": parsed_time,
        "order_status": order_state,
        "fulfillment_channel": "Halte Website",
        "sales_channel": "halte.in",
        "sku": sku,
        "item_status": order_state,
        "quantity": quantity,
        "currency": "INR",
        "item_price": item_price,
        "ship_city": _clean_optional_str(order.get("ship_city")),
        "ship_state": _clean_optional_str(order.get("ship_state")),
        "ship_postal_code": _clean_optional_str(order.get("ship_postal_code")),
    }


async def _upsert_with_fallback(session: AsyncSession, batch: list[dict]) -> int:
    synced_count = 0
    for i in range(0, len(batch), UPSERT_CHUNK_SIZE):
        chunk = batch[i : i + UPSERT_CHUNK_SIZE]
        try:
            await upsert_orders_batch(session, chunk)
            synced_count += len(chunk)
        except Exception as chunk_err:
            logger.error(
                "Website orders chunk upsert failed (%d rows), rolling back and retrying row-by-row: %s",
                len(chunk),
                chunk_err,
            )
            await session.rollback()
            for row in chunk:
                try:
                    await upsert_orders_batch(session, [row])
                    synced_count += 1
                except Exception as row_err:
                    logger.error(
                        "Failed upserting website order %s (sku=%s): %s",
                        row.get("amazon_order_id"),
                        row.get("sku"),
                        row_err,
                    )
                    await session.rollback()
    return synced_count


async def run_website_orders_sync(session: AsyncSession, sync_all: bool = False):
    logger.info(f"Starting Website Orders Sync (sync_all={sync_all})")

    api_url = os.getenv("HALTE_NEXT_API_URL", "https://halte.in")
    api_key = os.getenv("HALTE_NEXT_API_KEY") or os.getenv("DASHBOARD_API_KEY")
    lookback_days = os.getenv("WEBSITE_ORDERS_SYNC_LOOKBACK_DAYS", "30")

    if not api_key:
        logger.error("Missing HALTE_NEXT_API_KEY or DASHBOARD_API_KEY")
        return False

    try:
        url = f"{api_url.rstrip('/')}/api/haltedb/orders"
        params = {"sync_all": "true" if sync_all else "false", "lookback_days": lookback_days}
        headers = {"x-api-key": api_key}

        async with httpx.AsyncClient() as client:
            resp = await client.get(url, params=params, headers=headers, timeout=30.0)
            resp.raise_for_status()
            website_orders = resp.json()

        if not website_orders:
            logger.info("No website orders found to sync.")
            await update_website_orders_sync_time(session, datetime.now(timezone.utc))
            return True

        batch: list[dict] = []
        for o in website_orders:
            try:
                record = _build_order_record(o)
                if record is not None:
                    batch.append(record)
            except Exception as e:
                logger.error(f"Error processing website order {o.get('order_id')}: {e}")

        if not batch:
            logger.warning("Website orders response contained no valid records to sync.")
            return False

        synced_count = await _upsert_with_fallback(session, batch)
        if synced_count == 0:
            logger.error("Website orders sync wrote 0 of %d records.", len(batch))
            return False

        await update_website_orders_sync_time(session, datetime.now(timezone.utc))
        logger.info(f"Successfully synced {synced_count}/{len(batch)} website order items.")
        return synced_count == len(batch)

    except Exception as e:
        logger.error(f"Failed to sync website orders: {e}", exc_info=True)
        return False
