import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";

import pool from "@/lib/db";
import { placedOrderConditions } from "@/lib/orderFilters";
import {
  formatShipmentTimestamp,
  getShipmentWindowStart,
  parseShipmentMonthWindow,
  sanitizeShipmentFilenamePart,
} from "@/lib/shipmentWindow";

export const runtime = "nodejs";

function jsonSheet(rows: Record<string, unknown>[], header?: string[]) {
  return XLSX.utils.json_to_sheet(rows, header ? { header } : undefined);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filter = searchParams.get("filter") || "all";
    const orderId = (searchParams.get("orderId") || "").trim();
    const sku = (searchParams.get("sku") || "").trim();
    const months = parseShipmentMonthWindow(searchParams.get("months"));
    const windowStart = getShipmentWindowStart(months);

    const params: unknown[] = [windowStart];
    const conditions = [
      "o.ship_postal_code IS NOT NULL",
      "o.ship_postal_code != ''",
      `o.purchase_date >= $${params.length}`,
      ...placedOrderConditions("o"),
    ];
    if (orderId) {
      params.push(`%${orderId}%`);
      conditions.push(`o.amazon_order_id ILIKE $${params.length}`);
    }
    if (sku) {
      params.push(`%${sku}%`);
      conditions.push(`o.sku ILIKE $${params.length}`);
    }

    if (filter === "estimated") {
      conditions.push("se.id IS NOT NULL");
    } else if (filter === "pending") {
      conditions.push("se.id IS NULL");
    }

    const result = await pool.query(
      `
        SELECT
          o.amazon_order_id,
          RIGHT(COALESCE(o.amazon_order_id, ''), 8) AS order_id_identifier,
          o.purchase_date,
          o.sku,
          o.order_status,
          o.item_status,
          ps.product_name,
          o.ship_city AS destination_city,
          o.ship_state AS destination_state,
          o.ship_postal_code AS destination_pincode,
          o.fulfillment_channel,
          CASE
            WHEN o.shipping_price IS NOT NULL AND o.shipping_price > 0 THEN o.shipping_price
            WHEN se.amazon_shipping_cost IS NOT NULL
              AND se.amazon_shipping_cost > 0 THEN se.amazon_shipping_cost
            ELSE NULL
          END AS amazon_shipping_cost,
          se.delhivery_cost,
          se.bluedart_cost,
          se.dtdc_cost,
          se.xpressbees_cost,
          se.ekart_cost,
          se.cheapest_provider,
          se.cheapest_cost,
          se.rate_source,
          se.estimated_at
        FROM orders o
        LEFT JOIN shipment_estimates se
          ON o.amazon_order_id = se.amazon_order_id AND o.sku = se.sku
        LEFT JOIN product_specifications ps
          ON o.sku = ps.sku
        WHERE ${conditions.join(" AND ")}
        ORDER BY o.purchase_date DESC NULLS LAST, o.amazon_order_id, o.sku
      `,
      params,
    );

    const rows = result.rows.map((row) => ({
      "Order ID": row.amazon_order_id,
      "Order ID Identifier": row.order_id_identifier || null,
      "Purchase Date": formatShipmentTimestamp(row.purchase_date),
      SKU: row.sku,
      "Order Status": row.order_status || null,
      "Item Status": row.item_status || null,
      "Product Name": row.product_name || null,
      City: row.destination_city || null,
      State: row.destination_state || null,
      Pincode: row.destination_pincode || null,
      "Fulfillment Channel": row.fulfillment_channel || null,
      "Amazon Cost": row.amazon_shipping_cost == null ? null : Number(row.amazon_shipping_cost),
      Delhivery: row.delhivery_cost == null ? null : Number(row.delhivery_cost),
      BlueDart: row.bluedart_cost == null ? null : Number(row.bluedart_cost),
      DTDC: row.dtdc_cost == null ? null : Number(row.dtdc_cost),
      Xpressbees: row.xpressbees_cost == null ? null : Number(row.xpressbees_cost),
      Ekart: row.ekart_cost == null ? null : Number(row.ekart_cost),
      "Cheapest Provider": row.cheapest_provider || null,
      "Cheapest Cost": row.cheapest_cost == null ? null : Number(row.cheapest_cost),
      "Rate Source": row.rate_source || null,
      "Estimated At": formatShipmentTimestamp(row.estimated_at),
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      jsonSheet(rows, [
        "Order ID",
        "Order ID Identifier",
        "Purchase Date",
        "SKU",
        "Order Status",
        "Item Status",
        "Product Name",
        "City",
        "State",
        "Pincode",
        "Fulfillment Channel",
        "Amazon Cost",
        "Delhivery",
        "BlueDart",
        "DTDC",
        "Xpressbees",
        "Ekart",
        "Cheapest Provider",
        "Cheapest Cost",
        "Rate Source",
        "Estimated At",
      ]),
      "Shipments",
    );

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filterPart = filter === "all" ? "placed" : filter;
    const orderPart = orderId ? `_order_${sanitizeShipmentFilenamePart(orderId)}` : "";
    const skuPart = sku ? `_sku_${sanitizeShipmentFilenamePart(sku)}` : "";
    const filename = `haltedb_shipments_${sanitizeShipmentFilenamePart(filterPart)}${orderPart}${skuPart}_last_${months}_month${months === 1 ? "" : "s"}_${dateStr}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Shipment report error:", error);
    return NextResponse.json(
      { error: "Failed to generate shipment report" },
      { status: 500 },
    );
  }
}
