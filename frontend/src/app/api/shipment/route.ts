import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { placedOrderConditions } from "@/lib/orderFilters";
import { normalizeProviderName } from "@/lib/shipment";
import { getShipmentWindowStart, parseShipmentMonthWindow } from "@/lib/shipmentWindow";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "100");
    const offset = parseInt(searchParams.get("offset") || "0");
    const filter = searchParams.get("filter") || "all"; // all | estimated | pending
    const orderId = (searchParams.get("orderId") || "").trim();
    const sku = (searchParams.get("sku") || "").trim();
    const months = parseShipmentMonthWindow(searchParams.get("months"));
    const windowStart = getShipmentWindowStart(months);

    const params: unknown[] = [windowStart];
    const baseConditions = [
      "o.ship_postal_code IS NOT NULL",
      "o.ship_postal_code != ''",
      "o.purchase_date >= $1",
      ...placedOrderConditions("o"),
    ];
    if (orderId) {
      params.push(`%${orderId}%`);
      baseConditions.push(`o.amazon_order_id ILIKE $${params.length}`);
    }
    if (sku) {
      params.push(`%${sku}%`);
      baseConditions.push(`o.sku ILIKE $${params.length}`);
    }

    const conditions = [...baseConditions];
    if (filter === "estimated") {
      conditions.push("se.id IS NOT NULL");
    } else if (filter === "pending") {
      conditions.push("se.id IS NULL");
    }
    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;

    // Fetch orders with their shipment estimates + product specs
    const estimatesResult = await pool.query(`
      SELECT
        o.amazon_order_id, o.sku, o.item_price, o.quantity, o.purchase_date,
        o.ship_postal_code as destination_pincode,
        o.ship_city as destination_city,
        o.ship_state as destination_state,
        o.fulfillment_channel,
        CASE
          WHEN o.shipping_price IS NOT NULL AND o.shipping_price > 0 THEN o.shipping_price
          WHEN se.amazon_shipping_cost IS NOT NULL AND se.amazon_shipping_cost > 0 THEN se.amazon_shipping_cost
          ELSE NULL
        END as amazon_shipping_cost,
        CASE
          WHEN o.shipping_price IS NOT NULL AND o.shipping_price > 0 THEN 'actual'
          WHEN se.amazon_shipping_cost IS NOT NULL AND se.amazon_shipping_cost > 0 THEN 'actual'
          ELSE NULL
        END as amazon_cost_source,
        se.delhivery_cost, se.bluedart_cost, se.dtdc_cost, se.xpressbees_cost, se.ekart_cost,
        se.cheapest_provider, se.cheapest_cost,
        se.delhivery_etd, se.bluedart_etd, se.dtdc_etd, se.xpressbees_etd, se.ekart_etd,
        se.estimated_at,
        CASE
          WHEN (
            LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%amazon%'
            OR LOWER(COALESCE(o.fulfillment_channel, '')) LIKE '%afn%'
          ) AND (
            (o.shipping_price IS NOT NULL AND o.shipping_price > 0)
            OR (
              se.rate_source = 'sp_api_finance'
              AND se.amazon_shipping_cost IS NOT NULL
              AND se.amazon_shipping_cost > 0
            )
          )
          THEN 'sp_api_finance'
          ELSE se.rate_source
        END as rate_source,
        ps.product_name,
        ps.weight_kg as actual_weight_kg,
        ps.volumetric_weight_kg,
        ps.chargeable_weight_kg,
        ps.length_cm, ps.width_cm, ps.height_cm
      FROM orders o
      LEFT JOIN shipment_estimates se ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
      LEFT JOIN product_specifications ps ON o.sku = ps.sku
      WHERE ${conditions.join(" AND ")}
      ORDER BY o.purchase_date DESC NULLS LAST
      LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
    `, [...params, limit, offset]);

    // Total count (for the current filter)
    const countResult = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM orders o
        LEFT JOIN shipment_estimates se
          ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
        WHERE ${conditions.join(" AND ")}
      `,
      params,
    );
    const total = parseInt(countResult.rows[0].total);

    // Overall summary
    const overallResult = await pool.query(`
      SELECT
        COUNT(*) as total_estimates,
        ROUND(AVG(
          CASE
            WHEN o.shipping_price IS NOT NULL AND o.shipping_price > 0 THEN o.shipping_price
            WHEN se.amazon_shipping_cost IS NOT NULL AND se.amazon_shipping_cost > 0 THEN se.amazon_shipping_cost
            ELSE NULL
          END
        )::numeric, 2) as avg_amazon_cost,
        ROUND(AVG(se.cheapest_cost)::numeric, 2) as avg_cheapest_cost,
        ROUND(AVG(se.delhivery_cost)::numeric, 2) as avg_delhivery_cost,
        ROUND(AVG(se.bluedart_cost)::numeric, 2) as avg_bluedart_cost,
        ROUND(AVG(se.dtdc_cost)::numeric, 2) as avg_dtdc_cost,
        ROUND(AVG(se.xpressbees_cost)::numeric, 2) as avg_xpressbees_cost,
        ROUND(AVG(se.ekart_cost)::numeric, 2) as avg_ekart_cost,
        ROUND(SUM(GREATEST(
          COALESCE(
            CASE
              WHEN o.shipping_price IS NOT NULL AND o.shipping_price > 0 THEN o.shipping_price
              WHEN se.amazon_shipping_cost IS NOT NULL AND se.amazon_shipping_cost > 0 THEN se.amazon_shipping_cost
              ELSE NULL
            END,
            0
          ) - COALESCE(se.cheapest_cost, 0),
          0
        ))::numeric, 2) as total_potential_savings
      FROM shipment_estimates se
      LEFT JOIN orders o
        ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
      WHERE ${baseConditions.join(" AND ")}
    `, params);

    // Provider wins breakdown — normalize names on the fly
    const winsResult = await pool.query(`
      SELECT cheapest_provider as provider, COUNT(*) as wins
      FROM shipment_estimates se
      INNER JOIN orders o
        ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
      WHERE cheapest_provider IS NOT NULL AND cheapest_provider != ''
        AND ${baseConditions.join(" AND ")}
      GROUP BY cheapest_provider
      ORDER BY wins DESC
    `, params);

    // Merge wins for variant names (e.g. "XpressBees" and "Xpressbees")
    const winsMap: Record<string, number> = {};
    for (const r of winsResult.rows) {
      const normalized = normalizeProviderName(r.provider as string);
      winsMap[normalized] = (winsMap[normalized] || 0) + parseInt(r.wins as string);
    }
    const providerWins = Object.entries(winsMap)
      .map(([provider, wins]) => ({ provider, wins }))
      .sort((a, b) => b.wins - a.wins);

    // Pending count (orders without estimates)
    const pendingResult = await pool.query(`
      SELECT COUNT(*) as pending FROM orders o
      LEFT JOIN shipment_estimates se ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
      WHERE ${baseConditions.join(" AND ")}
        AND se.id IS NULL
    `, params);

    return NextResponse.json({
      estimates: estimatesResult.rows,
      total,
      months,
      summary: overallResult.rows[0] || {},
      providerWins,
      pendingCount: parseInt(pendingResult.rows[0].pending),
      pagination: { total, limit, offset },
    });
  } catch (error) {
    console.error("Shipment API error:", error);
    return NextResponse.json({ error: "Failed to fetch shipment data" }, { status: 500 });
  }
}

/** PUT — normalize all existing provider names in DB */
export async function PUT() {
  try {
    // Fix inconsistent provider names in existing data
    const updates = [
      ["XpressBees", "Xpressbees"],
      ["expressbees", "Xpressbees"],
      ["Expressbees", "Xpressbees"],
      ["xpressbees", "Xpressbees"],
      ["bluedartt", "BlueDart"],
      ["Bluedartt", "BlueDart"],
    ];
    let fixed = 0;
    for (const [oldName, newName] of updates) {
      const result = await pool.query(
        `UPDATE shipment_estimates SET cheapest_provider = $1 WHERE cheapest_provider = $2`,
        [newName, oldName]
      );
      fixed += result.rowCount || 0;
    }
    return NextResponse.json({ message: `Normalized ${fixed} provider name(s)`, fixed });
  } catch (error) {
    console.error("Shipment normalize error:", error);
    return NextResponse.json({ error: "Failed to normalize" }, { status: 500 });
  }
}
