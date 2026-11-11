/**
 * Shared SQL expression and filter helpers for the `/api/sales/*` endpoints.
 * Keeps active-order accounting, channel classification, and website deduplication
 * consistent across orders, summary, and geography queries.
 */

export type SalesChannelBucket = "website" | "amazon" | "b2b";

const VALID_CHANNELS = new Set<SalesChannelBucket>(["website", "amazon", "b2b"]);

/** Normalizes incoming date strings (supports ISO `YYYY-MM-DD`, 2-digit year typos, and `DD/MM/YYYY`). */
export function normalizeDateStr(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  let s = dateStr.trim();
  if (!s) return null;
  // Handle 0025-MM-DD -> 2025-MM-DD (when 2 digits typed in HTML5 date input)
  s = s.replace(/^00(\d{2})-/, "20$1-");
  // Handle 25-MM-DD -> 2025-MM-DD
  s = s.replace(/^(\d{2})-(\d{2})-(\d{2})$/, "20$1-$2-$3");
  const ddmmyyyy = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }
  return s;
}

/** Matches Cancelled, Returned, RTO, "Shipped - Returned to Seller", etc. */
export function returnLikeExpr(alias: string): string {
  return `LOWER(COALESCE(${alias}.order_status, '')) ~ '(cancel|return|rto)'`;
}

export const RETURN_LIKE_EXPR = returnLikeExpr("o");

export function revenueExpr(alias: string): string {
  return `CASE WHEN ${returnLikeExpr(alias)} THEN 0 ELSE ${alias}.item_price END`;
}

export function unitsExpr(alias: string): string {
  return `CASE WHEN ${returnLikeExpr(alias)} THEN 0 ELSE ${alias}.quantity END`;
}

export function profitExpr(alias: string): string {
  return `CASE WHEN ${returnLikeExpr(alias)} THEN -2 * COALESCE(${alias}.shipping_price, 0) ELSE COALESCE(${alias}.profit, 0) END`;
}

export function rowCogsExpr(alias: string): string {
  return `CASE WHEN ${returnLikeExpr(alias)} THEN NULL ELSE ${alias}.cogs_price END`;
}

export function activeCountExpr(alias: string): string {
  return `COUNT(*) FILTER (WHERE NOT (${returnLikeExpr(alias)}))`;
}

/**
 * Base WHERE predicates applied to every sales query:
 * - Includes historical website `ORD-%` orders and live `halte.in` `HN-%` orders.
 * - Excludes undated CRM imports, future dates, zero-price rows, test SKUs,
 *   known DD/MM-corrupted duplicate `gardena cx list` sheet, and the 16 overlapping
 *   `ORD-%` rows already present in `Halte Website 2026 New.xlsx - JSPL Website`.
 */
export function baseSalesConditions(alias: string): string[] {
  return [
    `${alias}.purchase_date IS NOT NULL`,
    `${alias}.purchase_date <= NOW()`,
    `${alias}.item_price > 0`,
    `COALESCE(${alias}.sales_channel, '') NOT ILIKE '%gardena cx list%'`,
    `COALESCE(${alias}.sku, '') NOT ILIKE 'TEST-%'`,
    `NOT (
      COALESCE(${alias}.sales_channel, '') IN ('Halte Website 2026 - JSPL Website', 'Halte Website 2026 - JSPL B2B')
      AND ${alias}.amazon_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM orders dup
        WHERE dup.amazon_order_id = ${alias}.amazon_order_id
          AND dup.sales_channel = 'Halte Website 2026 New.xlsx - JSPL Website'
          AND dup.purchase_date IS NOT NULL
          AND dup.item_price > 0
      )
    )`,
  ];
}

/** Maps each order row to `'website' | 'amazon' | 'b2b' | 'other'`. */
export function channelBucketExpr(alias: string): string {
  return `CASE
    WHEN COALESCE(${alias}.sales_channel, '') = 'halte.in'
      OR LOWER(COALESCE(${alias}.fulfillment_channel, '')) = 'halte website'
      OR COALESCE(${alias}.sales_channel, '') IN (
        'Halte Website 2026 New.xlsx - JSPL Website',
        'Halte Website 2026 New.xlsx - JH website',
        'Halte Website 2026 - JSPL Website'
      ) THEN 'website'
    WHEN COALESCE(${alias}.sales_channel, '') LIKE 'B2B JH Sales%'
      OR COALESCE(${alias}.sales_channel, '') LIKE '%JSPL B2B%'
      THEN 'b2b'
    WHEN COALESCE(${alias}.sales_channel, '') = 'Amazon.in'
      OR COALESCE(${alias}.sales_channel, '') LIKE '%JSPL Amz Self Ship%'
      THEN 'amazon'
    ELSE 'other'
  END`;
}

/** Validates user-supplied `channel` query parameter. */
export function parseSalesChannel(channel: string | null | undefined): SalesChannelBucket | null {
  if (!channel) return null;
  const normalized = channel.trim().toLowerCase() as SalesChannelBucket;
  return VALID_CHANNELS.has(normalized) ? normalized : null;
}

/** Returns a SQL predicate filtering by normalized channel bucket, or null when unset/invalid. */
export function channelFilterCondition(alias: string, channel: string | null | undefined): string | null {
  const parsed = parseSalesChannel(channel);
  if (!parsed) return null;
  return `${channelBucketExpr(alias)} = '${parsed}'`;
}

/** Human-readable channel label for tables and exports. */
export function channelDisplayExpr(alias: string): string {
  return `CASE
    WHEN COALESCE(${alias}.sales_channel, '') = 'halte.in'
      OR LOWER(COALESCE(${alias}.fulfillment_channel, '')) = 'halte website'
      THEN 'Halte Website'
    WHEN COALESCE(${alias}.sales_channel, '') IN (
      'Halte Website 2026 New.xlsx - JSPL Website',
      'Halte Website 2026 - JSPL Website'
    ) THEN 'Halte Website (JSPL)'
    WHEN COALESCE(${alias}.sales_channel, '') = 'Halte Website 2026 New.xlsx - JH website'
      THEN 'Halte Website (JH)'
    WHEN COALESCE(${alias}.sales_channel, '') LIKE 'B2B JH Sales%'
      OR COALESCE(${alias}.sales_channel, '') LIKE '%JSPL B2B%'
      THEN 'B2B'
    WHEN COALESCE(${alias}.sales_channel, '') LIKE '%JSPL Amz Self Ship%'
      THEN 'Amazon (Self Ship)'
    WHEN COALESCE(${alias}.sales_channel, '') = 'Amazon.in'
      AND COALESCE(${alias}.fulfillment_channel, '') = 'Amazon'
      THEN 'Amazon (FBA)'
    WHEN COALESCE(${alias}.sales_channel, '') = 'Amazon.in'
      AND COALESCE(${alias}.fulfillment_channel, '') = 'Merchant'
      THEN 'Amazon (Easy Ship)'
    ELSE COALESCE(NULLIF(${alias}.fulfillment_channel, ''), NULLIF(${alias}.sales_channel, ''), '—')
  END`;
}
