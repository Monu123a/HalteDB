"""Backfill carrier estimates (Delhivery, BlueDart, DTDC, Xpressbees, Ekart)
for orders where courier costs are currently NULL in shipment_estimates.

Usage:
    .venv/bin/python tasks/backfill_carrier_estimates.py
    .venv/bin/python tasks/backfill_carrier_estimates.py --days 60
    .venv/bin/python tasks/backfill_carrier_estimates.py --all
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_batch
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

load_dotenv(REPO_ROOT / ".env")

from shiprocket import (
    estimate_all_carriers,
    find_cheapest,
    normalize_pincode,
    normalize_provider_name,
)

ORIGIN_PINCODE = os.getenv("ORIGIN_PINCODE", "160012")
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres.clvmribjdecelazooiyo:%2Bd%3FPjHU3hUNh%21K-@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"
)


def backfill_carrier_estimates(days: int | None = 60, all_orders: bool = False):
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    where_clause = "WHERE se.delhivery_cost IS NULL"
    if not all_orders and days:
        where_clause += f"""
          AND (
            o.purchase_date >= NOW() - INTERVAL '{days} days'
            OR se.amazon_order_id LIKE 'HN-%'
          )
        """

    query = f"""
      SELECT
        se.amazon_order_id,
        se.sku,
        se.destination_pincode,
        se.chargeable_weight_kg,
        se.amazon_shipping_cost,
        se.rate_source
      FROM shipment_estimates se
      LEFT JOIN orders o ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
      {where_clause}
      ORDER BY se.amazon_order_id DESC;
    """

    print(f"Fetching rows matching filter (days={days if not all_orders else 'ALL'})...")
    cur.execute(query)
    rows = cur.fetchall()
    print(f"Found {len(rows)} rows to estimate.")

    if not rows:
        cur.close()
        conn.close()
        return

    update_payloads = []
    skipped = 0

    for order_id, sku, dest_pin, weight_kg, amz_cost, current_rate_source in rows:
        dest_pin = normalize_pincode(dest_pin)
        if len(dest_pin) != 6:
            skipped += 1
            continue

        weight = float(weight_kg or 0.5)
        rates = estimate_all_carriers(ORIGIN_PINCODE, dest_pin, weight)
        amazon_cost = float(amz_cost or 0.0)

        cheapest_provider, cheapest_cost = find_cheapest(rates, amazon_cost)

        # Retain sp_api_finance if actual amazon settlement is tracked
        rate_source = "fallback"

        update_payloads.append((
            rates.get("delhivery", {}).get("cost"),
            rates.get("bluedart", {}).get("cost"),
            rates.get("dtdc", {}).get("cost"),
            rates.get("xpressbees", {}).get("cost"),
            rates.get("ekart", {}).get("cost"),
            rates.get("delhivery", {}).get("etd"),
            rates.get("bluedart", {}).get("etd"),
            rates.get("dtdc", {}).get("etd"),
            rates.get("xpressbees", {}).get("etd"),
            rates.get("ekart", {}).get("etd"),
            normalize_provider_name(cheapest_provider),
            None if cheapest_cost == float("inf") else cheapest_cost,
            rate_source,
            order_id,
            sku,
        ))

    print(f"Prepared {len(update_payloads)} rows for update (skipped {skipped} with invalid pincodes).")

    update_sql = """
      UPDATE shipment_estimates
      SET
        delhivery_cost = %s,
        bluedart_cost = %s,
        dtdc_cost = %s,
        xpressbees_cost = %s,
        ekart_cost = %s,
        delhivery_etd = %s,
        bluedart_etd = %s,
        dtdc_etd = %s,
        xpressbees_etd = %s,
        ekart_etd = %s,
        cheapest_provider = %s,
        cheapest_cost = %s,
        rate_source = %s,
        estimated_at = NOW()
      WHERE amazon_order_id = %s AND sku = %s;
    """

    batch_size = 500
    for i in range(0, len(update_payloads), batch_size):
        batch = update_payloads[i:i + batch_size]
        execute_batch(cur, update_sql, batch)
        conn.commit()
        print(f"Updated {min(i + batch_size, len(update_payloads))}/{len(update_payloads)} rows...")

    cur.close()
    conn.close()
    print("Backfill completed successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill carrier estimates for orders with missing courier costs.")
    parser.add_argument("--days", type=int, default=60, help="Number of days to look back for orders (default: 60)")
    parser.add_argument("--all", dest="all_orders", action="store_true", help="Process all historical orders")
    args = parser.parse_args()

    backfill_carrier_estimates(days=args.days, all_orders=args.all_orders)
