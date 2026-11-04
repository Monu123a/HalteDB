"""
Shiprocket API Integration + Indian shipping rate card fallback.

Uses Shiprocket courier serviceability API when available.
Falls back to industry-standard rate cards for Delhivery, BlueDart, DTDC, XpressBees, Ekart.
"""
import os
import time
import logging
import httpx
import re
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("shiprocket")

SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external"
_token_cache: dict = {"token": None, "expires_at": 0}


# ═══════════════════════════════════════════════════
# SHIPROCKET LIVE API (requires dedicated API user)
# ═══════════════════════════════════════════════════

def _invalidate_token() -> None:
    _token_cache["token"] = None
    _token_cache["expires_at"] = 0


async def _get_token(force_refresh: bool = False) -> str | None:
    """Authenticate with Shiprocket. Returns None on failure (graceful fallback)."""
    if not force_refresh and _token_cache["token"] and time.time() < _token_cache["expires_at"]:
        return _token_cache["token"]

    email = os.getenv("SHIPROCKET_EMAIL")
    password = os.getenv("SHIPROCKET_PASSWORD")

    if not email or not password:
        logger.warning("Shiprocket auth skipped: SHIPROCKET_EMAIL/SHIPROCKET_PASSWORD env vars not set")
        return None

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{SHIPROCKET_BASE}/auth/login",
                json={"email": email, "password": password},
            )
            if resp.status_code != 200:
                logger.warning(f"Shiprocket auth failed ({resp.status_code}): {resp.text[:200]}")
                return None

            data = resp.json()
            token = data.get("token")
            if not token:
                logger.warning(f"Shiprocket auth returned no token: {str(data)[:200]}")
                return None

            _token_cache["token"] = token
            # Shiprocket tokens nominally last ~10 days but can be invalidated
            # earlier (e.g. when the same account logs in from elsewhere). Keep
            # the cache short so re-auth happens regularly; 401s also invalidate.
            _token_cache["expires_at"] = time.time() + 4 * 86400
            logger.info("Shiprocket token refreshed")
            return token
    except Exception as e:
        logger.warning(f"Shiprocket auth error: {e}")
        return None


CARRIER_MAP = {
    "amazon shipping": "amazon", "Amazon Shipping": "amazon",
    "amazon prepaid": "amazon", "Amazon Prepaid": "amazon",
    "amazon": "amazon", "Amazon": "amazon",
    "delhivery": "delhivery", "Delhivery": "delhivery",
    "Delhivery Surface": "delhivery", "Delhivery Air": "delhivery",
    "blue dart": "bluedart", "Blue Dart": "bluedart", "Bluedart": "bluedart",
    "BlueDart": "bluedart", "Blue Dart Express": "bluedart",
    "dtdc": "dtdc", "DTDC": "dtdc", "DTDC Surface": "dtdc", "DTDC Express": "dtdc",
    "xpressbees": "xpressbees", "Xpressbees": "xpressbees", "XpressBees": "xpressbees",
    "ekart": "ekart", "Ekart": "ekart", "Ekart Logistics": "ekart",
    "Ecom Express": "ekart",
    # India Post is the only courier serviceable for several remote pincodes
    # (J&K, A&N Islands, NE). Bucket it under ekart-class for cheapest-rate purposes.
    "india post": "indiapost", "India Post": "indiapost",
    "speed post": "indiapost", "Speed Post": "indiapost",
}

CARRIER_LABELS = {
    "amazon": "Amazon",
    "delhivery": "Delhivery",
    "bluedart": "BlueDart",
    "dtdc": "DTDC",
    "xpressbees": "Xpressbees",
    "ekart": "Ekart",
    "indiapost": "India Post",
}


def normalize_pincode(pin: str | int | None) -> str:
    return re.sub(r"\D", "", str(pin or ""))[:6]


def is_amazon_fulfilled(fulfillment_channel: str | None) -> bool:
    normalized = (fulfillment_channel or "").lower()
    return "amazon" in normalized or "afn" in normalized


def resolve_amazon_shipping_cost(
    actual_amazon_cost: float | int | None,
    fulfillment_channel: str | None,
    rates: dict,
) -> float:
    actual_cost = round(float(actual_amazon_cost or 0), 2)
    if actual_cost > 0:
        return actual_cost
    if not is_amazon_fulfilled(fulfillment_channel):
        return 0.0

    live_amazon = round(float((rates.get("amazon") or {}).get("cost") or 0), 2)
    if live_amazon > 0:
        return live_amazon

    # For Amazon-fulfilled orders, only use SP-API actual data.
    # Do NOT fall back to Shiprocket/rate-card estimates.
    return 0.0


def normalize_provider_name(name: str | None) -> str | None:
    if not name:
        return name
    lower = re.sub(r"[^a-z]", "", name.lower())
    if "amazon" in lower:
        return "Amazon"
    if "delhivery" in lower:
        return "Delhivery"
    if "bluedart" in lower:
        return "BlueDart"
    if "dtdc" in lower:
        return "DTDC"
    if "xpressbees" in lower or "expressbees" in lower:
        return "Xpressbees"
    if "ekart" in lower:
        return "Ekart"
    return name


def find_cheapest(rates: dict, amazon_cost: float) -> tuple[str, float]:
    all_costs = {}
    if amazon_cost and amazon_cost > 0:
        all_costs["Amazon"] = round(float(amazon_cost), 2)
    for carrier, info in rates.items():
        if carrier == "amazon" or not info:
            continue
        cost = float(info.get("cost") or 0)
        if cost > 0:
            all_costs[CARRIER_LABELS.get(carrier, carrier)] = round(cost, 2)

    if not all_costs:
        return "", float("inf")

    cheapest_provider = min(all_costs, key=lambda provider: all_costs[provider])
    return cheapest_provider, all_costs[cheapest_provider]


async def _shiprocket_rates(
    origin_pin: str,
    dest_pin: str,
    weight_kg: float,
    dims: dict | None = None,
) -> dict | None:
    """Try Shiprocket API. Returns None on any failure.

    dims (optional): {"length", "breadth", "height"} in cm — passed through to
    Shiprocket for better accuracy. Without these, some carriers reject the quote.
    """
    token = await _get_token()
    if not token:
        logger.warning("Shiprocket: no auth token — request skipped")
        return None

    safe_origin_pin = normalize_pincode(origin_pin)
    safe_dest_pin = normalize_pincode(dest_pin)
    safe_weight = max(float(weight_kg or 0.5), 0.1)
    if len(safe_origin_pin) != 6 or len(safe_dest_pin) != 6:
        logger.warning(f"Shiprocket: bad pincode(s) origin={origin_pin} dest={dest_pin}")
        return None

    params: dict[str, str] = {
        "pickup_postcode": safe_origin_pin,
        "delivery_postcode": safe_dest_pin,
        "weight": str(safe_weight),
        "cod": "0",
        "declared_value": "500",
    }
    if dims:
        if dims.get("length"):
            params["length"] = str(int(round(float(dims["length"]))))
        if dims.get("breadth"):
            params["breadth"] = str(int(round(float(dims["breadth"]))))
        if dims.get("height"):
            params["height"] = str(int(round(float(dims["height"]))))

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{SHIPROCKET_BASE}/courier/serviceability/",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
            # Shiprocket invalidates tokens early when the same account logs in
            # elsewhere. Drop the cache and re-auth once before giving up,
            # otherwise every call for the rest of the process lifetime fails.
            if resp.status_code in (401, 403):
                logger.warning(
                    f"Shiprocket rates HTTP {resp.status_code} — invalidating cached token and retrying"
                )
                _invalidate_token()
                token = await _get_token(force_refresh=True)
                if not token:
                    return None
                resp = await client.get(
                    f"{SHIPROCKET_BASE}/courier/serviceability/",
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                )
            if resp.status_code != 200:
                logger.warning(f"Shiprocket rates HTTP {resp.status_code}: {resp.text[:200]}")
                return None

            data = resp.json()
            # API sometimes returns HTTP 200 with an error status in the body.
            api_status = data.get("status")
            if api_status is not None and str(api_status) not in ("200", "1"):
                logger.warning(f"Shiprocket rates API status={api_status} msg={data.get('message')}")
                return None

            companies = data.get("data", {}).get("available_courier_companies", []) or []
            if not companies:
                logger.warning(
                    f"Shiprocket: no couriers for {safe_origin_pin}->{safe_dest_pin} w={safe_weight}"
                )
                return None

            rates = {}
            for courier in companies:
                name = courier.get("courier_name", "")
                carrier_key = None
                for pattern, key in CARRIER_MAP.items():
                    if pattern.lower() in name.lower():
                        carrier_key = key
                        break
                if not carrier_key:
                    continue
                # Try multiple field names — the API has changed over time.
                cost_raw = (
                    courier.get("rate")
                    or courier.get("freight_charge")
                    or courier.get("total_charges")
                    or 0
                )
                try:
                    cost = float(cost_raw)
                except (TypeError, ValueError):
                    cost = 0.0
                if cost <= 0:
                    continue
                etd = courier.get("estimated_delivery_days") or courier.get("etd") or ""
                if carrier_key not in rates or cost < rates[carrier_key]["cost"]:
                    rates[carrier_key] = {
                        "cost": round(cost, 2),
                        "etd": f"{etd} days" if etd else "N/A",
                    }
            if not rates:
                names = ", ".join(
                    str(c.get("courier_name", "")) for c in companies[:5]
                )
                logger.warning(
                    f"Shiprocket: no matching carriers in {len(companies)} results. Names: {names}"
                )
                return None
            return rates
    except Exception as e:
        logger.warning(f"Shiprocket rates error: {e}")
        return None


# ═══════════════════════════════════════════════════
# RATE CARD FALLBACK — Indian standard shipping rates
# ═══════════════════════════════════════════════════

# Indian Zone Classification by first 1-2 digits of pincode
ZONE_MAP = {
    "11": "North", "12": "North", "13": "North", "14": "North", "15": "North",
    "16": "North", "17": "North", "18": "North", "19": "North",
    "20": "North", "21": "North", "22": "North", "23": "North",
    "24": "North", "25": "North", "26": "North", "27": "North", "28": "North",
    "30": "South", "31": "South", "32": "South",
    "33": "South", "34": "South", "35": "South", "36": "West",
    "37": "South", "38": "West", "39": "West",
    "40": "West", "41": "West", "42": "West", "43": "West", "44": "West",
    "45": "Central", "46": "Central", "47": "Central", "48": "Central", "49": "Central",
    "50": "South", "51": "South", "52": "South", "53": "South",
    "56": "South", "57": "South", "58": "South", "59": "South",
    "60": "South", "61": "South", "62": "South", "63": "South", "64": "South",
    "67": "South", "68": "South", "69": "South",
    "70": "East", "71": "East", "72": "East", "73": "East", "74": "East",
    "75": "East", "76": "East", "77": "East",
    "78": "NorthEast", "79": "NorthEast",
    "80": "East", "81": "East", "82": "East", "83": "East", "84": "East", "85": "East",
}


def _get_zone(pincode: str) -> str:
    """Classify pincode into a shipping zone."""
    if len(pincode) >= 2:
        return ZONE_MAP.get(pincode[:2], "National")
    return "National"


def _zone_distance(origin_pin: str, dest_pin: str) -> str:
    """Get relative distance between two pincodes."""
    oz = _get_zone(origin_pin)
    dz = _get_zone(dest_pin)

    if origin_pin[:3] == dest_pin[:3]:
        return "local"  # Same area
    if origin_pin[:2] == dest_pin[:2]:
        return "intra_zone"  # Same state/zone prefix
    if oz == dz:
        return "same_zone"
    # Adjacent zones
    adjacent = {
        ("North", "Central"), ("Central", "North"),
        ("North", "West"), ("West", "North"),
        ("Central", "West"), ("West", "Central"),
        ("South", "West"), ("West", "South"),
        ("East", "Central"), ("Central", "East"),
    }
    if (oz, dz) in adjacent:
        return "adjacent"
    return "national"


# Rate cards: base price for first 0.5kg + per 0.5kg increment
# Format: {distance: (base_rate, per_500g_increment)}
RATE_CARDS = {
    "delhivery": {
        "local":      (28, 16),
        "intra_zone": (35, 20),
        "same_zone":  (45, 25),
        "adjacent":   (60, 30),
        "national":   (75, 38),
    },
    "bluedart": {
        "local":      (45, 25),
        "intra_zone": (55, 30),
        "same_zone":  (70, 35),
        "adjacent":   (90, 42),
        "national":   (110, 50),
    },
    "dtdc": {
        "local":      (30, 18),
        "intra_zone": (38, 22),
        "same_zone":  (50, 28),
        "adjacent":   (65, 33),
        "national":   (82, 40),
    },
    "xpressbees": {
        "local":      (25, 15),
        "intra_zone": (32, 18),
        "same_zone":  (42, 24),
        "adjacent":   (55, 28),
        "national":   (70, 35),
    },
    "ekart": {
        "local":      (30, 17),
        "intra_zone": (38, 21),
        "same_zone":  (48, 26),
        "adjacent":   (62, 31),
        "national":   (78, 38),
    },
}

# Estimated delivery days per carrier/distance
ETD_CARDS = {
    "delhivery":  {"local": "1-2", "intra_zone": "2-3", "same_zone": "3-4", "adjacent": "4-5", "national": "5-7"},
    "bluedart":   {"local": "1",   "intra_zone": "1-2", "same_zone": "2-3", "adjacent": "3-4", "national": "4-5"},
    "dtdc":       {"local": "2-3", "intra_zone": "3-4", "same_zone": "4-5", "adjacent": "5-6", "national": "6-8"},
    "xpressbees": {"local": "1-2", "intra_zone": "2-3", "same_zone": "3-5", "adjacent": "4-6", "national": "5-7"},
    "ekart":      {"local": "2-3", "intra_zone": "3-4", "same_zone": "4-5", "adjacent": "5-6", "national": "6-8"},
}


def _estimate_rate(carrier: str, origin_pin: str, dest_pin: str, weight_kg: float) -> dict:
    """Estimate shipping rate from rate card."""
    distance = _zone_distance(origin_pin, dest_pin)
    card = RATE_CARDS.get(carrier, {})
    base, increment = card.get(distance, (75, 38))

    # Calculate: base for first 0.5kg + increments for additional weight
    if weight_kg <= 0.5:
        cost = base
    else:
        extra_slots = int((weight_kg - 0.5) / 0.5) + (1 if (weight_kg - 0.5) % 0.5 > 0 else 0)
        cost = base + extra_slots * increment

    # Add 18% GST
    cost_with_gst = round(cost * 1.18, 2)

    etd = ETD_CARDS.get(carrier, {}).get(distance, "5-7")

    return {"cost": cost_with_gst, "etd": f"{etd} days"}


def estimate_all_carriers(origin_pin: str, dest_pin: str, weight_kg: float) -> dict:
    """Get estimated rates from all carriers using rate cards."""
    return {
        carrier: _estimate_rate(carrier, origin_pin, dest_pin, weight_kg)
        for carrier in RATE_CARDS
    }


# ═══════════════════════════════════════════════════
# UNIFIED RATE FETCHER — tries Shiprocket, falls back
# ═══════════════════════════════════════════════════

async def get_shipping_rates(
    origin_pin: str,
    dest_pin: str,
    weight_kg: float,
    dims: dict | None = None,
) -> dict:
    """Fetch shipping rates. Tries Shiprocket API first, falls back to rate cards."""
    rates, _ = await get_shipping_rates_with_source(origin_pin, dest_pin, weight_kg, dims)
    return rates


async def get_shipping_rates_with_source(
    origin_pin: str,
    dest_pin: str,
    weight_kg: float,
    dims: dict | None = None,
) -> tuple[dict[str, dict[str, object]], str]:
    """Fetch shipping rates along with their source."""
    safe_origin_pin = normalize_pincode(origin_pin)
    safe_dest_pin = normalize_pincode(dest_pin)
    safe_weight = max(float(weight_kg or 0.5), 0.1)

    # Fetch Shiprocket live rates first; fall back to standard carrier rate cards
    # if live API is disconnected or fails.
    live_rates = await _shiprocket_rates(safe_origin_pin, safe_dest_pin, safe_weight, dims)
    if live_rates:
        return live_rates, "shiprocket"

    fallback_rates = estimate_all_carriers(safe_origin_pin, safe_dest_pin, safe_weight)
    return fallback_rates, "fallback"


async def get_bulk_rates(origin_pin: str, orders: list[dict], default_weight: float = 0.5) -> list[dict]:
    """Fetch rates for multiple orders."""
    import asyncio

    results = []
    semaphore = asyncio.Semaphore(5)

    async def fetch_one(order: dict) -> dict:
        async with semaphore:
            dest_pin = order.get("destination_pincode")
            weight = order.get("chargeable_weight_kg") or default_weight

            if not dest_pin:
                return {**order, "rates_error": "No destination pincode"}

            try:
                rates, _ = await get_shipping_rates_with_source(origin_pin, dest_pin, weight)

                result = {
                    **order,
                    "delhivery_cost": rates.get("delhivery", {}).get("cost"),
                    "bluedart_cost": rates.get("bluedart", {}).get("cost"),
                    "dtdc_cost": rates.get("dtdc", {}).get("cost"),
                    "xpressbees_cost": rates.get("xpressbees", {}).get("cost"),
                    "ekart_cost": rates.get("ekart", {}).get("cost"),
                    "delhivery_etd": rates.get("delhivery", {}).get("etd"),
                    "bluedart_etd": rates.get("bluedart", {}).get("etd"),
                    "dtdc_etd": rates.get("dtdc", {}).get("etd"),
                    "xpressbees_etd": rates.get("xpressbees", {}).get("etd"),
                    "ekart_etd": rates.get("ekart", {}).get("etd"),
                }

                # Find cheapest (include Amazon's cost too)
                carrier_costs = {
                    k: v for k, v in {
                        "Amazon": order.get("amazon_shipping_cost"),
                        "Delhivery": result.get("delhivery_cost"),
                        "BlueDart": result.get("bluedart_cost"),
                        "DTDC": result.get("dtdc_cost"),
                        "XpressBees": result.get("xpressbees_cost"),
                        "Ekart": result.get("ekart_cost"),
                    }.items() if v is not None and float(v) > 0
                }

                if carrier_costs:
                    cheapest = min(carrier_costs, key=lambda k: carrier_costs[k])
                    result["cheapest_provider"] = normalize_provider_name(cheapest)
                    result["cheapest_cost"] = carrier_costs[cheapest]

                return result

            except Exception as e:
                logger.warning(f"Rate fetch failed for {order.get('amazon_order_id')}: {e}")
                return {**order, "rates_error": str(e)}

    tasks = [fetch_one(order) for order in orders]
    results = await asyncio.gather(*tasks)
    return list(results)
