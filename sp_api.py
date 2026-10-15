import os
import logging
import httpx
import asyncio
import csv
import io
from collections import defaultdict
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta, timezone, date
import zlib
from sqlalchemy import text as sa_text

from crud import (
    upsert_orders_batch,
    upsert_inventory_batch,
    upsert_inbound_shipments_batch,
    prune_inbound_shipments_not_in,
    reset_and_upsert_inbound_quantities,
    get_sync_meta,
    update_orders_sync_time,
    update_inventory_sync_time,
    update_inbound_shipments_sync_time,
    update_inbound_shipments_sync_error,
)
from shiprocket import (
    find_cheapest,
    get_shipping_rates_with_source,
    is_amazon_fulfilled,
    normalize_pincode,
    normalize_provider_name,
    resolve_amazon_shipping_cost,
)

logger = logging.getLogger("haltedb")

SHIPMENT_SYNC_BATCH_SIZE = int(os.getenv("SHIPMENT_SYNC_BATCH_SIZE", "150"))
# Phase 4 (run_shipment_sync) no longer calls the Finance API; Phase 6
# (run_amazon_finance_actuals_sync) is the sole owner of Finance lookups.
# Keep this constant at 0 so legacy code paths skip Amazon Finance calls.
AMAZON_FINANCE_LOOKUP_LIMIT = int(os.getenv("AMAZON_FINANCE_LOOKUP_LIMIT", "0"))
AMAZON_FINANCE_LOOKUP_DELAY_SECONDS = float(os.getenv("AMAZON_FINANCE_LOOKUP_DELAY_SECONDS", "2.1"))
AMAZON_FINANCE_LOOKUP_MAX_RETRIES = int(os.getenv("AMAZON_FINANCE_LOOKUP_MAX_RETRIES", "3"))
AMAZON_FINANCE_LOOKUP_BACKOFF_MULTIPLIER = float(os.getenv("AMAZON_FINANCE_LOOKUP_BACKOFF_MULTIPLIER", "2.0"))
ORIGIN_PINCODE = os.getenv("ORIGIN_PINCODE", "160012")
AMAZON_FEE_INCLUDE_KEYWORDS = (
    "fba", "fulfillment", "shipping", "shipment", "weight",
    "perorder", "perunit", "pick", "pack", "transport", "delivery",
)
AMAZON_FEE_EXCLUDE_KEYWORDS = (
    "commission", "referral", "closing", "gift", "wrap", "tax",
    "withheld", "storage", "advertising", "promotion", "adjustment",
    "reimbursement", "servicefee", "subscription",
)
# Referral/closing fees that Amazon displays as "Amazon fees" on seller central
AMAZON_REFERRAL_FEE_INCLUDE_KEYWORDS = (
    "commission", "referral", "closing", "peritem", "variableclose", "fixedclose",
)
GST_INVOICE_LOOKBACK_DAYS = int(os.getenv("GST_INVOICE_LOOKBACK_DAYS", "45"))
GST_INVOICE_REPORT_TYPES = (
    ("GET_GST_MTR_B2B_CUSTOM", "B2B"),
    ("GET_GST_MTR_B2C_CUSTOM", "B2C"),
)


# ============================================
# Amazon Access Token
# ============================================

_cached_token: str | None = None
_cached_token_expires_at: float = 0.0

async def get_amazon_access_token() -> str:
    """
    Exchanges your permanent Refresh Token for a temporary 1-hour Access Token.
    Caches the token in memory to avoid redundant authentication calls.
    """
    global _cached_token, _cached_token_expires_at
    import time
    now_ts = time.time()
    if _cached_token and now_ts < _cached_token_expires_at:
        return _cached_token

    client_id = os.getenv("SP_API_LWA_APP_ID")
    client_secret = os.getenv("SP_API_LWA_CLIENT_SECRET")
    refresh_token = os.getenv("SP_API_REFRESH_TOKEN")

    if not all([client_id, client_secret, refresh_token]):
        raise ValueError("Missing Amazon LWA credentials in environment!")

    auth_url = "https://api.amazon.com/auth/o2/token"
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(auth_url, data=payload)
        if response.status_code != 200:
            logger.error(f"Amazon Auth Error: {response.text}")
            raise ValueError(f"Failed to authenticate with Amazon SP-API: {response.text}")
        data = response.json()
        _cached_token = data["access_token"]
        _cached_token_expires_at = now_ts + data.get("expires_in", 3600) - 300
        return _cached_token


# ============================================
# Inventory Sync (Ledger Report)
# ============================================

async def run_inventory_sync_job(session: AsyncSession):
    endpoint = os.getenv("SP_API_ENDPOINT")
    if not endpoint:
        raise ValueError("Missing SP_API_ENDPOINT in environment")

    # Strip quotes if present (common .env issue)
    endpoint = endpoint.strip('"').strip("'")

    access_token = await get_amazon_access_token()
    headers = {"x-amz-access-token": access_token}

    report_type = "GET_LEDGER_SUMMARY_VIEW_DATA"

    end_time = datetime.now(timezone.utc).replace(hour=23, minute=59, second=59, microsecond=0) - timedelta(days=1)
    start_time = end_time.replace(hour=0, minute=0, second=0, microsecond=0)

    async with httpx.AsyncClient(timeout=60.0) as client:
        logger.info("Requesting Ledger Inventory Report from Amazon...")

        create_payload = {
            "reportType": report_type,
            "marketplaceIds": [os.getenv("SP_API_MARKETPLACE_ID")],
            "dataStartTime": start_time.isoformat(),
            "dataEndTime": end_time.isoformat(),
            "reportOptions": {
                "aggregateByLocation": "FC",
                "aggregatedByTimePeriod": "DAILY"
            }
        }

        res = await client.post(f"{endpoint}/reports/2021-06-30/reports", headers=headers, json=create_payload)
        if res.status_code >= 400:
            logger.error(f"Amazon Inventory Report request rejected: {res.text}")
        res.raise_for_status()

        report_id = res.json()["reportId"]
        logger.info(f"Report requested! ID: {report_id}. Polling...")

        document_id = None
        while True:
            await asyncio.sleep(15)
            poll_res = await client.get(f"{endpoint}/reports/2021-06-30/reports/{report_id}", headers=headers)
            poll_res.raise_for_status()
            status_data = poll_res.json()
            status = status_data["processingStatus"]
            logger.info(f"  Polling inventory report: {status}")

            if status == "DONE":
                document_id = status_data["reportDocumentId"]
                break
            elif status in ["CANCELLED", "FATAL"]:
                logger.error("Report generation failed or was cancelled by Amazon.")
                return

        doc_res = await client.get(f"{endpoint}/reports/2021-06-30/documents/{document_id}", headers=headers)
        doc_res.raise_for_status()
        download_url = doc_res.json()["url"]

        logger.info("Downloading & parsing inventory ledger data...")
        async with client.stream("GET", download_url) as response:
            decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16)
            buffer = ""
            batch = []
            headers_list = []
            is_first_line = True

            async for chunk in response.aiter_bytes():
                buffer += decompressor.decompress(chunk).decode('utf-8')

                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue

                    values = [v.strip().strip('"') for v in line.split('\t')]

                    if is_first_line:
                        headers_list = values
                        is_first_line = False
                        continue

                    row_data = dict(zip(headers_list, values))

                    fc_id = row_data.get("Location", "UNKNOWN")
                    disposition = row_data.get("Disposition", "SELLABLE")
                    qty_str = row_data.get("Ending Warehouse Balance", "0")
                    qty = int(qty_str) if qty_str.lstrip('-').isdigit() else 0

                    parsed_record = {
                        "sku": row_data.get("MSKU", "UNKNOWN"),
                        "fnsku": row_data.get("FNSKU"),
                        "asin": row_data.get("ASIN"),
                        "condition": disposition,
                        "fulfillment_center_id": fc_id,
                        "fulfillable_quantity": qty if disposition == "SELLABLE" else 0,
                        "unfulfillable_quantity": qty if disposition != "SELLABLE" else 0,
                        "reserved_quantity": 0
                    }
                    batch.append(parsed_record)

                    if len(batch) >= 1000:
                        await upsert_inventory_batch(session, batch)
                        batch.clear()

            final_data = decompressor.flush().decode('utf-8')
            if final_data:
                buffer += final_data

            if batch:
                await upsert_inventory_batch(session, batch)

    # Update sync timestamp
    await update_inventory_sync_time(session, datetime.now(timezone.utc))
    logger.info("Inventory sync complete!")


# ============================================
# Inbound Shipments Sync (FBA Inbound Shipments API)
# ============================================

import re as _re

_SHIPMENT_DATE_RE = _re.compile(r"\((\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})\)")


def _parse_booked_date(shipment_name: str | None):
    """Extract booking date from ShipmentName like 'FBA STA (23/03/2026 06:47)-BLR8'."""
    if not shipment_name:
        return None
    m = _SHIPMENT_DATE_RE.search(shipment_name)
    if not m:
        return None
    try:
        d, mo, y, h, mi = (int(x) for x in m.groups())
        return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)
    except Exception:
        return None


async def run_inbound_shipments_sync(session: AsyncSession, lookback_days: int = 90):
    try:
        return await _run_inbound_shipments_sync(session, lookback_days)
    except Exception as exc:
        await session.rollback()
        try:
            await update_inbound_shipments_sync_error(session, str(exc))
        except Exception:
            logger.exception("Failed to record inbound shipments sync error")
        raise


async def _run_inbound_shipments_sync(session: AsyncSession, lookback_days: int = 90):
    """Pulls active FBA inbound shipments (last `lookback_days` of activity) into
    the `inbound_shipments` table. Independent from the existing inventory sync."""
    endpoint = os.getenv("SP_API_ENDPOINT", "").strip('"').strip("'")
    if not endpoint:
        raise ValueError("Missing SP_API_ENDPOINT in environment")

    marketplace_id = os.getenv("SP_API_MARKETPLACE_ID")
    if not marketplace_id:
        raise ValueError("Missing SP_API_MARKETPLACE_ID in environment")

    access_token = await get_amazon_access_token()
    headers = {"x-amz-access-token": access_token}

    sync_started = datetime.now(timezone.utc)
    last_updated_after = (sync_started - timedelta(days=lookback_days)).isoformat()
    statuses = "WORKING,SHIPPED,IN_TRANSIT,DELIVERED,CHECKED_IN,RECEIVING"

    url = f"{endpoint}/fba/inbound/v0/shipments"
    params = {
        "ShipmentStatusList": statuses,
        "QueryType": "SHIPMENT",
        "MarketplaceId": marketplace_id,
        "LastUpdatedAfter": last_updated_after,
    }

    logger.info("Fetching FBA inbound shipments (last %d days)...", lookback_days)
    all_shipments: list[dict] = []
    next_token: str | None = None

    async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
        while True:
            if next_token:
                # SP-API spec: when paginating, only QueryType=NEXT_TOKEN + NextToken are needed
                p = {
                    "QueryType": "NEXT_TOKEN",
                    "MarketplaceId": marketplace_id,
                    "NextToken": next_token,
                }
            else:
                p = params

            r = await client.get(url, params=p)
            if r.status_code == 429:
                logger.warning("Inbound shipments rate-limited, sleeping 5s...")
                await asyncio.sleep(5)
                continue
            r.raise_for_status()
            data = r.json().get("payload", {})
            shipments = data.get("ShipmentData") or []
            all_shipments.extend(shipments)
            next_token = data.get("NextToken")
            if not next_token:
                break

    logger.info("Got %d inbound shipments from Amazon", len(all_shipments))

    batch = []
    for s in all_shipments:
        addr = s.get("ShipFromAddress") or {}
        batch.append({
            "shipment_id": s.get("ShipmentId"),
            "shipment_name": s.get("ShipmentName"),
            "destination_fc": s.get("DestinationFulfillmentCenterId"),
            "shipment_status": s.get("ShipmentStatus"),
            "label_prep_type": s.get("LabelPrepType"),
            "box_contents_source": s.get("BoxContentsSource"),
            "booked_date": _parse_booked_date(s.get("ShipmentName")),
            "ship_from_city": addr.get("City"),
            "ship_from_state": addr.get("StateOrProvinceCode"),
            "last_synced": sync_started,
        })

    if batch:
        await upsert_inbound_shipments_batch(session, batch)
        await prune_inbound_shipments_not_in(session, [b["shipment_id"] for b in batch])

    # ── Fetch per-SKU items and aggregate into inventory.inbound_*_quantity ──
    # Uses existing inventory columns (no schema change). Buckets by shipment status:
    #   WORKING -> inbound_working_quantity
    #   SHIPPED / IN_TRANSIT / DELIVERED -> inbound_shipped_quantity
    #   CHECKED_IN / RECEIVING -> inbound_receiving_quantity
    active_statuses = {"WORKING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING"}
    active_shipments = [
        b for b in batch
        if b.get("shipment_id") and b.get("destination_fc") and b.get("shipment_status") in active_statuses
    ]
    active_by_id = {sh["shipment_id"]: sh for sh in active_shipments}
    logger.info("Fetching items for %d active inbound shipments...", len(active_shipments))

    in_transit_by_sku_fc: dict[tuple[str, str], dict[str, int]] = {}
    item_fetch_failures: list[str] = []

    async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
        items_url = f"{endpoint}/fba/inbound/v0/shipmentItems"
        next_token: str | None = None
        while True:
            if next_token:
                params = {
                    "MarketplaceId": marketplace_id,
                    "QueryType": "NEXT_TOKEN",
                    "NextToken": next_token,
                }
            else:
                params = {
                    "MarketplaceId": marketplace_id,
                    "QueryType": "DATE_RANGE",
                    "LastUpdatedAfter": last_updated_after,
                    "LastUpdatedBefore": sync_started.isoformat(),
                }
            try:
                r = await client.get(items_url, params=params)
            except Exception as e:
                logger.warning("Inbound items fetch failed: %s", e)
                item_fetch_failures.append(str(e))
                break
            if r.status_code == 429:
                logger.warning("Inbound items rate-limited, sleeping 5s...")
                await asyncio.sleep(5)
                continue
            if r.status_code >= 400:
                logger.warning("Inbound items fetch HTTP %s: %s", r.status_code, r.text[:200])
                item_fetch_failures.append(f"HTTP {r.status_code}")
                break
            payload = r.json().get("payload", {})
            for it in (payload.get("ItemData") or []):
                sh = active_by_id.get(it.get("ShipmentId"))
                if not sh:
                    continue
                sku = it.get("SellerSKU")
                if not sku:
                    continue
                qty_remaining = max(
                    0,
                    int(it.get("QuantityShipped") or 0) - int(it.get("QuantityReceived") or 0),
                )
                if qty_remaining <= 0:
                    continue
                status = sh["shipment_status"]
                bucket_key = (
                    "working" if status == "WORKING"
                    else "receiving" if status in {"CHECKED_IN", "RECEIVING"}
                    else "shipped"  # SHIPPED + IN_TRANSIT + DELIVERED
                )
                buckets = in_transit_by_sku_fc.setdefault(
                    (sku, sh["destination_fc"]), {"working": 0, "shipped": 0, "receiving": 0}
                )
                buckets[bucket_key] += qty_remaining
            next_token = payload.get("NextToken")
            if not next_token:
                break
            await asyncio.sleep(0.6)

    if item_fetch_failures:
        sample = "; ".join(item_fetch_failures[:5])
        suffix = "" if len(item_fetch_failures) <= 5 else f"; +{len(item_fetch_failures) - 5} more"
        raise RuntimeError(f"Inbound shipment item fetch failed; preserving previous matrix quantities. {sample}{suffix}")

    await reset_and_upsert_inbound_quantities(session, in_transit_by_sku_fc)
    total_units = sum(sum(b.values()) for b in in_transit_by_sku_fc.values())
    logger.info("Wrote in-transit quantities for %d (sku,fc) pairs (%d units total)",
                len(in_transit_by_sku_fc), total_units)
    await update_inbound_shipments_sync_time(session, datetime.now(timezone.utc))

    logger.info("Inbound shipments sync complete!")


# ============================================
# State Normalization Map (Amazon sends abbreviations & variants)
# ============================================
STATE_NORMALIZATION_MAP = {
    # Two-letter abbreviations (title-cased because we .title() before lookup)
    "Ap": "Andhra Pradesh",
    "As": "Assam",
    "Br": "Bihar",
    "Ch": "Chandigarh",
    "Dl": "Delhi",
    "Ga": "Goa",
    "Gj": "Gujarat",
    "Hr": "Haryana",
    "Jk": "Jammu & Kashmir",
    "Ka": "Karnataka",
    "Kl": "Kerala",
    "Mh": "Maharashtra",
    "Mp": "Madhya Pradesh",
    "Pb": "Punjab",
    "Rj": "Rajasthan",
    "Tg": "Telangana",
    "Tn": "Tamil Nadu",
    "Up": "Uttar Pradesh",
    "Wb": "West Bengal",
    "Cg": "Chhattisgarh",
    "Jh": "Jharkhand",
    "Uk": "Uttarakhand",
    "Or": "Odisha",
    "Hp": "Himachal Pradesh",
    "Sk": "Sikkim",
    "Mn": "Manipur",
    "Ml": "Meghalaya",
    "Mz": "Mizoram",
    "Nl": "Nagaland",
    "Tr": "Tripura",
    "Ar": "Arunachal Pradesh",
    # Variant spellings
    "Tamilnadu": "Tamil Nadu",
    "Telangana State": "Telangana",
    "New Delhi": "Delhi",
    "Pondicherry": "Puducherry",
    "Jammu And Kashmir": "Jammu & Kashmir",
    "Chattisgarh": "Chhattisgarh",
    "Orissa": "Odisha",
}


def _normalize_state(raw: str | None) -> str | None:
    """Title-case, then fix abbreviations & variant spellings."""
    if not raw:
        return None
    titled = raw.strip().title()
    if not titled:
        return None
    # Handle compound entries like "Maharashtra, Dombivali"
    if "," in titled:
        titled = titled.split(",")[0].strip()
    return STATE_NORMALIZATION_MAP.get(titled, titled)


import re

# Canonical city name aliases — maps misspellings/variants to correct names
CITY_ALIAS_MAP = {
    "Bangalore": "Bengaluru", "Banglore": "Bengaluru", "Bengalore": "Bengaluru",
    "Bangaluru": "Bengaluru", "Bangalore North": "Bengaluru", "Bangalore South": "Bengaluru",
    "Bangalore Rural": "Bengaluru", "Bengaluru Rural": "Bengaluru", "Bengaluru Urban": "Bengaluru",
    "Bombay": "Mumbai", "Chennaichennai": "Chennai",
    "Trivandrum": "Thiruvananthapuram", "Thiruvanathapuram": "Thiruvananthapuram",
    "Thiruvanthapuram": "Thiruvananthapuram", "Thiruvananthapuramtrivandrum": "Thiruvananthapuram",
    "Gurgaon": "Gurugram", "Mangalore": "Mangaluru", "Manglore": "Mangaluru",
    "Mysore": "Mysuru", "Calcutta": "Kolkata", "Cochin": "Kochi",
    "Calicut": "Kozhikode", "Allahabad": "Prayagraj", "Banaras": "Varanasi",
    "Benaras": "Varanasi", "Pondicherry": "Puducherry", "Vizag": "Visakhapatnam",
    "Belgaum": "Belagavi", "Hubli": "Hubballi", "Tumkur": "Tumakuru",
    "Gulbarga": "Kalaburagi", "Shimoga": "Shivamogga", "Bellary": "Ballari",
    "Bijapur": "Vijayapura", "Trichur": "Thrissur", "Alleapy": "Alappuzha",
    "Trichy": "Tiruchirappalli", "Tirupur": "Tiruppur", "Palghat": "Palakkad",
    "Bhubaneshwar": "Bhubaneswar", "Raurkela": "Rourkela", "Samastipr": "Samastipur",
    "Azmgrh": "Azamgarh", "Dharamshala": "Dharmashala", "Dharmsala": "Dharmashala",
    "Behrampur": "Berhampur", "Samlkha": "Samalkha", "Rajsmand": "Rajsamand",
    "Sikandrabad": "Sikandarabad", "Jagatsinghapur": "Jagatsinghpur",
    "Kanchipuram": "Kancheepuram", "Kasargod": "Kasaragod",
    "Ahmadnagar": "Ahmednagar", "Jhunjhunun": "Jhunjhunu",
    "Mandyamandya": "Mandya", "Agraagra": "Agra", "Ahmedabada": "Ahmedabad",
    "Anantapuramu": "Anantapur", "Sultaanpur": "Sultanpur",
    "Bardhaman": "Burdwan", "Changanacherry": "Changanassery",
    "Nowshehra": "Nowshera", "Sulthan Bathery": "Sultan Bathery",
    "Sulthanbathery": "Sultan Bathery", "Thoothukudi": "Thoothukkudi",
    "Tuticorin": "Thoothukkudi", "Paradeep": "Paradip", "Paramakuti": "Paramakudi",
    "Ranagt": "Ranaghat", "Baleshwar": "Balasore", "Shilong": "Shillong",
    "Virajpete": "Virajpet", "Kanniyakumari": "Kanyakumari", "Alwaye": "Aluva",
    "Yamuna Nagar": "Yamunanagar", "Chengalpet": "Chengalpattu",
    "Sriganganagar": "Sri Ganganagar", "Hospet": "Hosapete",
    "Patna City": "Patna", "Pune City": "Pune",
}

def _normalize_city(raw: str | None) -> str | None:
    """Clean city names: strip numbers, commas, parentheses, colons, slashes; apply alias map."""
    if not raw:
        return None
    city = raw.strip()
    if not city:
        return None
    # Take first part before comma
    if "," in city:
        city = city.split(",")[0].strip()
    # Take first part before colon
    if ":" in city:
        city = city.split(":")[0].strip()
    # Take first part before slash
    if "/" in city:
        city = city.split("/")[0].strip()
    # Remove parenthetical suffixes like "(W)" or "(East)"
    city = re.sub(r'\([^)]*\)', '', city).strip()
    # Remove digits (phone numbers, postcodes)
    city = re.sub(r'[\d]+', '', city).strip()
    # Remove trailing/leading special chars
    city = re.sub(r'^[\s,;.\-:&]+|[\s,;.\-:&]+$', '', city).strip()
    # Collapse multiple spaces
    city = re.sub(r'\s+', ' ', city)
    if not city:
        return None
    city = city.title()
    # Apply canonical alias map
    return CITY_ALIAS_MAP.get(city, city)


# ============================================
# Orders Fetch (Date Range Report)
# ============================================

async def fetch_orders_date_range(
    session: AsyncSession,
    start_time: datetime,
    end_time: datetime,
    by_last_update: bool = True,
):
    endpoint = os.getenv("SP_API_ENDPOINT")
    if not endpoint:
        raise ValueError("Missing SP_API_ENDPOINT in environment")
    endpoint = endpoint.strip('"').strip("'")

    access_token = await get_amazon_access_token()
    headers = {"x-amz-access-token": access_token}

    # BY_LAST_UPDATE catches status changes (Pending → Shipped/Cancelled) on older
    # orders. BY_ORDER_DATE only returns orders whose PURCHASE date is in range,
    # which freezes the status of any order older than the lookback window.
    report_type = (
        "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL"
        if by_last_update
        else "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL"
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        logger.info(f"Requesting Orders from {start_time.strftime('%Y-%m-%d')} to {end_time.strftime('%Y-%m-%d')}...")

        create_payload = {
            "reportType": report_type,
            "marketplaceIds": [os.getenv("SP_API_MARKETPLACE_ID")],
            "dataStartTime": start_time.isoformat(),
            "dataEndTime": end_time.isoformat()
        }

        res = await client.post(f"{endpoint}/reports/2021-06-30/reports", headers=headers, json=create_payload)
        res.raise_for_status()
        report_id = res.json()["reportId"]

        document_id = None
        while True:
            await asyncio.sleep(15)
            poll_res = await client.get(f"{endpoint}/reports/2021-06-30/reports/{report_id}", headers=headers)
            poll_res.raise_for_status()
            status_data = poll_res.json()
            status = status_data["processingStatus"]
            logger.info(f"  Polling orders report: {status}")

            if status == "DONE":
                document_id = status_data["reportDocumentId"]
                break
            elif status in ["CANCELLED", "FATAL"]:
                raise ValueError(f"Order report failed with status: {status}")

        doc_res = await client.get(f"{endpoint}/reports/2021-06-30/documents/{document_id}", headers=headers)
        doc_res.raise_for_status()
        doc_data = doc_res.json()

        download_url = doc_data["url"]
        compression_algo = doc_data.get("compressionAlgorithm", "NONE")

        async with client.stream("GET", download_url) as response:
            decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16) if compression_algo == "GZIP" else None

            buffer = ""
            batch = []
            headers_list = []
            is_first_line = True

            def safe_float(val):
                if not val: return 0.0
                try: return float(val.replace(',', '').strip())
                except ValueError: return 0.0

            def safe_datetime(val):
                if not val: return None
                try: dt = datetime.fromisoformat(val.replace('Z', '+00:00'))
                except ValueError: return None
                # Reject implausible future dates (bad source data, e.g. year 2205)
                now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.utcnow()
                if dt > now + timedelta(days=1):
                    return None
                return dt

            async for chunk in response.aiter_bytes():
                if decompressor:
                    buffer += decompressor.decompress(chunk).decode('utf-8', errors='replace')
                else:
                    buffer += chunk.decode('utf-8', errors='replace')

                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if not line: continue

                    values = [v.strip().strip('"') for v in line.split('\t')]

                    if is_first_line:
                        headers_list = values
                        is_first_line = False
                        continue

                    row_data = dict(zip(headers_list, values))

                    amz_order_id = row_data.get("amazon-order-id")
                    sku = row_data.get("sku")

                    if amz_order_id and sku:
                        parsed_record = {
                            "amazon_order_id": amz_order_id,
                            "purchase_date": safe_datetime(row_data.get("purchase-date")),
                            "last_updated_date": safe_datetime(row_data.get("last-updated-date")),
                            "order_status": row_data.get("order-status", "UNKNOWN"),
                            "fulfillment_channel": row_data.get("fulfillment-channel"),
                            "sales_channel": row_data.get("sales-channel"),
                            "sku": sku,
                            "asin": row_data.get("asin"),
                            "item_status": row_data.get("item-status"),
                            "quantity": int(row_data.get("quantity", 0) or 0),
                            "currency": row_data.get("currency"),
                            "item_price": safe_float(row_data.get("item-price")),
                            "item_tax": safe_float(row_data.get("item-tax")),
                            "shipping_price": safe_float(row_data.get("shipping-price")),
                            "ship_city": _normalize_city(row_data.get("ship-city")),
                            "ship_state": _normalize_state(row_data.get("ship-state")),
                            "ship_postal_code": (row_data.get("ship-postal-code") or "").strip() or None,
                        }
                        batch.append(parsed_record)

                    if len(batch) >= 1000:
                        await upsert_orders_batch(session, batch)
                        batch.clear()

            if decompressor:
                buffer += decompressor.flush().decode('utf-8', errors='replace')

            if batch:
                await upsert_orders_batch(session, batch)

        logger.info(f"Orders synced up to {end_time.strftime('%Y-%m-%d')}!")


# ============================================
# Incremental Orders Sync (Since Last Sync)
# ============================================

ORDERS_SYNC_LOOKBACK_DAYS = int(os.getenv("ORDERS_SYNC_LOOKBACK_DAYS", "30"))


async def run_incremental_orders_sync(session: AsyncSession):
    """
    Fetches orders updated since the last sync (BY_LAST_UPDATE report). The
    lookback window is wide enough that any order whose status changes within
    ~30 days of placement gets re-synced — so Pending → Shipped/Cancelled
    transitions don't freeze the row at its purchase-day status.
    """
    meta = await get_sync_meta(session)

    now = datetime.now(timezone.utc).replace(microsecond=0)

    lookback_start = now - timedelta(days=ORDERS_SYNC_LOOKBACK_DAYS)
    if meta.last_orders_sync:
        start_time = max(meta.last_orders_sync - timedelta(hours=1), lookback_start)
    else:
        start_time = lookback_start

    logger.info(f"Incremental orders sync: {start_time.isoformat()} → {now.isoformat()} (BY_LAST_UPDATE)")

    await fetch_orders_date_range(session, start_time, now, by_last_update=True)

    # Update the sync timestamp
    await update_orders_sync_time(session, now)
    logger.info("Incremental orders sync complete!")


# ============================================
# Full Sync (Inventory + Incremental Orders)
# ============================================

async def run_product_specs_sync(session: AsyncSession):
    """
    Fetches product dimensions/weights from SP-API Catalog Items for any SKU
    that exists in orders but not in product_specifications.
    """
    from sqlalchemy import text as sa_text
    from urllib.parse import urlencode

    # Find SKUs missing specs
    result = await session.execute(sa_text("""
        SELECT o.sku, MAX(o.asin) as asin
        FROM orders o
        LEFT JOIN product_specifications ps ON o.sku = ps.sku
        WHERE o.sku IS NOT NULL AND o.asin IS NOT NULL AND ps.id IS NULL
        GROUP BY o.sku
    """))
    raw_missing = {row[0]: row[1] for row in result.all()}

    def is_valid_asin(value: str | None) -> bool:
        asin = (value or "").strip().upper()
        return len(asin) == 10 and asin.isalnum()

    missing = {
        sku: (asin or "").strip().upper()
        for sku, asin in raw_missing.items()
        if is_valid_asin(asin)
    }
    invalid_asin_count = len(raw_missing) - len(missing)

    if not missing:
        if invalid_asin_count:
            logger.info("Skipped %s SKUs with invalid ASINs while syncing product specs.", invalid_asin_count)
        logger.info("All SKUs already have product specifications.")
        return

    if invalid_asin_count:
        logger.info("Skipped %s SKUs with invalid ASINs while syncing product specs.", invalid_asin_count)

    logger.info(f"Fetching specs for {len(missing)} missing SKUs from SP-API Catalog...")

    endpoint = os.getenv("SP_API_ENDPOINT", "https://sellingpartnerapi-eu.amazon.com").strip('"').strip("'")
    marketplace_id = os.getenv("SP_API_MARKETPLACE_ID", "A21TJRUUN4KGV")
    access_token = await get_amazon_access_token()

    all_skus = list(missing.keys())
    batch_size = 20

    for i in range(0, len(all_skus), batch_size):
        sku_batch = all_skus[i:i+batch_size]
        asin_batch = [missing[s] for s in sku_batch]

        try:
            params = {
                "marketplaceIds": marketplace_id,
                "identifiers": ",".join(asin_batch),
                "identifiersType": "ASIN",
                "includedData": "dimensions",
            }
            url = f"{endpoint}/catalog/2022-04-01/items?{urlencode(params)}"

            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(url, headers={"x-amz-access-token": access_token})
                if resp.status_code == 429:
                    logger.warning("Rate limit hit, sleeping 5s...")
                    await asyncio.sleep(5)
                    continue
                resp.raise_for_status()
                items = resp.json().get("items", [])

            asin_to_sku = {missing[s]: s for s in sku_batch}

            for item in items:
                asin = item.get("asin")
                if asin not in asin_to_sku:
                    continue
                sku = asin_to_sku[asin]

                # Extract dimensions — SP-API structure:
                #   dimensions[0].package.{height,length,width,weight}
                #   dimensions[0].item.{height,length,width,weight}
                #   attributes.item_package_weight[0].{unit,value}
                #   attributes.item_package_dimensions[0].{length,width,height}
                dims_list = item.get("dimensions", [])
                weight_kg = None
                length_cm = None
                width_cm = None
                height_cm = None

                def to_kg(val, unit):
                    if not val: return None
                    u = (unit or "").lower()
                    if u in ("kilograms", "kg"): return float(val)
                    if u in ("grams", "g"): return float(val) / 1000.0
                    if u in ("pounds", "lb", "lbs"): return float(val) * 0.453592
                    if u in ("ounces", "oz"): return float(val) * 0.0283495
                    return float(val)

                def to_cm(val, unit):
                    if not val: return None
                    u = (unit or "").lower()
                    if u in ("centimeters", "cm"): return float(val)
                    if u in ("meters", "m"): return float(val) * 100
                    if u in ("millimeters", "mm"): return float(val) / 10.0
                    if u in ("inches", "in", "inch"): return float(val) * 2.54
                    return float(val)

                if dims_list:
                    d0 = dims_list[0]
                    pkg = d0.get("package", {})
                    itm_d = d0.get("item", {})
                    src = pkg if pkg else itm_d
                    if src.get("weight"):
                        weight_kg = to_kg(src["weight"].get("value"), src["weight"].get("unit"))
                    if src.get("length"):
                        length_cm = to_cm(src["length"].get("value"), src["length"].get("unit"))
                    if src.get("width"):
                        width_cm = to_cm(src["width"].get("value"), src["width"].get("unit"))
                    if src.get("height"):
                        height_cm = to_cm(src["height"].get("value"), src["height"].get("unit"))
                    # Fallback to item dims if package incomplete
                    if itm_d:
                        if not weight_kg and itm_d.get("weight"):
                            weight_kg = to_kg(itm_d["weight"].get("value"), itm_d["weight"].get("unit"))
                        if not length_cm and itm_d.get("length"):
                            length_cm = to_cm(itm_d["length"].get("value"), itm_d["length"].get("unit"))
                        if not width_cm and itm_d.get("width"):
                            width_cm = to_cm(itm_d["width"].get("value"), itm_d["width"].get("unit"))
                        if not height_cm and itm_d.get("height"):
                            height_cm = to_cm(itm_d["height"].get("value"), itm_d["height"].get("unit"))

                # Attributes fallback
                attrs = item.get("attributes", {})
                if not weight_kg:
                    for key in ["item_package_weight", "item_weight"]:
                        vals = attrs.get(key, [])
                        if vals and vals[0].get("value"):
                            weight_kg = to_kg(vals[0]["value"], vals[0].get("unit"))
                            break
                if not length_cm or not width_cm or not height_cm:
                    for key in ["item_package_dimensions", "item_dimensions"]:
                        vals = attrs.get(key, [])
                        if vals:
                            dd = vals[0]
                            if not length_cm and dd.get("length"):
                                length_cm = to_cm(dd["length"].get("value"), dd["length"].get("unit"))
                            if not width_cm and dd.get("width"):
                                width_cm = to_cm(dd["width"].get("value"), dd["width"].get("unit"))
                            if not height_cm and dd.get("height"):
                                height_cm = to_cm(dd["height"].get("value"), dd["height"].get("unit"))

                vol_wt = round(length_cm * width_cm * height_cm / 5000.0, 3) if all([length_cm, width_cm, height_cm]) else None
                chargeable = round(max(weight_kg or 0, vol_wt or 0), 3) if (weight_kg or vol_wt) else None

                product_name = None
                if item.get("summaries"):
                    product_name = item["summaries"][0].get("itemName")

                await session.execute(sa_text("""
                    INSERT INTO product_specifications (sku, asin, product_name, weight_kg, length_cm, width_cm, height_cm, volumetric_weight_kg, chargeable_weight_kg)
                    VALUES (:sku, :asin, :name, :wt, :l, :w, :h, :vw, :cw)
                    ON CONFLICT (sku) DO UPDATE SET
                        asin=EXCLUDED.asin, product_name=EXCLUDED.product_name,
                        weight_kg=EXCLUDED.weight_kg, length_cm=EXCLUDED.length_cm,
                        width_cm=EXCLUDED.width_cm, height_cm=EXCLUDED.height_cm,
                        volumetric_weight_kg=EXCLUDED.volumetric_weight_kg,
                        chargeable_weight_kg=EXCLUDED.chargeable_weight_kg,
                        last_updated=NOW()
                """), {
                    "sku": sku, "asin": asin, "name": product_name,
                    "wt": weight_kg, "l": length_cm, "w": width_cm, "h": height_cm,
                    "vw": vol_wt, "cw": chargeable,
                })

            await session.commit()
            logger.info(f"Specs batch {i//batch_size + 1}: saved {len(items)} items")
            await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"Product specs batch error: {e}")

    logger.info("Product specifications sync complete.")


def _extract_money_amount(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return abs(float(value))
    if isinstance(value, dict):
        for key in ("CurrencyAmount", "currencyAmount", "Amount", "amount", "value"):
            if key in value and value[key] is not None:
                try:
                    return abs(float(value[key]))
                except (TypeError, ValueError):
                    continue
    try:
        return abs(float(value))
    except (TypeError, ValueError):
        return 0.0


def _is_shipping_fee_type(fee_type: str | None) -> bool:
    normalized = (fee_type or "").replace(" ", "").replace("_", "").lower()
    if not normalized:
        return False
    if any(keyword in normalized for keyword in AMAZON_FEE_EXCLUDE_KEYWORDS):
        return False
    return any(keyword in normalized for keyword in AMAZON_FEE_INCLUDE_KEYWORDS)


def _is_referral_fee_type(fee_type: str | None) -> bool:
    normalized = (fee_type or "").replace(" ", "").replace("_", "").lower()
    if not normalized:
        return False
    return any(keyword in normalized for keyword in AMAZON_REFERRAL_FEE_INCLUDE_KEYWORDS)


def _extract_referral_fee_total(fees) -> float:
    total = 0.0
    for fee in fees or []:
        if not isinstance(fee, dict):
            continue
        fee_type = (
            fee.get("FeeType")
            or fee.get("feeType")
            or fee.get("Type")
            or fee.get("type")
        )
        if not _is_referral_fee_type(str(fee_type or "")):
            continue
        amount = (
            fee.get("FeeAmount")
            or fee.get("feeAmount")
            or fee.get("Amount")
            or fee.get("amount")
        )
        total += _extract_money_amount(amount)
    return round(total, 2)


def _extract_shipping_fee_total(fees) -> float:
    total = 0.0
    for fee in fees or []:
        if not isinstance(fee, dict):
            continue
        fee_type = (
            fee.get("FeeType")
            or fee.get("feeType")
            or fee.get("Type")
            or fee.get("type")
        )
        if not _is_shipping_fee_type(str(fee_type or "")):
            continue
        amount = (
            fee.get("FeeAmount")
            or fee.get("feeAmount")
            or fee.get("Amount")
            or fee.get("amount")
        )
        total += _extract_money_amount(amount)
    return round(total, 2)


def _extract_amazon_financial_breakdown(financial_events: dict) -> dict[str, dict[str, float]]:
    """Return per-SKU {'shipping': X, 'referral': Y} from a financialEvents payload."""
    payload = financial_events.get("payload") if isinstance(financial_events, dict) else None
    events = payload.get("FinancialEvents") if isinstance(payload, dict) else None
    if not isinstance(events, dict):
        events = financial_events.get("FinancialEvents") if isinstance(financial_events, dict) else {}
    if not isinstance(events, dict):
        return {}

    shipping: defaultdict[str, float] = defaultdict(float)
    referral: defaultdict[str, float] = defaultdict(float)

    event_lists = []
    for key in ("ShipmentEventList", "ShipmentSettleEventList"):
        values = events.get(key)
        if isinstance(values, list):
            event_lists.extend(values)

    for event in event_lists:
        if not isinstance(event, dict):
            continue

        event_fees = event.get("FeeList") or event.get("feeList") or []
        event_shipping_total = _extract_shipping_fee_total(event_fees)
        event_referral_total = _extract_referral_fee_total(event_fees)
        event_item_skus: set[str] = set()

        for item_key in ("ShipmentItemList", "ShipmentItemAdjustmentList"):
            items = event.get(item_key)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                sku = (
                    item.get("SellerSKU")
                    or item.get("sellerSKU")
                    or item.get("Sku")
                    or item.get("sku")
                )
                if not sku:
                    continue
                event_item_skus.add(str(sku))
                item_fees = item.get("ItemFeeList") or item.get("itemFeeList") or []
                ship = _extract_shipping_fee_total(item_fees)
                ref = _extract_referral_fee_total(item_fees)
                if ship > 0:
                    shipping[str(sku)] += ship
                if ref > 0:
                    referral[str(sku)] += ref

        if len(event_item_skus) == 1:
            sku_single = next(iter(event_item_skus))
            if event_shipping_total > 0:
                shipping[sku_single] += event_shipping_total
            if event_referral_total > 0:
                referral[sku_single] += event_referral_total

    result: dict[str, dict[str, float]] = {}
    for sku in set(shipping) | set(referral):
        result[sku] = {
            "shipping": round(shipping.get(sku, 0.0), 2),
            "referral": round(referral.get(sku, 0.0), 2),
        }
    return result


def _extract_amazon_shipping_costs(financial_events: dict) -> dict[str, float]:
    return {
        sku: entry["shipping"]
        for sku, entry in _extract_amazon_financial_breakdown(financial_events).items()
        if entry.get("shipping", 0) > 0
    }


async def fetch_amazon_order_financial_breakdown(
    client: httpx.AsyncClient,
    access_token: str,
    order_id: str,
) -> dict[str, dict[str, float]]:
    """Return per-SKU {'shipping': X, 'referral': Y} for a given Amazon order."""
    endpoint = os.getenv("SP_API_ENDPOINT", "https://sellingpartnerapi-eu.amazon.com").strip('"').strip("'")
    try:
        response = None
        backoff_seconds = AMAZON_FINANCE_LOOKUP_DELAY_SECONDS
        for attempt in range(AMAZON_FINANCE_LOOKUP_MAX_RETRIES + 1):
            response = await client.get(
                f"{endpoint}/finances/v0/orders/{order_id}/financialEvents",
                headers={"x-amz-access-token": access_token},
            )
            if response.status_code == 404:
                return {}
            if response.status_code != 429:
                break
            if attempt >= AMAZON_FINANCE_LOOKUP_MAX_RETRIES:
                break
            logger.warning(
                "Finance lookup throttled for %s; retrying in %.1fs (%s/%s)",
                order_id,
                backoff_seconds,
                attempt + 1,
                AMAZON_FINANCE_LOOKUP_MAX_RETRIES,
            )
            await asyncio.sleep(backoff_seconds)
            backoff_seconds *= AMAZON_FINANCE_LOOKUP_BACKOFF_MULTIPLIER
        if response is None:
            return {}
        if response.status_code >= 400:
            logger.warning(f"Finance lookup failed for {order_id}: {response.status_code} {response.text[:200]}")
            return {}
        return _extract_amazon_financial_breakdown(response.json())
    except Exception as exc:
        logger.warning(f"Finance lookup error for {order_id}: {exc}")
        return {}


async def fetch_amazon_order_financial_shipping_costs(
    client: httpx.AsyncClient,
    access_token: str,
    order_id: str,
) -> dict[str, float]:
    breakdown = await fetch_amazon_order_financial_breakdown(client, access_token, order_id)
    return {sku: entry["shipping"] for sku, entry in breakdown.items() if entry.get("shipping", 0) > 0}


async def recalculate_profitability_for_orders(session: AsyncSession, order_ids: list[str]):
    if not order_ids:
        return

    shipping_expr = """
      CASE
        WHEN LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
          OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
        THEN COALESCE(
          NULLIF(o.shipping_price, 0),
          NULLIF((
            SELECT CASE WHEN se.rate_source = 'sp_api_finance'
                        THEN NULLIF(se.amazon_shipping_cost, 0) END
            FROM shipment_estimates se
            WHERE se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
            LIMIT 1
          ), 0),
          0
        )
        ELSE COALESCE(
          NULLIF(o.shipping_price, 0),
          NULLIF((
            SELECT CASE WHEN se.rate_source = 'shiprocket'
                        THEN se.cheapest_cost END
            FROM shipment_estimates se
            WHERE se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
            LIMIT 1
          ), 0),
          0
        )
      END
    """
    cogs_expr = """
      COALESCE(
        o.cogs_price,
        (
          SELECT ec.final_price
          FROM estimated_cogs ec
          WHERE ec.sku = o.sku
          LIMIT 1
        ),
        0
      )
    """
    fee_expr = """
      CASE
        WHEN o.amazon_fee IS NOT NULL AND o.amazon_fee > 0
          THEN o.amazon_fee
        ELSE 0
      END
    """
    marketing_expr = """
      COALESCE(
        (
          SELECT ec.marketing_cost
          FROM estimated_cogs ec
          WHERE ec.sku = o.sku
          LIMIT 1
        ),
        0
      )
    """

    result = await session.execute(sa_text(f"""
      UPDATE orders o
      SET
        cogs_price = COALESCE(
          o.cogs_price,
          (
            SELECT ec.final_price
            FROM estimated_cogs ec
            WHERE ec.sku = o.sku
            LIMIT 1
          )
        ),
        profit = CASE
          WHEN o.order_status IN ('Cancelled', 'Returned') THEN
            -2 * ({shipping_expr})
          WHEN o.amazon_fee IS NULL OR o.amazon_fee <= 0 THEN
            NULL
          ELSE
            o.item_price
            - ({cogs_expr})
            - ({fee_expr})
            - ({shipping_expr})
            - ({marketing_expr})
        END
      WHERE o.amazon_order_id = ANY(:order_ids)
    """), {"order_ids": order_ids})
    await session.commit()
    if result.rowcount:
        logger.info(f"Recalculated profitability for {result.rowcount} order row(s)")


async def recalculate_profitability_all(session: AsyncSession) -> int:
    """Recomputes orders.cogs_price and orders.profit for every order row using the same
    formula as the profitability dashboard (SP-API only for Amazon-fulfilled)."""
    shipping_expr = """
      CASE
        WHEN LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
          OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
        THEN COALESCE(
          NULLIF(o.shipping_price, 0),
          NULLIF((
            SELECT CASE WHEN se.rate_source = 'sp_api_finance'
                        THEN NULLIF(se.amazon_shipping_cost, 0) END
            FROM shipment_estimates se
            WHERE se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
            LIMIT 1
          ), 0),
          0
        )
        ELSE COALESCE(
          NULLIF(o.shipping_price, 0),
          NULLIF((
            SELECT CASE WHEN se.rate_source = 'shiprocket'
                        THEN se.cheapest_cost END
            FROM shipment_estimates se
            WHERE se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
            LIMIT 1
          ), 0),
          0
        )
      END
    """
    cogs_expr = """
      COALESCE(
        o.cogs_price,
        (SELECT ec.final_price FROM estimated_cogs ec WHERE ec.sku = o.sku LIMIT 1),
        0
      )
    """
    fee_expr = """
      CASE
        WHEN o.amazon_fee IS NOT NULL AND o.amazon_fee > 0
          THEN o.amazon_fee
        ELSE 0
      END
    """
    marketing_expr = """
      COALESCE(
        (SELECT ec.marketing_cost FROM estimated_cogs ec WHERE ec.sku = o.sku LIMIT 1),
        0
      )
    """

    result = await session.execute(sa_text(f"""
      UPDATE orders o
      SET
        cogs_price = COALESCE(
          o.cogs_price,
          (SELECT ec.final_price FROM estimated_cogs ec WHERE ec.sku = o.sku LIMIT 1)
        ),
        profit = CASE
          WHEN o.order_status IN ('Cancelled', 'Returned') THEN
            -2 * ({shipping_expr})
          WHEN o.amazon_fee IS NULL OR o.amazon_fee <= 0 THEN
            NULL
          ELSE
            o.item_price
            - ({cogs_expr})
            - ({fee_expr})
            - ({shipping_expr})
            - ({marketing_expr})
        END
      WHERE o.item_price IS NOT NULL
    """))
    await session.commit()
    logger.info(f"Recalculated profitability for {result.rowcount} order row(s) [full]")
    return result.rowcount or 0


def _find_existing_carrier_cheapest(order: dict) -> tuple[str | None, float | None]:
    candidates: list[tuple[str, float]] = []
    for provider, key in (
        ("Delhivery", "delhivery_cost"),
        ("BlueDart", "bluedart_cost"),
        ("DTDC", "dtdc_cost"),
        ("Xpressbees", "xpressbees_cost"),
        ("Ekart", "ekart_cost"),
    ):
        cost = float(order.get(key) or 0)
        if cost > 0:
            candidates.append((provider, round(cost, 2)))
    if not candidates:
        return None, None
    candidates.sort(key=lambda item: item[1])
    return candidates[0]


async def run_shipment_sync(session: AsyncSession, missing_only: bool = False):
    where_extra = (
        "AND se.id IS NULL"
        if missing_only
        else """AND (
          se.id IS NULL
          OR (
            (
              LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
              OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
            )
            AND (
              COALESCE(o.shipping_price, 0) <= 0
              OR COALESCE(se.amazon_shipping_cost, 0) <= 0
            )
          )
          OR (
            NOT (
              LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
              OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
            )
            AND se.rate_source = 'shiprocket_failed'
          )
        )"""
    )
    orders_result = await session.execute(sa_text(f"""
      SELECT
        o.amazon_order_id,
        o.sku,
        o.purchase_date,
        o.fulfillment_channel,
        o.ship_postal_code,
        o.ship_city,
        o.ship_state,
        o.shipping_price AS recorded_amazon_shipping_cost,
        se.id AS shipment_estimate_id,
        se.amazon_shipping_cost AS existing_estimated_amazon_cost,
        se.cheapest_provider,
        se.cheapest_cost,
        se.delhivery_cost,
        se.bluedart_cost,
        se.dtdc_cost,
        se.xpressbees_cost,
        se.ekart_cost,
        ps.weight_kg,
        ps.volumetric_weight_kg,
        ps.chargeable_weight_kg,
        ps.length_cm,
        ps.width_cm,
        ps.height_cm
      FROM orders o
      LEFT JOIN shipment_estimates se
        ON se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
      LEFT JOIN product_specifications ps
        ON ps.sku = o.sku
      WHERE o.ship_postal_code IS NOT NULL
        AND o.ship_postal_code != ''
        {where_extra}
      ORDER BY (se.id IS NULL) DESC, o.purchase_date DESC NULLS LAST, o.amazon_order_id DESC, o.sku
      LIMIT :limit
    """), {"limit": SHIPMENT_SYNC_BATCH_SIZE})
    orders = [dict(row) for row in orders_result.mappings().all()]

    if not orders:
        logger.info("Shipment sync skipped: no eligible orders need shipment refresh.")
        return

    amazon_order_ids = []
    for row in orders:
        if (
            is_amazon_fulfilled(row.get("fulfillment_channel"))
            and float(row.get("recorded_amazon_shipping_cost") or 0) <= 0
            and row.get("amazon_order_id") not in amazon_order_ids
        ):
            amazon_order_ids.append(row["amazon_order_id"])
        if AMAZON_FINANCE_LOOKUP_LIMIT > 0 and len(amazon_order_ids) >= AMAZON_FINANCE_LOOKUP_LIMIT:
            break

    finance_breakdown: dict[str, dict[str, dict[str, float]]] = {}
    if amazon_order_ids:
        access_token = await get_amazon_access_token()
        async with httpx.AsyncClient(timeout=30) as client:
            for index, order_id in enumerate(amazon_order_ids):
                finance_breakdown[order_id] = await fetch_amazon_order_financial_breakdown(
                    client,
                    access_token,
                    order_id,
                )
                if index < len(amazon_order_ids) - 1:
                    await asyncio.sleep(AMAZON_FINANCE_LOOKUP_DELAY_SECONDS)

    estimated = 0
    shiprocket_count = 0
    shiprocket_failed_count = 0
    actual_amazon_count = 0
    touched_order_ids: set[str] = set()

    for order in orders:
        dest_pin = normalize_pincode(order.get("ship_postal_code"))
        if len(dest_pin) != 6:
            continue

        actual_weight = float(order.get("weight_kg") or 0.5)
        volumetric_weight = order.get("volumetric_weight_kg")
        chargeable_weight = float(order.get("chargeable_weight_kg") or actual_weight or 0.5)

        is_amz = is_amazon_fulfilled(order.get("fulfillment_channel"))
        sku_breakdown = finance_breakdown.get(order["amazon_order_id"], {}).get(order["sku"], {})
        finance_cost = float(sku_breakdown.get("shipping") or 0.0)
        finance_referral = float(sku_breakdown.get("referral") or 0.0)
        recorded_cost = float(order.get("recorded_amazon_shipping_cost") or 0)
        has_existing_row = order.get("shipment_estimate_id") is not None

        if is_amz:
            has_sp_api_data = finance_cost > 0 or recorded_cost > 0

            if not has_sp_api_data:
                # Amazon-fulfilled without SP-API finance data.
                if has_existing_row:
                    cheapest_provider, cheapest_cost = _find_existing_carrier_cheapest(order)
                    await session.execute(sa_text("""
                      UPDATE shipment_estimates
                      SET
                        amazon_shipping_cost = 0,
                        cheapest_provider = :cheapest_provider,
                        cheapest_cost = :cheapest_cost,
                        estimated_at = NOW()
                      WHERE amazon_order_id = :amazon_order_id AND sku = :sku
                    """), {
                        "amazon_order_id": order["amazon_order_id"],
                        "sku": order["sku"],
                        "cheapest_provider": cheapest_provider,
                        "cheapest_cost": cheapest_cost,
                    })
                    touched_order_ids.add(order["amazon_order_id"])
                    estimated += 1
                    continue
                # No row yet — insert a minimal placeholder so the order shows up in UI.
                await session.execute(sa_text("""
                  INSERT INTO shipment_estimates (
                    amazon_order_id, sku, origin_pincode,
                    destination_pincode, destination_city, destination_state,
                    package_weight_kg, volumetric_weight_kg, chargeable_weight_kg,
                    amazon_shipping_cost, rate_source, estimated_at
                  ) VALUES (
                    :amazon_order_id, :sku, :origin_pincode,
                    :destination_pincode, :destination_city, :destination_state,
                    :package_weight_kg, :volumetric_weight_kg, :chargeable_weight_kg,
                    0, 'sp_api_pending', NOW()
                  )
                  ON CONFLICT (amazon_order_id, sku) DO NOTHING
                """), {
                    "amazon_order_id": order["amazon_order_id"],
                    "sku": order["sku"],
                    "origin_pincode": normalize_pincode(ORIGIN_PINCODE) or ORIGIN_PINCODE,
                    "destination_pincode": dest_pin,
                    "destination_city": order.get("ship_city"),
                    "destination_state": order.get("ship_state"),
                    "package_weight_kg": actual_weight,
                    "volumetric_weight_kg": volumetric_weight,
                    "chargeable_weight_kg": chargeable_weight,
                })
                estimated += 1
                continue

            # Amazon-fulfilled WITH SP-API data — targeted update of amazon_shipping_cost.
            actual_amazon_cost = finance_cost or recorded_cost

            if finance_cost > 0 and abs(finance_cost - recorded_cost) > 0.01:
                await session.execute(sa_text("""
                  UPDATE orders
                  SET shipping_price = :shipping_price
                  WHERE amazon_order_id = :amazon_order_id AND sku = :sku
                """), {
                    "shipping_price": finance_cost,
                    "amazon_order_id": order["amazon_order_id"],
                    "sku": order["sku"],
                })
            if finance_referral > 0:
                await session.execute(sa_text("""
                  UPDATE orders
                  SET amazon_fee = :amazon_fee
                  WHERE amazon_order_id = :amazon_order_id AND sku = :sku
                """), {
                    "amazon_fee": finance_referral,
                    "amazon_order_id": order["amazon_order_id"],
                    "sku": order["sku"],
                })

            # Insert-if-new-or-update-just-amazon-cost. Carrier columns and rate_source
            # are preserved on existing rows so user-recalc'd Shiprocket data isn't wiped.
            await session.execute(sa_text("""
              INSERT INTO shipment_estimates (
                amazon_order_id, sku, origin_pincode,
                destination_pincode, destination_city, destination_state,
                package_weight_kg, volumetric_weight_kg, chargeable_weight_kg,
                amazon_shipping_cost, cheapest_provider, cheapest_cost,
                rate_source, estimated_at
              ) VALUES (
                :amazon_order_id, :sku, :origin_pincode,
                :destination_pincode, :destination_city, :destination_state,
                :package_weight_kg, :volumetric_weight_kg, :chargeable_weight_kg,
                CAST(:amazon_shipping_cost AS DOUBLE PRECISION),
                CASE WHEN CAST(:amazon_shipping_cost AS DOUBLE PRECISION) > 0 THEN 'Amazon' ELSE NULL END,
                CASE WHEN CAST(:amazon_shipping_cost AS DOUBLE PRECISION) > 0 THEN CAST(:amazon_shipping_cost AS DOUBLE PRECISION) ELSE NULL END,
                'sp_api_finance', NOW()
              )
              ON CONFLICT (amazon_order_id, sku) DO UPDATE SET
                amazon_shipping_cost = EXCLUDED.amazon_shipping_cost,
                cheapest_provider = CASE
                  WHEN EXCLUDED.amazon_shipping_cost > 0
                       AND (shipment_estimates.cheapest_cost IS NULL
                            OR EXCLUDED.amazon_shipping_cost < shipment_estimates.cheapest_cost)
                  THEN 'Amazon'
                  ELSE shipment_estimates.cheapest_provider
                END,
                cheapest_cost = CASE
                  WHEN EXCLUDED.amazon_shipping_cost > 0
                       AND (shipment_estimates.cheapest_cost IS NULL
                            OR EXCLUDED.amazon_shipping_cost < shipment_estimates.cheapest_cost)
                  THEN EXCLUDED.amazon_shipping_cost
                  ELSE shipment_estimates.cheapest_cost
                END,
                estimated_at = NOW()
            """), {
                "amazon_order_id": order["amazon_order_id"],
                "sku": order["sku"],
                "origin_pincode": normalize_pincode(ORIGIN_PINCODE) or ORIGIN_PINCODE,
                "destination_pincode": dest_pin,
                "destination_city": order.get("ship_city"),
                "destination_state": order.get("ship_state"),
                "package_weight_kg": actual_weight,
                "volumetric_weight_kg": volumetric_weight,
                "chargeable_weight_kg": chargeable_weight,
                "amazon_shipping_cost": actual_amazon_cost,
            })
            actual_amazon_count += 1
            touched_order_ids.add(order["amazon_order_id"])
            estimated += 1
            continue

        # Merchant-fulfilled — fetch Shiprocket live rates and do full UPSERT.
        dims = {}
        if order.get("length_cm"):
            dims["length"] = order["length_cm"]
        if order.get("width_cm"):
            dims["breadth"] = order["width_cm"]
        if order.get("height_cm"):
            dims["height"] = order["height_cm"]
        rates, source = await get_shipping_rates_with_source(
            ORIGIN_PINCODE, dest_pin, chargeable_weight, dims or None
        )
        if source == "shiprocket":
            shiprocket_count += 1
        else:
            shiprocket_failed_count += 1
        amazon_cost = 0.0
        cheapest_provider, cheapest_cost = find_cheapest(rates, amazon_cost)

        await session.execute(sa_text("""
          INSERT INTO shipment_estimates (
            amazon_order_id, sku, origin_pincode,
            destination_pincode, destination_city, destination_state,
            package_weight_kg, volumetric_weight_kg, chargeable_weight_kg,
            amazon_shipping_cost,
            delhivery_cost, bluedart_cost, dtdc_cost, xpressbees_cost, ekart_cost,
            delhivery_etd, bluedart_etd, dtdc_etd, xpressbees_etd, ekart_etd,
            cheapest_provider, cheapest_cost, rate_source, estimated_at
          ) VALUES (
            :amazon_order_id, :sku, :origin_pincode,
            :destination_pincode, :destination_city, :destination_state,
            :package_weight_kg, :volumetric_weight_kg, :chargeable_weight_kg,
            :amazon_shipping_cost,
            :delhivery_cost, :bluedart_cost, :dtdc_cost, :xpressbees_cost, :ekart_cost,
            :delhivery_etd, :bluedart_etd, :dtdc_etd, :xpressbees_etd, :ekart_etd,
            :cheapest_provider, :cheapest_cost, :rate_source, NOW()
          )
          ON CONFLICT (amazon_order_id, sku) DO UPDATE SET
            destination_pincode = EXCLUDED.destination_pincode,
            destination_city = EXCLUDED.destination_city,
            destination_state = EXCLUDED.destination_state,
            package_weight_kg = EXCLUDED.package_weight_kg,
            volumetric_weight_kg = EXCLUDED.volumetric_weight_kg,
            chargeable_weight_kg = EXCLUDED.chargeable_weight_kg,
            amazon_shipping_cost = EXCLUDED.amazon_shipping_cost,
            delhivery_cost = EXCLUDED.delhivery_cost,
            bluedart_cost = EXCLUDED.bluedart_cost,
            dtdc_cost = EXCLUDED.dtdc_cost,
            xpressbees_cost = EXCLUDED.xpressbees_cost,
            ekart_cost = EXCLUDED.ekart_cost,
            delhivery_etd = EXCLUDED.delhivery_etd,
            bluedart_etd = EXCLUDED.bluedart_etd,
            dtdc_etd = EXCLUDED.dtdc_etd,
            xpressbees_etd = EXCLUDED.xpressbees_etd,
            ekart_etd = EXCLUDED.ekart_etd,
            cheapest_provider = EXCLUDED.cheapest_provider,
            cheapest_cost = EXCLUDED.cheapest_cost,
            rate_source = EXCLUDED.rate_source,
            estimated_at = NOW()
        """), {
            "amazon_order_id": order["amazon_order_id"],
            "sku": order["sku"],
            "origin_pincode": normalize_pincode(ORIGIN_PINCODE) or ORIGIN_PINCODE,
            "destination_pincode": dest_pin,
            "destination_city": order.get("ship_city"),
            "destination_state": order.get("ship_state"),
            "package_weight_kg": actual_weight,
            "volumetric_weight_kg": volumetric_weight,
            "chargeable_weight_kg": chargeable_weight,
            "amazon_shipping_cost": amazon_cost or 0,
            "delhivery_cost": (rates.get("delhivery") or {}).get("cost"),
            "bluedart_cost": (rates.get("bluedart") or {}).get("cost"),
            "dtdc_cost": (rates.get("dtdc") or {}).get("cost"),
            "xpressbees_cost": (rates.get("xpressbees") or {}).get("cost"),
            "ekart_cost": (rates.get("ekart") or {}).get("cost"),
            "delhivery_etd": (rates.get("delhivery") or {}).get("etd"),
            "bluedart_etd": (rates.get("bluedart") or {}).get("etd"),
            "dtdc_etd": (rates.get("dtdc") or {}).get("etd"),
            "xpressbees_etd": (rates.get("xpressbees") or {}).get("etd"),
            "ekart_etd": (rates.get("ekart") or {}).get("etd"),
            "cheapest_provider": normalize_provider_name(cheapest_provider),
            "cheapest_cost": None if cheapest_cost == float("inf") else cheapest_cost,
            "rate_source": source,
        })

        touched_order_ids.add(order["amazon_order_id"])
        estimated += 1

    await session.commit()

    if touched_order_ids:
        await recalculate_profitability_for_orders(session, sorted(touched_order_ids))

    logger.info(
        "Shipment sync complete: %s rows refreshed (%s Shiprocket, %s Shiprocket-failed, %s Amazon actual)",
        estimated,
        shiprocket_count,
        shiprocket_failed_count,
        actual_amazon_count,
    )


POWERBI_SALES_INSERT_PAIRS = [
    ("Date", "date"),
    ("Year", "year"),
    ("Month_Num", "month_num"),
    ("Month_Name", "month_name"),
    ("Month_Year", "month_year"),
    ("Quarter", "quarter"),
    ("Quarter_Name", "quarter_name"),
    ("Business", "business"),
    ("Invoice Number", "invoice_number"),
    ("Invoice Date", "invoice_date"),
    ("Transaction Type", "transaction_type"),
    ("Order Id", "order_id"),
    ("Quantity", "quantity"),
    ("BRAND", "brand"),
    ("Item Description", "item_description"),
    ("Asin", "asin"),
    ("Sku", "sku"),
    ("Category", "category"),
    ("Segment", "segment"),
    ("Ship To City", "ship_to_city"),
    ("Ship To State", "ship_to_state"),
    ("Ship To Country", "ship_to_country"),
    ("Ship To Postal Code", "ship_to_postal_code"),
    ("Invoice Amount", "invoice_amount"),
    ("Principal Amount", "principal_amount"),
    ("Warehouse Id", "warehouse_id"),
    ("Customer Bill To Gstid", "customer_bill_to_gstid"),
    ("Buyer Name", "buyer_name"),
    ("Source", "source"),
    ("Channel", "channel"),
]

POWERBI_SALES_CREATE_SQL = """
  CREATE TABLE IF NOT EXISTS "PowerBISales" (
    "Date" DATE,
    "Year" INTEGER,
    "Month_Num" INTEGER,
    "Month_Name" TEXT,
    "Month_Year" TEXT,
    "Quarter" INTEGER,
    "Quarter_Name" TEXT,
    "Business" TEXT,
    "Invoice Number" TEXT,
    "Invoice Date" TIMESTAMP,
    "Transaction Type" TEXT,
    "Order Id" TEXT,
    "Quantity" NUMERIC(18, 2),
    "BRAND" TEXT,
    "Item Description" TEXT,
    "Asin" TEXT,
    "Sku" TEXT,
    "Category" TEXT,
    "Segment" TEXT,
    "Ship To City" TEXT,
    "Ship To State" TEXT,
    "Ship To Country" TEXT,
    "Ship To Postal Code" TEXT,
    "Invoice Amount" NUMERIC(18, 2),
    "Principal Amount" NUMERIC(18, 2),
    "Warehouse Id" TEXT,
    "Customer Bill To Gstid" TEXT,
    "Buyer Name" TEXT,
    "Source" TEXT,
    "Channel" TEXT
  )
"""

POWERBI_SALES_INSERT_SQL = f"""
  INSERT INTO "PowerBISales" (
    {", ".join(f'"{column}"' for column, _ in POWERBI_SALES_INSERT_PAIRS)}
  ) VALUES (
    {", ".join(f":{param}" for _, param in POWERBI_SALES_INSERT_PAIRS)}
  )
"""


def _invoice_text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _invoice_number(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    cleaned = str(value).replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return None


def _invoice_integer(value) -> int | None:
    number = _invoice_number(value)
    return int(number) if number is not None else None


def _invoice_datetime(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    text = str(value).strip()
    if not text:
        return None

    normalized = text.replace("T", " ").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo:
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        pass

    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%d-%m-%Y %H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
        "%d-%m-%Y",
        "%d/%m/%Y",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    return None


def _normalize_invoice_header(header: str | None) -> str:
    return "".join(ch.lower() for ch in str(header or "") if ch.isalnum())


def _normalized_invoice_row(row: dict) -> dict[str, str | None]:
    normalized = {}
    for key, value in row.items():
        normalized[_normalize_invoice_header(key)] = _invoice_text(value)
    return normalized


def _get_invoice_value(row: dict[str, str | None], *candidates: str) -> str | None:
    for candidate in candidates:
        value = row.get(_normalize_invoice_header(candidate))
        if value not in (None, ""):
            return value
    return None


def _first_day_of_month(value: datetime):
    return value.date().replace(day=1)


def _fy_label(value: datetime) -> str:
    fy_start = value.year if value.month >= 4 else value.year - 1
    return f"FY{fy_start}"


def _quarter(value: datetime) -> int:
    return ((value.month - 1) // 3) + 1


async def _ensure_powerbi_sales_table(session: AsyncSession):
    await session.execute(sa_text(POWERBI_SALES_CREATE_SQL))
    await session.execute(sa_text("""
      CREATE INDEX IF NOT EXISTS "ix_PowerBISales_InvoiceDate"
      ON "PowerBISales" ("Invoice Date")
    """))
    await session.execute(sa_text("""
      CREATE INDEX IF NOT EXISTS "ix_PowerBISales_OrderId"
      ON "PowerBISales" ("Order Id")
    """))
    await session.execute(sa_text("""
      CREATE INDEX IF NOT EXISTS "ix_PowerBISales_Sku"
      ON "PowerBISales" ("Sku")
    """))
    await session.commit()


async def _get_restricted_data_token(
    client: httpx.AsyncClient,
    access_token: str,
    path: str,
    method: str = "GET",
    data_elements: list[str] | None = None,
) -> str:
    endpoint = os.getenv("SP_API_ENDPOINT", "https://sellingpartnerapi-eu.amazon.com").strip('"').strip("'")
    resource: dict[str, object] = {"method": method, "path": path}
    if data_elements:
        resource["dataElements"] = list(data_elements)
    response = await client.post(
        f"{endpoint}/tokens/2021-03-01/restrictedDataToken",
        headers={
            "x-amz-access-token": access_token,
            "Content-Type": "application/json",
        },
        json={"restrictedResources": [resource]},
    )
    if response.status_code >= 400:
        raise ValueError(f"Failed to get restricted data token: {response.status_code} {response.text[:250]}")
    return response.json()["restrictedDataToken"]


# GST MTR reports contain buyer PII (name, GSTIN, address). Per Amazon SP-API,
# the createReport call itself must be authorised with a Restricted Data Token
# carrying the relevant dataElements — a regular LWA token returns 403.
GST_REPORT_DATA_ELEMENTS = ["buyerInfo", "shippingAddress"]
RESTRICTED_REPORT_TYPES = {
    "GET_GST_MTR_B2B_CUSTOM",
    "GET_GST_MTR_B2C_CUSTOM",
}


async def _request_report_rows(
    report_type: str,
    start_time: datetime,
    end_time: datetime,
) -> list[dict[str, str | None]]:
    endpoint = os.getenv("SP_API_ENDPOINT")
    if not endpoint:
        raise ValueError("Missing SP_API_ENDPOINT in environment")
    endpoint = endpoint.strip('"').strip("'")

    access_token = await get_amazon_access_token()
    headers = {"x-amz-access-token": access_token, "Content-Type": "application/json"}
    is_restricted = report_type in RESTRICTED_REPORT_TYPES

    async with httpx.AsyncClient(timeout=90.0) as client:
        create_payload = {
            "reportType": report_type,
            "marketplaceIds": [os.getenv("SP_API_MARKETPLACE_ID")],
            "dataStartTime": start_time.isoformat(),
            "dataEndTime": end_time.isoformat(),
        }

        response = await client.post(
            f"{endpoint}/reports/2021-06-30/reports",
            headers=headers,
            json=create_payload,
        )
        if response.status_code >= 400:
            hint = ""
            if is_restricted and response.status_code == 403:
                hint = (
                    " — Amazon returned 403 on a restricted GST report. The SP-API"
                    " application most likely does not have the 'Tax Invoicing'"
                    " role enabled, or the seller has not re-authorised the app"
                    " since that role was added. Enable the role in Developer"
                    " Central and reauthorise the seller."
                )
            raise ValueError(
                f"{report_type} request failed: {response.status_code} {response.text[:250]}{hint}"
            )

        report_id = response.json()["reportId"]
        logger.info("Requested %s report %s", report_type, report_id)

        status_data = None
        while True:
            await asyncio.sleep(15)
            poll_res = await client.get(
                f"{endpoint}/reports/2021-06-30/reports/{report_id}",
                headers={"x-amz-access-token": access_token},
            )
            if poll_res.status_code >= 400:
                raise ValueError(
                    f"{report_type} polling failed: {poll_res.status_code} {poll_res.text[:250]}"
                )
            status_data = poll_res.json()
            status = status_data.get("processingStatus")
            logger.info("Polling %s report %s: %s", report_type, report_id, status)

            if status == "DONE":
                break
            if status == "DONE_NO_DATA":
                return []
            if status in {"CANCELLED", "FATAL"}:
                raise ValueError(f"{report_type} failed with status {status}")

        report_document_id = status_data.get("reportDocumentId")
        if not report_document_id:
            return []

        document_path = f"/reports/2021-06-30/documents/{report_document_id}"
        restricted_token = await _get_restricted_data_token(
            client,
            access_token,
            document_path,
            data_elements=GST_REPORT_DATA_ELEMENTS if is_restricted else None,
        )
        doc_res = await client.get(
            f"{endpoint}{document_path}",
            headers={"x-amz-access-token": restricted_token},
        )
        if doc_res.status_code >= 400:
            raise ValueError(
                f"{report_type} document fetch failed: {doc_res.status_code} {doc_res.text[:250]}"
            )
        doc_data = doc_res.json()
        download_url = doc_data["url"]
        compression_algorithm = doc_data.get("compressionAlgorithm")

        file_res = await client.get(download_url, timeout=120.0)
        if file_res.status_code >= 400:
            raise ValueError(
                f"{report_type} download failed: {file_res.status_code} {file_res.text[:250]}"
            )

        content = file_res.content
        if compression_algorithm == "GZIP":
            content = zlib.decompress(content, zlib.MAX_WBITS | 32)

        text_data = content.decode("utf-8-sig", errors="replace")
        sample = "\n".join(text_data.splitlines()[:5])
        delimiter = "\t" if "\t" in sample else ","
        try:
            dialect = csv.Sniffer().sniff(sample or text_data[:1024], delimiters="\t,;|")
            delimiter = dialect.delimiter
        except csv.Error:
            pass

        reader = csv.DictReader(io.StringIO(text_data), delimiter=delimiter)
        return [{key: value for key, value in row.items()} for row in reader]


async def _load_invoice_sku_meta(session: AsyncSession) -> dict[str, dict[str, str | None]]:
    result = await session.execute(sa_text("""
      SELECT sku, brand, category
      FROM estimated_cogs
    """))
    return {
        row.sku: {
            "brand": row.brand,
            "category": row.category,
        }
        for row in result.mappings().all()
        if row.sku
    }


def _build_powerbi_sales_row(
    raw_row: dict[str, str | None],
    business_hint: str,
    sku_meta: dict[str, dict[str, str | None]],
) -> dict[str, object]:
    row = _normalized_invoice_row(raw_row)

    invoice_date = _invoice_datetime(
        _get_invoice_value(row, "Invoice Date", "Shipment Date", "Order Date")
    ) or datetime.utcnow()
    date_value = _first_day_of_month(invoice_date)
    sku = _get_invoice_value(row, "Sku", "SKU", "MsKU", "Seller SKU")
    meta = sku_meta.get(sku or "", {})

    invoice_amount = _invoice_number(
        _get_invoice_value(
            row,
            "Invoice Amount",
            "Invoice Value",
            "Total Invoice Amount",
            "Invoice Total",
            "Total Amount",
        )
    )
    principal_amount = _invoice_number(
        _get_invoice_value(
            row,
            "Principal Amount",
            "Principal",
            "Taxable Amount",
            "Item Amount",
            "Product Sales",
        )
    )
    if principal_amount is None and invoice_amount is not None:
        tax_amount = _invoice_number(
            _get_invoice_value(row, "Tax Amount", "Item Tax", "Tax")
        )
        if tax_amount is not None:
            principal_amount = round(invoice_amount - tax_amount, 2)

    quarter = _quarter(invoice_date)
    business = _get_invoice_value(row, "Business") or business_hint

    return {
        "date": date_value,
        "year": invoice_date.year,
        "month_num": invoice_date.month,
        "month_name": invoice_date.strftime("%B"),
        "month_year": invoice_date.strftime("%b %Y"),
        "quarter": quarter,
        "quarter_name": f"Q{quarter}",
        "business": business,
        "invoice_number": _get_invoice_value(row, "Invoice Number"),
        "invoice_date": invoice_date,
        "transaction_type": _get_invoice_value(row, "Transaction Type") or "Shipment",
        "order_id": _get_invoice_value(row, "Order Id", "Amazon Order Id", "Order ID"),
        "quantity": _invoice_number(_get_invoice_value(row, "Quantity")) or 0,
        "brand": _get_invoice_value(row, "Brand", "BRAND") or meta.get("brand"),
        "item_description": _get_invoice_value(row, "Item Description", "Product Description"),
        "asin": _get_invoice_value(row, "Asin", "ASIN"),
        "sku": sku,
        "category": _get_invoice_value(row, "Category") or meta.get("category"),
        "segment": _get_invoice_value(row, "Segment"),
        "ship_to_city": _get_invoice_value(row, "Ship To City"),
        "ship_to_state": _get_invoice_value(row, "Ship To State"),
        "ship_to_country": _get_invoice_value(row, "Ship To Country"),
        "ship_to_postal_code": _get_invoice_value(row, "Ship To Postal Code"),
        "invoice_amount": invoice_amount,
        "principal_amount": principal_amount,
        "warehouse_id": _get_invoice_value(row, "Warehouse Id", "Warehouse ID"),
        "customer_bill_to_gstid": _get_invoice_value(
            row,
            "Customer Bill To Gstid",
            "Buyer Gstin",
            "Customer GSTIN",
            "Customer Bill To GSTID",
        ),
        "buyer_name": _get_invoice_value(row, "Buyer Name", "Customer Name"),
        "source": _fy_label(invoice_date),
        "channel": _get_invoice_value(row, "Channel") or "Amazon",
    }


async def _replace_powerbi_sales_window(
    session: AsyncSession,
    rows: list[dict[str, object]],
    start_time: datetime,
    end_time: datetime,
):
    await _ensure_powerbi_sales_table(session)
    await session.execute(sa_text("""
      DELETE FROM "PowerBISales"
      WHERE COALESCE(CAST("Invoice Date" AS DATE), "Date")
        BETWEEN :start_date AND :end_date
        AND COALESCE("Channel", 'Amazon') = 'Amazon'
    """), {
        "start_date": start_time.date(),
        "end_date": end_time.date(),
    })

    if rows:
        batch_size = 500
        for index in range(0, len(rows), batch_size):
            await session.execute(sa_text(POWERBI_SALES_INSERT_SQL), rows[index:index + batch_size])

    await session.commit()


async def get_powerbi_sales_sync_status(session: AsyncSession):
    await _ensure_powerbi_sales_table(session)
    result = await session.execute(sa_text("""
      SELECT
        COUNT(*) AS row_count,
        MAX("Invoice Date") AS latest_invoice_date
      FROM "PowerBISales"
    """))
    row = result.mappings().first() or {}
    latest_invoice_date = row.get("latest_invoice_date")
    return {
        "tableExists": True,
        "rowCount": int(row.get("row_count") or 0),
        "sourceLabel": "Amazon GST reports (SP-API)",
        "latestInvoiceDate": latest_invoice_date.isoformat() if latest_invoice_date else None,
        "syncWindowDays": GST_INVOICE_LOOKBACK_DAYS,
    }


# Amazon SP-API GST MTR custom reports cap each request at 31 days; chunk
# anything longer so larger windows still go through.
GST_INVOICE_REPORT_MAX_CHUNK_DAYS = 30
# Hard ceiling on how far back a single Sync click can backfill. Prevents
# accidental multi-year refetches when the table has a stale latest date.
GST_INVOICE_BACKFILL_CEILING_DAYS = 365
# Overlap re-fetched on top of the latest synced invoice date, in case the
# tail of the previous sync was incomplete.
GST_INVOICE_OVERLAP_DAYS = 7


async def _get_latest_invoice_date(session: AsyncSession):
    await _ensure_powerbi_sales_table(session)
    result = await session.execute(
        sa_text('SELECT MAX("Invoice Date") FROM "PowerBISales"')
    )
    return result.scalar()


def _iter_invoice_chunks(
    start_time: datetime,
    end_time: datetime,
    max_chunk_days: int = GST_INVOICE_REPORT_MAX_CHUNK_DAYS,
):
    chunk_start = start_time
    delta = timedelta(days=max_chunk_days)
    while chunk_start < end_time:
        chunk_end = min(chunk_start + delta, end_time)
        yield chunk_start, chunk_end
        chunk_start = chunk_end


async def run_invoice_sync(
    session: AsyncSession,
    start_date: date | None = None,
    end_date: date | None = None,
):
    now_utc = datetime.now(timezone.utc).replace(microsecond=0)

    if start_date is not None and end_date is not None:
        if end_date < start_date:
            raise ValueError("endDate must be on or after startDate")
        start_time = datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc)
        end_time = datetime.combine(
            end_date + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc
        )
        if end_time > now_utc:
            end_time = now_utc
    else:
        end_time = now_utc
        default_start = (end_time - timedelta(days=max(1, GST_INVOICE_LOOKBACK_DAYS - 1))).replace(
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )

        latest_in_db = await _get_latest_invoice_date(session)
        if latest_in_db is not None:
            if isinstance(latest_in_db, datetime):
                latest_dt = (
                    latest_in_db
                    if latest_in_db.tzinfo
                    else latest_in_db.replace(tzinfo=timezone.utc)
                )
            else:
                latest_dt = datetime.combine(
                    latest_in_db, datetime.min.time(), tzinfo=timezone.utc
                )
            gap_start = (latest_dt - timedelta(days=GST_INVOICE_OVERLAP_DAYS)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            floor_start = end_time - timedelta(days=GST_INVOICE_BACKFILL_CEILING_DAYS)
            start_time = max(min(default_start, gap_start), floor_start)
        else:
            start_time = default_start

    sku_meta = await _load_invoice_sku_meta(session)
    all_rows: list[dict[str, object]] = []
    report_summaries: list[dict[str, object]] = []
    warnings: list[str] = []

    for chunk_start, chunk_end in _iter_invoice_chunks(start_time, end_time):
        chunk_rows: list[dict[str, object]] = []
        seen_keys: set[tuple[str, str, str, str, str]] = set()
        chunk_warnings: list[str] = []
        for report_type, business_hint in GST_INVOICE_REPORT_TYPES:
            try:
                report_rows = await _request_report_rows(report_type, chunk_start, chunk_end)
                report_summaries.append({
                    "reportType": report_type,
                    "business": business_hint,
                    "rows": len(report_rows),
                    "startDate": chunk_start.date().isoformat(),
                    "endDate": chunk_end.date().isoformat(),
                })
                for raw_row in report_rows:
                    row = _build_powerbi_sales_row(raw_row, business_hint, sku_meta)
                    dedupe_key = (
                        str(row.get("invoice_number") or ""),
                        str(row.get("order_id") or ""),
                        str(row.get("sku") or ""),
                        str(row.get("transaction_type") or ""),
                        str(row.get("business") or ""),
                    )
                    if dedupe_key in seen_keys:
                        continue
                    seen_keys.add(dedupe_key)
                    chunk_rows.append(row)
            except Exception as exc:
                warning = f"{report_type} {chunk_start.date()}–{chunk_end.date()}: {exc}"
                logger.warning("Invoice sync warning: %s", warning)
                chunk_warnings.append(warning)

        warnings.extend(chunk_warnings)
        # Only replace the chunk window when every report for that chunk
        # succeeded — otherwise a partial failure would silently delete the
        # business rows we couldn't refetch.
        if not chunk_warnings:
            await _replace_powerbi_sales_window(session, chunk_rows, chunk_start, chunk_end)
            all_rows.extend(chunk_rows)

    if not all_rows and warnings:
        raise ValueError("; ".join(warnings))

    status = await get_powerbi_sales_sync_status(session)
    return {
        **status,
        "message": f"Synced {len(all_rows):,} invoice row(s) from Amazon GST reports.",
        "syncedRows": len(all_rows),
        "startDate": start_time.date().isoformat(),
        "endDate": end_time.date().isoformat(),
        "reports": report_summaries,
        "warnings": warnings,
    }


async def get_amazon_current_prices(asins: list[str]) -> dict[str, float | None]:
    """
    Fetches current Amazon listing prices for a list of ASINs using the SP-API Pricing endpoint.
    Returns a dict mapping ASIN → listing price (or None if unavailable).
    Batches requests in groups of 20 (API limit).
    """
    return await _fetch_amazon_prices(asins, item_type="Asin", param_name="Asins")


async def get_amazon_prices_by_sku(skus: list[str], sku_to_asin: dict[str, str]) -> dict[str, float | None]:
    """
    Fetches current Amazon listing prices for a list of Seller SKUs.
    Uses ASIN-based batch pricing (which works reliably) and maps results back to SKUs.

    Args:
        skus: list of seller SKUs to fetch prices for
        sku_to_asin: pre-built mapping of SKU → ASIN (from DB lookups)

    Returns: dict mapping SKU → listing price (or None if unavailable).
    """
    # Build the list of ASINs we can look up, tracking ASIN→SKU(s) mapping
    asin_to_skus: dict[str, list[str]] = {}
    skus_without_asin: list[str] = []

    for sku in skus:
        asin = sku_to_asin.get(sku)
        if asin:
            asin_to_skus.setdefault(asin, []).append(sku)
        else:
            skus_without_asin.append(sku)

    if skus_without_asin:
        logger.warning(f"{len(skus_without_asin)} SKUs have no ASIN mapping, cannot fetch prices: {skus_without_asin[:10]}...")

    # Fetch prices by ASIN (the reliable batch approach)
    asins = list(asin_to_skus.keys())
    asin_prices = await get_amazon_current_prices(asins) if asins else {}

    # Map ASIN prices back to SKUs
    results: dict[str, float | None] = {}
    for asin, price in asin_prices.items():
        for sku in asin_to_skus.get(asin, []):
            results[sku] = price

    # Fill in None for SKUs we couldn't look up
    for sku in skus:
        results.setdefault(sku, None)

    return results


def _extract_price_from_product(product: dict) -> float | None:
    """Extract price from SP-API product pricing response."""
    # Source 1: Offers[].BuyingPrice.ListingPrice
    offers = product.get("Offers", [])
    for offer in offers:
        listing = offer.get("BuyingPrice", {}).get("ListingPrice", {})
        amount = listing.get("Amount")
        if amount is not None:
            return float(amount)

    # Source 2: CompetitivePricing.CompetitivePrices[].Price.ListingPrice
    comp_prices = (
        product.get("CompetitivePricing", {})
        .get("CompetitivePrices", [])
    )
    for cp in comp_prices:
        listing = cp.get("Price", {}).get("ListingPrice", {})
        amount = listing.get("Amount")
        if amount is not None:
            return float(amount)

    return None


async def _fetch_amazon_prices(identifiers: list[str], item_type: str, param_name: str) -> dict[str, float | None]:
    """
    SP-API pricing fetcher using batch getItemOffers/getPricing endpoint.
    Only ASIN-based lookups are reliable (ItemType=Asin, param_name=Asins).
    SKU-based batch lookups (ItemType=Sku) return 400 errors from Amazon.
    """
    endpoint = os.getenv("SP_API_ENDPOINT", "https://sellingpartnerapi-eu.amazon.com").strip('"').strip("'")
    marketplace_id = os.getenv("SP_API_MARKETPLACE_ID", "A21TJRUUN4KGV")
    access_token = await get_amazon_access_token()

    unique_ids = list(dict.fromkeys(i for i in identifiers if i))
    if not unique_ids:
        return {}

    results: dict[str, float | None] = {}
    batch_size = 20
    max_retries = 2

    async with httpx.AsyncClient(timeout=30) as client:
        headers = {"x-amz-access-token": access_token}

        for i in range(0, len(unique_ids), batch_size):
            batch = unique_ids[i:i + batch_size]

            params = [("MarketplaceId", marketplace_id), ("ItemType", item_type)]
            for identifier in batch:
                params.append((param_name, identifier))
            url = f"{endpoint}/products/pricing/v0/price"

            for attempt in range(max_retries + 1):
                try:
                    resp = await client.get(url, params=params, headers=headers)

                    if resp.status_code == 429:
                        wait = min(5 * (attempt + 1), 15)
                        logger.warning(f"Rate limit hit on pricing API (attempt {attempt+1}), sleeping {wait}s...")
                        await asyncio.sleep(wait)
                        if attempt == max_retries:
                            logger.error(f"Pricing API rate-limited after {max_retries+1} attempts, skipping batch")
                            for ident in batch:
                                results.setdefault(ident, None)
                            break
                        continue

                    if resp.status_code == 400:
                        body = resp.text
                        logger.warning(f"Pricing API 400 error (attempt {attempt+1}): {body[:500]}")
                        if attempt == max_retries:
                            for ident in batch:
                                results.setdefault(ident, None)
                        continue

                    if resp.status_code == 403:
                        logger.warning("Got 403 on pricing API, refreshing access token...")
                        access_token = await get_amazon_access_token()
                        headers = {"x-amz-access-token": access_token}
                        continue

                    resp.raise_for_status()
                    data = resp.json()

                    for price_item in data.get("payload", []):
                        # Response uses SellerSKU for SKU lookups, ASIN for ASIN lookups
                        item_key = price_item.get("SellerSKU") if item_type == "Sku" else price_item.get("ASIN")
                        if not item_key:
                            continue
                        status = price_item.get("status", "")
                        if status != "Success":
                            results[item_key] = None
                            continue

                        product = price_item.get("Product", {})
                        results[item_key] = _extract_price_from_product(product)

                    for ident in batch:
                        results.setdefault(ident, None)

                    break  # Success, move to next batch

                except httpx.HTTPStatusError as exc:
                    logger.warning(f"Pricing API HTTP error for batch (attempt {attempt+1}): {exc}")
                    if attempt == max_retries:
                        for ident in batch:
                            results.setdefault(ident, None)
                except Exception as exc:
                    logger.warning(f"Pricing API error for batch (attempt {attempt+1}): {exc}")
                    if attempt == max_retries:
                        for ident in batch:
                            results.setdefault(ident, None)

            # Small delay between batches to respect rate limits
            if i + batch_size < len(unique_ids):
                await asyncio.sleep(0.5)

    return results


AMAZON_FINANCE_AUTO_BACKFILL_DAYS = int(os.getenv("AMAZON_FINANCE_AUTO_BACKFILL_DAYS", "30"))


async def run_amazon_finance_actuals_sync(session: AsyncSession, days: int | None = None):
    """Pulls SP-API Finance actuals (referral fee + outbound shipping) for every
    Amazon-fulfilled order in the last `days` window that is still missing either
    value. No per-batch cap — runs to completion so dashboards reflect API data
    as soon as Amazon settles each order."""
    days = days or AMAZON_FINANCE_AUTO_BACKFILL_DAYS

    rows = (await session.execute(sa_text("""
        SELECT o.amazon_order_id, o.sku
        FROM orders o
        LEFT JOIN shipment_estimates se
          ON se.amazon_order_id = o.amazon_order_id AND se.sku = o.sku
        WHERE o.item_price > 0
          AND (
            LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
            OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
          )
          AND o.order_status NOT IN ('Cancelled', 'Pending')
          AND o.purchase_date >= NOW() - (CAST(:days AS INTEGER) * INTERVAL '1 day')
          AND (
            COALESCE(o.amazon_fee, 0) <= 0
            OR COALESCE(o.shipping_price, 0) <= 0
            OR COALESCE(se.rate_source, '') <> 'sp_api_finance'
          )
        ORDER BY o.purchase_date ASC NULLS LAST
    """), {"days": days})).all()

    order_map: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        order_map[str(row[0])].append(str(row[1]))

    if not order_map:
        logger.info("Finance actuals sync: no eligible Amazon orders need a refresh.")
        return

    order_ids = list(order_map.keys())
    logger.info(
        "Finance actuals sync: looking up %s order(s) (%s rows) over the last %s days.",
        len(order_ids), len(rows), days,
    )

    access_token = await get_amazon_access_token()
    shipping_updates = 0
    fee_updates = 0
    no_data = 0

    async with httpx.AsyncClient(timeout=30) as client:
        for index, order_id in enumerate(order_ids):
            breakdown = await fetch_amazon_order_financial_breakdown(client, access_token, order_id)
            had_any = False

            for sku in order_map[order_id]:
                entry = breakdown.get(sku, {})
                shipping = float(entry.get("shipping") or 0.0)
                referral = float(entry.get("referral") or 0.0)

                if shipping > 0:
                    had_any = True
                    await session.execute(sa_text("""
                        UPDATE orders SET shipping_price = :shipping
                        WHERE amazon_order_id = :order_id AND sku = :sku
                    """), {"shipping": shipping, "order_id": order_id, "sku": sku})
                    await session.execute(sa_text("""
                        UPDATE shipment_estimates
                        SET amazon_shipping_cost = :shipping,
                            rate_source = 'sp_api_finance',
                            estimated_at = NOW()
                        WHERE amazon_order_id = :order_id AND sku = :sku
                    """), {"shipping": shipping, "order_id": order_id, "sku": sku})
                    shipping_updates += 1

                if referral > 0:
                    had_any = True
                    await session.execute(sa_text("""
                        UPDATE orders SET amazon_fee = :fee
                        WHERE amazon_order_id = :order_id AND sku = :sku
                    """), {"fee": referral, "order_id": order_id, "sku": sku})
                    fee_updates += 1

            if not had_any:
                no_data += 1

            if (index + 1) % 50 == 0 or index == len(order_ids) - 1:
                await session.commit()
                logger.info(
                    "Finance actuals sync [%s/%s] shipping=%s fee=%s pending=%s",
                    index + 1, len(order_ids), shipping_updates, fee_updates, no_data,
                )

            if index < len(order_ids) - 1:
                await asyncio.sleep(AMAZON_FINANCE_LOOKUP_DELAY_SECONDS)

    await session.commit()

    if shipping_updates or fee_updates:
        await recalculate_profitability_all(session)


async def run_full_sync(session: AsyncSession):
    """
    Runs inventory sync, incremental orders sync, and product specs sync.
    Called by the hourly cron and the manual Sync button.
    """
    logger.info("=== STARTING FULL SYNC ===")
    failures: list[str] = []

    async def _run_phase(label: str, runner):
        logger.info(label)
        try:
            await runner(session)
        except Exception:
            await session.rollback()
            phase_name = label.replace("--- ", "").replace(" ---", "")
            failures.append(phase_name)
            logger.exception("%s failed", phase_name)

    await _run_phase("--- Phase 1: Inventory Sync ---", run_inventory_sync_job)
    await _run_phase("--- Phase 2: Incremental Orders Sync ---", run_incremental_orders_sync)
    await _run_phase("--- Phase 3: Product Specifications Sync ---", run_product_specs_sync)
    await _run_phase("--- Phase 4: Shipment Cost Sync ---", run_shipment_sync)
    await _run_phase("--- Phase 5: Inbound Shipments Sync ---", run_inbound_shipments_sync)
    await _run_phase("--- Phase 6: Amazon Finance Actuals Sync ---", run_amazon_finance_actuals_sync)

    if failures:
        logger.warning("=== FULL SYNC COMPLETE WITH FAILURES: %s ===", ", ".join(failures))
    else:
        logger.info("=== FULL SYNC COMPLETE ===")


async def run_shipment_sync_full(session: AsyncSession, max_batches: int = 500) -> int:
    """Loops run_shipment_sync until no eligible orders remain (or max_batches hit).
    Use this to backfill shipment_estimates for all historical orders so the rate-card
    shipping fallback is available in profitability calculations."""
    total = 0
    for i in range(max_batches):
        before = (await session.execute(sa_text(
            "SELECT COUNT(*) FROM shipment_estimates"
        ))).scalar() or 0
        await run_shipment_sync(session, missing_only=True)
        after = (await session.execute(sa_text(
            "SELECT COUNT(*) FROM shipment_estimates"
        ))).scalar() or 0
        added = after - before
        total += added
        logger.info(f"Shipment full-sync batch {i+1}: +{added} rows (total shipment_estimates: {after})")
        if added <= 0:
            break
    return total
