import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { placedOrderConditions } from "@/lib/orderFilters";
import {
  getCarrierRates, findCheapest,
  normalizePincode, normalizeProviderName, ORIGIN_PIN,
  isAmazonFulfilled, ShiprocketDimensions,
} from "@/lib/shipment";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amazon_order_id, sku } = body;

    if (!amazon_order_id || !sku) {
      return NextResponse.json({ error: "Missing amazon_order_id or sku" }, { status: 400 });
    }

    const orderResult = await pool.query(`
      SELECT o.amazon_order_id, o.sku,
             o.ship_postal_code as destination_pincode,
             o.ship_city as destination_city,
             o.ship_state as destination_state,
             o.fulfillment_channel,
             o.shipping_price as recorded_amazon_shipping_cost,
             ps.weight_kg, ps.volumetric_weight_kg, ps.chargeable_weight_kg,
             ps.length_cm, ps.width_cm, ps.height_cm
      FROM orders o
      LEFT JOIN product_specifications ps ON o.sku = ps.sku
      WHERE o.amazon_order_id = $1 AND o.sku = $2
        AND ${placedOrderConditions("o").join(" AND ")}
    `, [amazon_order_id, sku]);

    const order = orderResult.rows[0];
    if (!order || !order.destination_pincode) {
      return NextResponse.json({ error: "Order not found or missing postal code" }, { status: 404 });
    }
    const destinationPincode = normalizePincode(order.destination_pincode);
    if (destinationPincode.length !== 6) {
      return NextResponse.json({ error: "Order has an invalid postal code" }, { status: 400 });
    }

    const actualWeight = parseFloat(order.weight_kg) || 0.5;
    const volumetricWeight = order.volumetric_weight_kg ? parseFloat(order.volumetric_weight_kg) : null;
    const chargeableWeight = parseFloat(order.chargeable_weight_kg) || actualWeight;
    const recordedAmazonCost = Number(order.recorded_amazon_shipping_cost) || 0;
    const isAmazonOrder = isAmazonFulfilled(order.fulfillment_channel);

    const dims: ShiprocketDimensions = {};
    if (order.length_cm) dims.length = parseFloat(order.length_cm);
    if (order.width_cm) dims.breadth = parseFloat(order.width_cm);
    if (order.height_cm) dims.height = parseFloat(order.height_cm);

    const { rates, source } = await getCarrierRates(ORIGIN_PIN, destinationPincode, chargeableWeight, dims);
    const amazonCost = isAmazonOrder ? recordedAmazonCost : 0;
    const { cheapestProvider, cheapestCost } = findCheapest(rates, amazonCost);

    const rateSource = source === "shiprocket"
      ? "shiprocket"
      : (isAmazonOrder && amazonCost > 0 ? "sp_api_finance" : source);

    await pool.query(`
      INSERT INTO shipment_estimates (
        amazon_order_id, sku, origin_pincode,
        destination_pincode, destination_city, destination_state,
        package_weight_kg, volumetric_weight_kg, chargeable_weight_kg,
        amazon_shipping_cost,
        delhivery_cost, bluedart_cost, dtdc_cost, xpressbees_cost, ekart_cost,
        delhivery_etd, bluedart_etd, dtdc_etd, xpressbees_etd, ekart_etd,
        cheapest_provider, cheapest_cost, rate_source, estimated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()
      )
      ON CONFLICT (amazon_order_id, sku) DO UPDATE SET
        destination_pincode=EXCLUDED.destination_pincode, destination_city=EXCLUDED.destination_city,
        destination_state=EXCLUDED.destination_state, package_weight_kg=EXCLUDED.package_weight_kg,
        volumetric_weight_kg=EXCLUDED.volumetric_weight_kg, chargeable_weight_kg=EXCLUDED.chargeable_weight_kg,
        amazon_shipping_cost=EXCLUDED.amazon_shipping_cost,
        delhivery_cost=EXCLUDED.delhivery_cost, bluedart_cost=EXCLUDED.bluedart_cost,
        dtdc_cost=EXCLUDED.dtdc_cost, xpressbees_cost=EXCLUDED.xpressbees_cost,
        ekart_cost=EXCLUDED.ekart_cost,
        delhivery_etd=EXCLUDED.delhivery_etd, bluedart_etd=EXCLUDED.bluedart_etd,
        dtdc_etd=EXCLUDED.dtdc_etd, xpressbees_etd=EXCLUDED.xpressbees_etd,
        ekart_etd=EXCLUDED.ekart_etd,
        cheapest_provider=EXCLUDED.cheapest_provider, cheapest_cost=EXCLUDED.cheapest_cost,
        rate_source=EXCLUDED.rate_source, estimated_at=NOW()
    `, [
      amazon_order_id, sku, ORIGIN_PIN,
      destinationPincode, order.destination_city, order.destination_state,
      actualWeight, volumetricWeight, chargeableWeight,
      amazonCost || 0,
      rates.delhivery?.cost ?? null, rates.bluedart?.cost ?? null,
      rates.dtdc?.cost ?? null, rates.xpressbees?.cost ?? null, rates.ekart?.cost ?? null,
      rates.delhivery?.etd ?? null, rates.bluedart?.etd ?? null,
      rates.dtdc?.etd ?? null, rates.xpressbees?.etd ?? null, rates.ekart?.etd ?? null,
      normalizeProviderName(cheapestProvider), cheapestCost === Infinity ? null : cheapestCost,
      rateSource,
    ]);

    return NextResponse.json({
      status: "success",
      message: `Rate estimated (${rateSource})`,
      cheapest_provider: normalizeProviderName(cheapestProvider),
      rate_source: rateSource,
    });
  } catch (error) {
    console.error("Single estimate error:", error);
    return NextResponse.json({ error: "Failed to estimate rate" }, { status: 500 });
  }
}
