/**
 * Shared shipment calculation logic — used by both bulk and single estimate routes.
 *
 * Shiprocket quotes are fetched via the Python backend (POST /shipping-rates).
 * Authenticating from both sides with the same Shiprocket account caused
 * constant token invalidation (Shiprocket kicks out a token whenever the
 * same account logs in elsewhere), so the backend is now the single auth
 * source — the frontend never talks to Shiprocket directly.
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

/** Canonical display name for each carrier key */
export const CARRIER_LABELS: Record<string, string> = {
  amazon: "Amazon",
  delhivery: "Delhivery",
  bluedart: "BlueDart",
  dtdc: "DTDC",
  xpressbees: "Xpressbees",
  ekart: "Ekart",
};

export interface ShiprocketDimensions {
  length?: number;  // cm
  breadth?: number; // cm
  height?: number;  // cm
}

function roundCost(value: number) {
  return Math.round(value * 100) / 100;
}

export function normalizePincode(pin: string | number | null | undefined): string {
  return String(pin ?? "").replace(/\D/g, "").slice(0, 6);
}

export function isAmazonFulfilled(fulfillmentChannel: string | null | undefined): boolean {
  const normalized = String(fulfillmentChannel ?? "").toLowerCase();
  return normalized.includes("amazon") || normalized.includes("afn");
}

export async function fetchShiprocketRates(
  originPin: string, destPin: string, weightKg: number,
  dims?: ShiprocketDimensions
): Promise<{ rates: Record<string, { cost: number; etd: string }>; source: "shiprocket" } | null> {
  const safeWeight = Math.max(weightKg || 0.5, 0.1);
  const sanitizedOriginPin = normalizePincode(originPin);
  const sanitizedDestPin = normalizePincode(destPin);
  if (sanitizedOriginPin.length !== 6 || sanitizedDestPin.length !== 6) {
    console.warn(`[Shiprocket] Invalid pincode(s): origin=${originPin} dest=${destPin}`);
    return null;
  }

  try {
    const body: Record<string, string | number> = {
      origin_pin: sanitizedOriginPin,
      dest_pin: sanitizedDestPin,
      weight_kg: safeWeight,
    };
    if (dims?.length) body.length_cm = dims.length;
    if (dims?.breadth) body.width_cm = dims.breadth;
    if (dims?.height) body.height_cm = dims.height;

    const res = await fetch(`${BACKEND_URL}/shipping-rates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[Shiprocket] Backend /shipping-rates failed: ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      rates?: Record<string, { cost: number; etd: string }>;
      source?: string;
    };

    if (data.source !== "shiprocket" || !data.rates || Object.keys(data.rates).length === 0) {
      return null;
    }
    return { rates: data.rates, source: "shiprocket" };
  } catch (e) {
    console.warn("[Shiprocket] Backend rates error:", e);
    return null;
  }
}

// ═══════════════════════════════════════════════════
// Fallback Rate Card (zone-based Indian rates)
// ═══════════════════════════════════════════════════

const ZONE_MAP: Record<string, string> = {
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
};

const RATE_CARDS: Record<string, Record<string, [number, number]>> = {
  delhivery:  { local: [28, 16], intra_zone: [35, 20], same_zone: [45, 25], adjacent: [60, 30], national: [75, 38] },
  bluedart:   { local: [45, 25], intra_zone: [55, 30], same_zone: [70, 35], adjacent: [90, 42], national: [110, 50] },
  dtdc:       { local: [30, 18], intra_zone: [38, 22], same_zone: [50, 28], adjacent: [65, 33], national: [82, 40] },
  xpressbees: { local: [25, 15], intra_zone: [32, 18], same_zone: [42, 24], adjacent: [55, 28], national: [70, 35] },
  ekart:      { local: [30, 17], intra_zone: [38, 21], same_zone: [48, 26], adjacent: [62, 31], national: [78, 38] },
};

const ETD_CARDS: Record<string, Record<string, string>> = {
  delhivery:  { local: "1-2", intra_zone: "2-3", same_zone: "3-4", adjacent: "4-5", national: "5-7" },
  bluedart:   { local: "1",   intra_zone: "1-2", same_zone: "2-3", adjacent: "3-4", national: "4-5" },
  dtdc:       { local: "2-3", intra_zone: "3-4", same_zone: "4-5", adjacent: "5-6", national: "6-8" },
  xpressbees: { local: "1-2", intra_zone: "2-3", same_zone: "3-5", adjacent: "4-6", national: "5-7" },
  ekart:      { local: "2-3", intra_zone: "3-4", same_zone: "4-5", adjacent: "5-6", national: "6-8" },
};

function getZone(pin: string): string {
  return ZONE_MAP[pin.substring(0, 2)] || "National";
}

function getDistance(originPin: string, destPin: string): string {
  if (originPin.substring(0, 3) === destPin.substring(0, 3)) return "local";
  if (originPin.substring(0, 2) === destPin.substring(0, 2)) return "intra_zone";
  const oz = getZone(originPin), dz = getZone(destPin);
  if (oz === dz) return "same_zone";
  const adj = new Set([
    "North-Central", "Central-North", "North-West", "West-North",
    "Central-West", "West-Central", "South-West", "West-South",
    "East-Central", "Central-East",
  ]);
  if (adj.has(`${oz}-${dz}`)) return "adjacent";
  return "national";
}

function estimateFallbackRate(carrier: string, originPin: string, destPin: string, weightKg: number) {
  const dist = getDistance(originPin, destPin);
  const [base, increment] = RATE_CARDS[carrier]?.[dist] || [75, 38];
  let cost = base;
  if (weightKg > 0.5) {
    cost += Math.ceil((weightKg - 0.5) / 0.5) * increment;
  }
  cost = Math.round(cost * 1.18 * 100) / 100; // +18% GST
  const etd = ETD_CARDS[carrier]?.[dist] || "5-7";
  return { cost, etd: `${etd} days` };
}

export function getFallbackRates(originPin: string, destPin: string, weightKg: number): { rates: Record<string, { cost: number; etd: string }>; source: "fallback" } {
  const rates: Record<string, { cost: number; etd: string }> = {};
  for (const carrier of Object.keys(RATE_CARDS)) {
    rates[carrier] = estimateFallbackRate(carrier, originPin, destPin, weightKg);
  }
  return { rates, source: "fallback" };
}

/**
 * Tries live Shiprocket rates first; if unavailable, falls back to standard rate cards.
 */
export async function getCarrierRates(
  originPin: string, destPin: string, weightKg: number,
  dims?: ShiprocketDimensions
): Promise<{ rates: Record<string, { cost: number; etd: string }>; source: "shiprocket" | "fallback" }> {
  const live = await fetchShiprocketRates(originPin, destPin, weightKg, dims);
  if (live && live.rates && Object.keys(live.rates).length > 0) {
    return live;
  }
  return getFallbackRates(originPin, destPin, weightKg);
}

export const ORIGIN_PIN = process.env.ORIGIN_PINCODE || "160012";

export function resolveAmazonShippingCost(
  actualAmazonCost: number | string | null | undefined,
  fulfillmentChannel: string | null | undefined,
  rates: Record<string, { cost: number; etd: string }>
): number {
  const actualCost = Number(actualAmazonCost) || 0;
  if (actualCost > 0) return roundCost(actualCost);
  if (!isAmazonFulfilled(fulfillmentChannel)) return 0;

  const liveAmazonCost = rates.amazon?.cost || 0;
  if (liveAmazonCost > 0) return roundCost(liveAmazonCost);

  // For Amazon-fulfilled orders, only use SP-API actual data.
  // Do NOT fall back to Shiprocket/rate-card estimates.
  return 0;
}

/**
 * Given rates from either Shiprocket or fallback plus Amazon's cost,
 * returns the cheapest provider & cost.
 */
export function findCheapest(
  rates: Record<string, { cost: number; etd: string }>,
  amazonCost: number
): { cheapestProvider: string; cheapestCost: number } {
  const allCosts: Record<string, number> = {};
  if (amazonCost > 0) allCosts["Amazon"] = amazonCost;
  for (const [carrier, info] of Object.entries(rates)) {
    if (carrier === "amazon") continue;
    if (info.cost > 0) {
      allCosts[CARRIER_LABELS[carrier] || carrier] = info.cost;
    }
  }

  let cheapestProvider = "";
  let cheapestCost = Infinity;
  for (const [provider, cost] of Object.entries(allCosts)) {
    if (cost < cheapestCost) {
      cheapestCost = cost;
      cheapestProvider = provider;
    }
  }
  return { cheapestProvider, cheapestCost };
}

/** Normalize various spellings of carrier names to our canonical forms */
export function normalizeProviderName(name: string): string {
  if (!name) return name;
  const lower = name.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.includes("xpressbees") || lower.includes("expressbees")) return "Xpressbees";
  if (lower.includes("bluedart") || lower.includes("bluedartt")) return "BlueDart";
  if (lower.includes("delhivery")) return "Delhivery";
  if (lower.includes("dtdc")) return "DTDC";
  if (lower.includes("ekart")) return "Ekart";
  if (lower.includes("amazon")) return "Amazon";
  return name;
}
