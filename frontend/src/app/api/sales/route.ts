import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { getCityTier } from "@/lib/cityTiers";
import { normalizedSkuExpr, estimatedCogsLateralJoin } from "@/lib/skuNormalize";
import { stateMatchKeys, stateNormalizeSqlExpr } from "@/lib/stateNormalize";

const NORM_STATE = stateNormalizeSqlExpr("o.ship_state");

// Matches Cancelled, CANCELLED, Returned, RETURNED, RTO, "Shipped - Returned to Seller", etc.
const RETURN_LIKE = "LOWER(COALESCE(o.order_status, '')) ~ '(cancel|return|rto)'";
const REVENUE_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE o.item_price END`;
const UNITS_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE o.quantity END`;
const PROFIT_EXPR = `CASE WHEN ${RETURN_LIKE} THEN -2 * COALESCE(o.shipping_price, 0) ELSE COALESCE(o.profit, 0) END`;
const ROW_COGS_EXPR = `CASE WHEN ${RETURN_LIKE} THEN NULL ELSE o.cogs_price END`;
const ACTIVE_COUNT_EXPR = `COUNT(*) FILTER (WHERE NOT (${RETURN_LIKE}))`;

function normalizeDateStr(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  let s = dateStr.trim();
  if (!s) return null;
  // Handle 0025-MM-DD -> 2025-MM-DD (when 2 digits typed in HTML5 date input)
  s = s.replace(/^00(\d{2})-/, "20$1-");
  // Handle 25-MM-DD -> 2025-MM-DD
  s = s.replace(/^(\d{2})-(\d{2})-(\d{2})$/, "20$1-$2-$3");
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "100");
    const offset = parseInt(searchParams.get("offset") || "0");
    const sku = searchParams.get("sku");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const month = searchParams.get("month"); // YYYY-MM
    const year = searchParams.get("year");
    const city = searchParams.get("city");
    const state = searchParams.get("state");
    const tier = searchParams.get("tier");
    const brand = searchParams.get("brand");

    const conditions: string[] = [
      "o.purchase_date IS NOT NULL",
      "o.purchase_date <= NOW()",
      "o.item_price > 0",
      "(o.amazon_order_id IS NULL OR o.amazon_order_id NOT LIKE 'ORD-%')",
    ];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (sku) {
      const skus = sku.split(",").map(s => s.trim()).filter(Boolean);
      if (skus.length === 1) {
        conditions.push(`${normalizedSkuExpr("o.sku")} = UPPER($${paramIdx++})`);
        params.push(skus[0]);
      } else if (skus.length > 1) {
        const placeholders = skus.map(() => `UPPER($${paramIdx++})`).join(",");
        conditions.push(`${normalizedSkuExpr("o.sku")} IN (${placeholders})`);
        params.push(...skus);
      }
    }
    const safeStartDate = normalizeDateStr(startDate);
    const safeEndDate = normalizeDateStr(endDate);
    if (safeStartDate) {
      conditions.push(`(o.purchase_date AT TIME ZONE 'Asia/Kolkata')::date >= $${paramIdx++}::date`);
      params.push(safeStartDate);
    }
    if (safeEndDate) {
      conditions.push(`(o.purchase_date AT TIME ZONE 'Asia/Kolkata')::date <= $${paramIdx++}::date`);
      params.push(safeEndDate);
    }
    if (month) {
      conditions.push(`TO_CHAR(o.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $${paramIdx++}`);
      params.push(month);
    }
    if (year) {
      conditions.push(`EXTRACT(YEAR FROM o.purchase_date AT TIME ZONE 'Asia/Kolkata') = $${paramIdx++}`);
      params.push(parseInt(year));
    }
    if (city) {
      const cities = city.split(",").map(c => c.trim()).filter(Boolean);
      if (cities.length === 1) {
        conditions.push(`LOWER(o.ship_city) = LOWER($${paramIdx++})`);
        params.push(cities[0]);
      } else if (cities.length > 1) {
        const placeholders = cities.map(() => `LOWER($${paramIdx++})`).join(",");
        conditions.push(`LOWER(o.ship_city) IN (${placeholders})`);
        params.push(...cities);
      }
    }
    if (state) {
      const keys = stateMatchKeys(state);
      if (keys.length === 0) {
        conditions.push("FALSE");
      } else {
        const placeholders = keys.map(() => `$${paramIdx++}`).join(",");
        conditions.push(`${NORM_STATE} IN (${placeholders})`);
        params.push(...keys);
      }
    }
    if (brand) {
      conditions.push(`LOWER(ec.brand) = LOWER($${paramIdx++})`);
      params.push(brand);
    }

    /* ── Tier filter: resolve tier → city list ── */
    if (tier) {
      const allCitiesRes = await pool.query(
        "SELECT DISTINCT ship_city FROM orders WHERE ship_city IS NOT NULL AND ship_city != ''"
      );
      const tierCities = allCitiesRes.rows
        .map((r: { ship_city: string }) => r.ship_city)
        .filter((c: string) => getCityTier(c) === tier);

      if (tierCities.length === 0) {
        return NextResponse.json({
          orders: [],
          summary: { total_orders: 0, total_revenue: 0, total_profit: 0, total_units: 0, avg_profit_per_order: 0 },
          pagination: { total: 0, limit, offset },
        });
      }

      const placeholders = tierCities.map(() => `$${paramIdx++}`).join(",");
      conditions.push(`o.ship_city IN (${placeholders})`);
      params.push(...tierCities);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fromClause = `FROM orders o ${estimatedCogsLateralJoin("o")}`;

    let query = `
      SELECT o.id, o.amazon_order_id, o.purchase_date, o.order_status,
             o.fulfillment_channel, o.sales_channel, o.sku, o.asin,
             o.quantity, o.currency, o.item_price, o.item_tax,
             ${ROW_COGS_EXPR} as cogs_price,
             ${PROFIT_EXPR} as profit,
             o.ship_city, o.ship_state
      ${fromClause}
      ${where}
    `;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total ${fromClause} ${where}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    query += ` ORDER BY o.purchase_date DESC NULLS LAST LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Summary metrics (using same filters)
    const summaryParams = params.slice(0, params.length - 2); // exclude limit/offset
    const summaryQuery = `
      SELECT
        ${ACTIVE_COUNT_EXPR} as total_orders,
        COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
        COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
        COALESCE(SUM(${UNITS_EXPR}), 0) as total_units,
        COALESCE(AVG(${PROFIT_EXPR}), 0) as avg_profit_per_order
      ${fromClause}
      ${where}
    `;
    const summaryResult = await pool.query(summaryQuery, summaryParams);

    return NextResponse.json({
      orders: result.rows,
      summary: summaryResult.rows[0],
      pagination: { total, limit, offset },
    });
  } catch (error) {
    console.error("Sales API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch sales data" },
      { status: 500 }
    );
  }
}
