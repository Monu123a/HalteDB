import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { getCityTier } from "@/lib/cityTiers";
import {
  canonicalState,
  stateMatchKeys,
  stateNormalizeSqlExpr,
} from "@/lib/stateNormalize";
import { normalizedSkuExpr, estimatedCogsLateralJoin } from "@/lib/skuNormalize";

const NORM_STATE = stateNormalizeSqlExpr("orders.ship_state");
const NORM_SKU = normalizedSkuExpr("orders.sku");

// Matches Cancelled, CANCELLED, Returned, RETURNED, RTO, "Shipped - Returned to Seller", etc.
const RETURN_LIKE = "LOWER(COALESCE(orders.order_status, '')) ~ '(cancel|return|rto)'";
const REVENUE_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE orders.item_price END`;
const UNITS_EXPR = `CASE WHEN ${RETURN_LIKE} THEN 0 ELSE orders.quantity END`;
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
    const state = searchParams.get("state");
    const city = searchParams.get("city");
    const tier = searchParams.get("tier"); // "Tier 1", "Tier 2", "Tier 3"
    const sku = searchParams.get("sku");
    const brand = searchParams.get("brand");
    const year = searchParams.get("year");
    const month = searchParams.get("month"); // YYYY-MM
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    /* ── Build WHERE clause ── */
    let where = "WHERE orders.ship_city IS NOT NULL AND orders.ship_city != '' AND orders.purchase_date <= NOW() AND orders.item_price > 0 AND (orders.amazon_order_id IS NULL OR orders.amazon_order_id NOT LIKE 'ORD-%')";
    const params: (string | number)[] = [];
    let idx = 1;

    if (state) {
      const keys = stateMatchKeys(state);
      if (keys.length === 0) {
        where += ` AND FALSE`;
      } else {
        const placeholders = keys.map(() => `$${idx++}`).join(",");
        where += ` AND ${NORM_STATE} IN (${placeholders})`;
        params.push(...keys);
      }
    }
    if (city) {
      const cities = city.split(",").map(c => c.trim()).filter(Boolean);
      if (cities.length === 1) {
        where += ` AND LOWER(orders.ship_city) = LOWER($${idx++})`;
        params.push(cities[0]);
      } else if (cities.length > 1) {
        const placeholders = cities.map(() => `LOWER($${idx++})`).join(",");
        where += ` AND LOWER(orders.ship_city) IN (${placeholders})`;
        params.push(...cities);
      }
    }
    if (sku) {
      const skus = sku.split(",").map(s => s.trim()).filter(Boolean);
      if (skus.length === 1) {
        where += ` AND ${NORM_SKU} = UPPER($${idx++})`;
        params.push(skus[0]);
      } else if (skus.length > 1) {
        const placeholders = skus.map(() => `UPPER($${idx++})`).join(",");
        where += ` AND ${NORM_SKU} IN (${placeholders})`;
        params.push(...skus);
      }
    }
    if (brand) {
      where += ` AND LOWER(ec.brand) = LOWER($${idx++})`;
      params.push(brand);
    }
    if (year) {
      where += ` AND EXTRACT(YEAR FROM orders.purchase_date AT TIME ZONE 'Asia/Kolkata') = $${idx++}`;
      params.push(parseInt(year));
    }
    if (month) {
      where += ` AND TO_CHAR(orders.purchase_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $${idx++}`;
      params.push(month);
    }
    const safeStartDate = normalizeDateStr(startDate);
    const safeEndDate = normalizeDateStr(endDate);
    if (safeStartDate) {
      where += ` AND (orders.purchase_date AT TIME ZONE 'Asia/Kolkata')::date >= $${idx++}::date`;
      params.push(safeStartDate);
    }
    if (safeEndDate) {
      where += ` AND (orders.purchase_date AT TIME ZONE 'Asia/Kolkata')::date <= $${idx++}::date`;
      params.push(safeEndDate);
    }

    /* ── Tier filter: resolve tier → city list, add SQL IN-clause ── */
    if (tier) {
      // Get all distinct city names from DB, classify them, and filter
      const allCitiesRes = await pool.query(
        "SELECT DISTINCT ship_city FROM orders WHERE ship_city IS NOT NULL AND ship_city != ''"
      );
      const tierCities = allCitiesRes.rows
        .map((r: { ship_city: string }) => r.ship_city)
        .filter((c: string) => getCityTier(c) === tier);

      if (tierCities.length === 0) {
        // No cities in this tier — return empty results
        return NextResponse.json({
          byState: [],
          byCity: [],
          byTier: [
            { tier: "Tier 1", total_orders: 0, total_revenue: 0, total_profit: 0, total_units: 0 },
            { tier: "Tier 2", total_orders: 0, total_revenue: 0, total_profit: 0, total_units: 0 },
            { tier: "Tier 3", total_orders: 0, total_revenue: 0, total_profit: 0, total_units: 0 },
          ],
          filters: { states: [], cities: [] },
        });
      }

      // Build parameterized IN clause
      const placeholders = tierCities.map(() => `$${idx++}`).join(",");
      where += ` AND orders.ship_city IN (${placeholders})`;
      params.push(...tierCities);
    }

    const fromClause = `FROM orders ${estimatedCogsLateralJoin("orders")}`;

    /* ── By State ── */
    const byStateQuery = `
      SELECT orders.ship_state as state,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
             COALESCE(SUM(${UNITS_EXPR}), 0) as total_units
      ${fromClause} ${where}
      AND orders.ship_state IS NOT NULL AND orders.ship_state != ''
      GROUP BY orders.ship_state
      ORDER BY total_revenue DESC
    `;
    const byStateResult = await pool.query(byStateQuery, params);

    /* ── By City ── */
    const byCityQuery = `
      SELECT orders.ship_city as city, orders.ship_state as state,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
             COALESCE(SUM(${UNITS_EXPR}), 0) as total_units
      ${fromClause} ${where}
      GROUP BY orders.ship_city, orders.ship_state
      ORDER BY total_revenue DESC
    `;
    const byCityResult = await pool.query(byCityQuery, params);

    /* ── Attach tier labels + canonical state ── */
    const citiesWithTier = byCityResult.rows.map((r: Record<string, unknown>) => ({
      ...r,
      state: canonicalState(r.state as string) ?? r.state,
      tier: getCityTier(r.city as string),
    }));

    /* ── Collapse raw ship_state rows into canonical state buckets ── */
    type StateAgg = { orders: number; revenue: number; profit: number; units: number };
    const stateAgg = new Map<string, StateAgg>();
    for (const row of byStateResult.rows) {
      const canon = canonicalState(row.state as string);
      if (!canon) continue;
      const cur = stateAgg.get(canon) ?? { orders: 0, revenue: 0, profit: 0, units: 0 };
      cur.orders += parseInt(row.total_orders) || 0;
      cur.revenue += parseFloat(row.total_revenue) || 0;
      cur.profit += parseFloat(row.total_profit) || 0;
      cur.units += parseInt(row.total_units) || 0;
      stateAgg.set(canon, cur);
    }
    const byState = Array.from(stateAgg.entries())
      .map(([state, v]) => ({
        state,
        total_orders: v.orders,
        total_revenue: v.revenue,
        total_profit: v.profit,
        total_units: v.units,
      }))
      .sort((a, b) => b.total_revenue - a.total_revenue);

    /* ── By Tier (aggregated from current filtered results) ── */
    const allCitiesQuery = `
      SELECT orders.ship_city as city,
             ${ACTIVE_COUNT_EXPR} as total_orders,
             COALESCE(SUM(${REVENUE_EXPR}), 0) as total_revenue,
             COALESCE(SUM(${PROFIT_EXPR}), 0) as total_profit,
             COALESCE(SUM(${UNITS_EXPR}), 0) as total_units
      ${fromClause} ${where}
      GROUP BY orders.ship_city
    `;
    const allCitiesResult = await pool.query(allCitiesQuery, params);

    const tierAgg: Record<string, { orders: number; revenue: number; profit: number; units: number }> = {
      "Tier 1": { orders: 0, revenue: 0, profit: 0, units: 0 },
      "Tier 2": { orders: 0, revenue: 0, profit: 0, units: 0 },
      "Tier 3": { orders: 0, revenue: 0, profit: 0, units: 0 },
    };

    for (const row of allCitiesResult.rows) {
      const t = getCityTier(row.city);
      if (tierAgg[t]) {
        tierAgg[t].orders += parseInt(row.total_orders);
        tierAgg[t].revenue += parseFloat(row.total_revenue);
        tierAgg[t].profit += parseFloat(row.total_profit);
        tierAgg[t].units += parseInt(row.total_units);
      }
    }

    const byTier = Object.entries(tierAgg).map(([name, data]) => ({
      tier: name,
      total_orders: data.orders,
      total_revenue: data.revenue,
      total_profit: data.profit,
      total_units: data.units,
    }));

    /* ── Filter Lists ── */
    const statesListQuery = `
      SELECT DISTINCT ship_state as state FROM orders 
      WHERE ship_state IS NOT NULL AND ship_state != ''
      ORDER BY ship_state
    `;
    const citiesListQuery = `
      SELECT DISTINCT ship_city as city FROM orders 
      WHERE ship_city IS NOT NULL AND ship_city != ''
      ORDER BY ship_city
    `;
    const [statesList, citiesList] = await Promise.all([
      pool.query(statesListQuery),
      pool.query(citiesListQuery),
    ]);

    const canonicalStates = Array.from(
      new Set(
        statesList.rows
          .map((r: { state: string }) => canonicalState(r.state))
          .filter((s: string | null): s is string => !!s),
      ),
    ).sort((a: string, b: string) => a.localeCompare(b));

    return NextResponse.json({
      byState,
      byCity: citiesWithTier,
      byTier,
      filters: {
        states: canonicalStates,
        cities: citiesList.rows.map((r: { city: string }) => r.city),
      },
    });
  } catch (error) {
    console.error("Geography API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch geography data" },
      { status: 500 }
    );
  }
}
