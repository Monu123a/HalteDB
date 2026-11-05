import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { getCityTier } from "@/lib/cityTiers";
import { normalizedSkuExpr, estimatedCogsLateralJoin } from "@/lib/skuNormalize";
import { stateMatchKeys, stateNormalizeSqlExpr } from "@/lib/stateNormalize";

const NORM_SKU = normalizedSkuExpr("orders.sku");
const NORM_STATE = stateNormalizeSqlExpr("orders.ship_state");

// Matches Cancelled, CANCELLED, Returned, RETURNED, RTO, "Shipped - Returned to Seller", etc.
const RETURN_LIKE = "LOWER(COALESCE(orders.order_status, '')) ~ '(cancel|return|rto)'";
const REVENUE_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE orders.item_price END`;
const UNITS_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE orders.quantity END`;
// For return-like rows the recalc stored in orders.profit may be stale (it only caught exact
// 'Cancelled'/'Returned'). Recompute -2 * shipping inline to match the Profitability rule.
const PROFIT_EXPR = `CASE WHEN ${RETURN_LIKE} THEN -2 * COALESCE(orders.shipping_price, 0) ELSE COALESCE(orders.profit, 0) END`;
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
    const sku = searchParams.get("sku");
    const brand = searchParams.get("brand");
    const year = searchParams.get("year");
    const month = searchParams.get("month"); // YYYY-MM
    const state = searchParams.get("state");
    const city = searchParams.get("city");
    const tier = searchParams.get("tier");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    /* ── Build dynamic WHERE ── */
    const conditions: string[] = [
      "orders.purchase_date IS NOT NULL",
      "orders.purchase_date <= NOW()",
      "orders.item_price > 0",
      "(orders.amazon_order_id IS NULL OR orders.amazon_order_id NOT LIKE 'ORD-%')",
    ];
    const params: (string | number)[] = [];
    let idx = 1;

    if (sku) {
      const skus = sku.split(",").map(s => s.trim()).filter(Boolean);
      if (skus.length === 1) {
        conditions.push(`${NORM_SKU} = UPPER($${idx++})`);
        params.push(skus[0]);
      } else if (skus.length > 1) {
        const placeholders = skus.map(() => `UPPER($${idx++})`).join(",");
        conditions.push(`${NORM_SKU} IN (${placeholders})`);
        params.push(...skus);
      }
    }
    if (brand) { conditions.push(`LOWER(ec.brand) = LOWER($${idx++})`); params.push(brand); }
    if (year) { conditions.push(`EXTRACT(YEAR FROM orders.purchase_date AT TIME ZONE 'Asia/Kolkata') = $${idx++}`); params.push(parseInt(year)); }
    if (month) { conditions.push(`TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $${idx++}`); params.push(month); }
    if (state) {
      const keys = stateMatchKeys(state);
      if (keys.length === 0) {
        conditions.push("FALSE");
      } else {
        const placeholders = keys.map(() => `$${idx++}`).join(",");
        conditions.push(`${NORM_STATE} IN (${placeholders})`);
        params.push(...keys);
      }
    }
    if (city) {
      const cities = city.split(",").map(c => c.trim()).filter(Boolean);
      if (cities.length === 1) {
        conditions.push(`LOWER(orders.ship_city) = LOWER($${idx++})`); params.push(cities[0]);
      } else if (cities.length > 1) {
        const placeholders = cities.map(() => `LOWER($${idx++})`).join(",");
        conditions.push(`LOWER(orders.ship_city) IN (${placeholders})`); params.push(...cities);
      }
    }
    const safeStartDate = normalizeDateStr(startDate);
    const safeEndDate = normalizeDateStr(endDate);
    if (safeStartDate) { conditions.push(`(orders.purchase_date AT TIME ZONE 'Asia/Kolkata')::date >= $${idx++}::date`); params.push(safeStartDate); }
    if (safeEndDate) { conditions.push(`(orders.purchase_date AT TIME ZONE 'Asia/Kolkata')::date <= $${idx++}::date`); params.push(safeEndDate); }

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
          monthly: [], bySku: [], daily: [],
          filters: { skus: [], years: [], brands: [] },
        });
      }

      const placeholders = tierCities.map(() => `$${idx++}`).join(",");
      conditions.push(`orders.ship_city IN (${placeholders})`);
      params.push(...tierCities);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fromClause = `FROM orders ${estimatedCogsLateralJoin("orders")}`;

    // Monthly aggregated (grouped by Asia/Kolkata timezone to avoid boundary spillovers)
    const monthlyResult = await pool.query(`
      SELECT TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') as month,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
             COALESCE(SUM(${UNITS_EXPR}), 0) as total_units
      ${fromClause} ${where}
      GROUP BY TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
      ORDER BY month ASC
    `, params);

    // SKU-wise summary (variants collapsed to base SKU)
    const skuResult = await pool.query(`
      SELECT ${NORM_SKU} as sku,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
             COALESCE(SUM(${UNITS_EXPR}), 0) as total_units
      ${fromClause} ${where}
      GROUP BY ${NORM_SKU}
      ORDER BY total_revenue DESC
      LIMIT 20
    `, params);

    // Daily sales for the last 30 days (also filtered)
    const dailyResult = await pool.query(`
      SELECT TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as date,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit
      ${fromClause} ${where}
      ${conditions.length > 0 ? "AND" : "WHERE"} orders.purchase_date >= NOW() - INTERVAL '30 days'
      GROUP BY TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
      ORDER BY date ASC
    `, params);

    // Available filter options (unfiltered so user can always access all choices)
    const [filtersResult, yearsResult, brandsResult] = await Promise.all([
      pool.query(`SELECT DISTINCT ${normalizedSkuExpr("sku")} as sku FROM orders WHERE sku IS NOT NULL AND TRIM(sku) <> '' AND sku !~ '[|,]' ORDER BY sku`),
      pool.query(`SELECT DISTINCT EXTRACT(YEAR FROM purchase_date AT TIME ZONE 'Asia/Kolkata') as year FROM orders WHERE purchase_date IS NOT NULL AND purchase_date <= NOW() ORDER BY year DESC`),
      pool.query(`SELECT DISTINCT UPPER(brand) as brand FROM estimated_cogs WHERE brand IS NOT NULL ORDER BY brand`),
    ]);

    return NextResponse.json({
      monthly: monthlyResult.rows,
      bySku: skuResult.rows,
      daily: dailyResult.rows,
      filters: {
        skus: filtersResult.rows.map((r: { sku: string }) => r.sku),
        years: yearsResult.rows.map((r: { year: number }) => r.year),
        brands: brandsResult.rows.map((r: { brand: string }) => r.brand),
      },
    });
  } catch (error) {
    console.error("Sales summary error:", error);
    return NextResponse.json({ error: "Failed to fetch sales summary" }, { status: 500 });
  }
}
