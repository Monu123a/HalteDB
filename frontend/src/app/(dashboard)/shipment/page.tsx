"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, useCallback } from "react";
import { SHIPMENT_MONTH_OPTIONS, type ShipmentMonthWindow, getShipmentWindowLabel } from "@/lib/shipmentWindow";

const CARRIERS = [
  { key: "amazon", label: "Amazon FBA", color: "#ff9900" },
  { key: "delhivery", label: "Delhivery", color: "#e23744" },
  { key: "bluedart", label: "BlueDart", color: "#0066cc" },
  { key: "dtdc", label: "DTDC", color: "#d42027" },
  { key: "xpressbees", label: "Xpressbees", color: "#f5a623" },
  { key: "ekart", label: "Ekart", color: "#2874f0" },
];

interface ShipmentEstimate {
  amazon_order_id: string;
  sku: string;
  destination_pincode: string;
  destination_city: string;
  destination_state: string;
  fulfillment_channel: string | null;
  actual_weight_kg: number | null;
  volumetric_weight_kg: number | null;
  chargeable_weight_kg: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  amazon_shipping_cost: number | null;
  amazon_cost_source: string | null;
  delhivery_cost: number | null;
  bluedart_cost: number | null;
  dtdc_cost: number | null;
  xpressbees_cost: number | null;
  ekart_cost: number | null;
  cheapest_provider: string;
  cheapest_cost: number;
  delhivery_etd: string;
  bluedart_etd: string;
  dtdc_etd: string;
  xpressbees_etd: string;
  ekart_etd: string;
  estimated_at: string;
  rate_source: string | null;
  item_price: number;
  purchase_date: string;
  product_name: string;
}

interface Summary {
  total_estimates: number;
  avg_amazon_cost: number;
  avg_cheapest_cost: number;
  avg_delhivery_cost: number;
  avg_bluedart_cost: number;
  avg_dtdc_cost: number;
  avg_xpressbees_cost: number;
  avg_ekart_cost: number;
  total_potential_savings: number;
}

type FilterMode = "all" | "estimated" | "pending";

const FILTER_LABELS: Record<FilterMode, string> = {
  all: "Placed",
  estimated: "Estimated",
  pending: "Pending",
};

function getRateSourceBadge(rateSource: string | null) {
  switch (rateSource) {
    case "shiprocket":
      return {
        label: "LIVE",
        background: "rgba(34,197,94,0.15)",
        color: "#22c55e",
      };
    case "fallback":
      return {
        label: "EST",
        background: "rgba(251,191,36,0.15)",
        color: "#f59e0b",
      };
    case "shiprocket_failed":
      return {
        label: "NO QUOTE",
        background: "rgba(239,68,68,0.15)",
        color: "#f87171",
      };
    case "sp_api_finance":
      return {
        label: "SP API",
        background: "rgba(59,130,246,0.15)",
        color: "#60a5fa",
      };
    case "sp_api_pending":
      return {
        label: "PENDING",
        background: "rgba(148,163,184,0.16)",
        color: "#cbd5e1",
      };
    default:
      return null;
  }
}

function describeRateSource(rateSource: string | null) {
  switch (rateSource) {
    case "shiprocket":
      return "live";
    case "fallback":
      return "estimated from rate cards";
    case "shiprocket_failed":
      return "no Shiprocket quote";
    case "sp_api_finance":
      return "synced from SP API";
    case "sp_api_pending":
      return "waiting on SP API";
    default:
      return "updated";
  }
}

const fmt = (n: number | null | undefined) => {
  if (n == null) return "\u2014";
  return `\u20B9${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const fmtDecimal = (n: number | null | undefined) => {
  if (n == null) return "\u2014";
  return `\u20B9${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtWeight = (n: number | null | undefined) => {
  if (n == null) return "\u2014";
  return `${Number(n).toFixed(2)} kg`;
};

const fmtDate = (d: string | null | undefined) => {
  if (!d) return "\u2014";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

const PAGE_SIZE = 50;

export default function ShipmentPage() {
  const [estimates, setEstimates] = useState<ShipmentEstimate[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [providerWins, setProviderWins] = useState<{ provider: string; wins: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const [recalculating, setRecalculating] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sortField, setSortField] = useState<string>("purchase_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [monthWindow, setMonthWindow] = useState<ShipmentMonthWindow>(1);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [orderIdSearch, setOrderIdSearch] = useState("");
  const [appliedOrderIdSearch, setAppliedOrderIdSearch] = useState("");
  const [skuSearch, setSkuSearch] = useState("");
  const [appliedSkuSearch, setAppliedSkuSearch] = useState("");

  const fetchData = useCallback(async (
    currentFilter?: FilterMode,
    currentPage?: number,
    currentMonthWindow?: ShipmentMonthWindow,
    currentOrderIdSearch?: string,
    currentSkuSearch?: string,
  ) => {
    setLoading(true);
    const f = currentFilter ?? filter;
    const p = currentPage ?? page;
    const m = currentMonthWindow ?? monthWindow;
    const orderSearch = currentOrderIdSearch ?? appliedOrderIdSearch;
    const skuLookup = currentSkuSearch ?? appliedSkuSearch;
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(p * PAGE_SIZE),
        filter: f,
        months: String(m),
      });
      if (orderSearch.trim()) {
        params.set("orderId", orderSearch.trim());
      }
      if (skuLookup.trim()) {
        params.set("sku", skuLookup.trim());
      }
      const res = await fetch(`/api/shipment?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEstimates(data.estimates || []);
        setSummary(data.summary || null);
        setProviderWins(data.providerWins || []);
        setTotal(data.pagination?.total || 0);
        setPendingCount(data.pendingCount || 0);
      }
    } catch (e) {
      console.error("Failed to fetch shipment data", e);
    }
    setLoading(false);
  }, [filter, page, monthWindow, appliedOrderIdSearch, appliedSkuSearch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const triggerEstimate = async () => {
    setEstimating(true);
    setToast(null);
    try {
      const res = await fetch("/api/shipment/estimate", { method: "POST" });
      const data = await res.json();
      setToast(data.message || "Estimation complete");
      await fetchData();
    } catch {
      setToast("Failed to estimate rates");
    }
    setEstimating(false);
    setTimeout(() => setToast(null), 5000);
  };

  const recalculateOrder = async (orderId: string, sku: string) => {
    const key = `${orderId}-${sku}`;
    setRecalculating(key);
    try {
      const r = await fetch("/api/shipment/estimate-single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amazon_order_id: orderId, sku })
      });
      const data = await r.json();
      if (r.ok) {
        setToast(`Rate ${describeRateSource(data.rate_source)} for ${orderId.slice(-8)}`);
        fetchData();
      } else {
        setToast(data.error || "Failed to calculate rate");
      }
    } catch {
      setToast("Error calculating rate");
    }
    setRecalculating(null);
    setTimeout(() => setToast(null), 4000);
  };

  const sorted = [...estimates].sort((a: any, b: any) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (sortField === "purchase_date") {
      const aDate = aVal ? new Date(aVal as string).getTime() : 0;
      const bDate = bVal ? new Date(bVal as string).getTime() : 0;
      return sortDir === "asc" ? aDate - bDate : bDate - aDate;
    }
    const aNum = Number(aVal) || 0;
    const bNum = Number(bVal) || 0;
    return sortDir === "asc" ? aNum - bNum : bNum - aNum;
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "purchase_date" ? "desc" : "asc");
    }
  };

  const changeFilter = (f: FilterMode) => {
    setFilter(f);
    setPage(0);
    fetchData(f, 0, undefined, appliedOrderIdSearch, appliedSkuSearch);
  };

  const changeMonthWindow = (value: ShipmentMonthWindow) => {
    setMonthWindow(value);
    setPage(0);
    fetchData(filter, 0, value, appliedOrderIdSearch, appliedSkuSearch);
  };

  const applySearch = () => {
    const nextOrderSearch = orderIdSearch.trim();
    const nextSkuSearch = skuSearch.trim();
    setAppliedOrderIdSearch(nextOrderSearch);
    setAppliedSkuSearch(nextSkuSearch);
    setPage(0);
    fetchData(filter, 0, monthWindow, nextOrderSearch, nextSkuSearch);
  };

  const clearSearch = () => {
    setOrderIdSearch("");
    setAppliedOrderIdSearch("");
    setSkuSearch("");
    setAppliedSkuSearch("");
    setPage(0);
    fetchData(filter, 0, monthWindow, "", "");
  };

  const handleDownloadExcel = async () => {
    setDownloadingReport(true);
    try {
      const params = new URLSearchParams({
        filter,
        months: String(monthWindow),
      });
      if (appliedOrderIdSearch.trim()) {
        params.set("orderId", appliedOrderIdSearch.trim());
      }
      if (appliedSkuSearch.trim()) {
        params.set("sku", appliedSkuSearch.trim());
      }
      const res = await fetch(`/api/shipment/report?${params.toString()}`);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast(data.error || "Failed to download Excel");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;

      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename=\"([^\"]+)\"/);
      link.download = filenameMatch?.[1] || "haltedb_shipments.xlsx";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setToast(`Downloaded ${getShipmentWindowLabel(monthWindow).toLowerCase()} shipment report`);
    } catch {
      setToast("Network error while downloading Excel");
    } finally {
      setDownloadingReport(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const totalWins = providerWins.reduce((s, p) => s + p.wins, 0) || 1;
  const activeSearchParts = [
    appliedOrderIdSearch ? `order ${appliedOrderIdSearch}` : null,
    appliedSkuSearch ? `SKU ${appliedSkuSearch}` : null,
  ].filter(Boolean);
  const activeSearchSummary = activeSearchParts.length > 0 ? ` matching ${activeSearchParts.join(" and ")}` : "";

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1500 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>Shipment Rate Comparison</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 14 }}>
            Compare shipping costs across carriers &middot; Origin: Chandigarh (160012)
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={triggerEstimate}
            disabled={estimating}
            className="btn btn-primary"
            style={{ fontSize: 14, padding: "10px 24px", gap: 8, display: "flex", alignItems: "center" }}
          >
            {estimating ? (
              <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Estimating...</>
            ) : (
              <>Estimate New Orders {pendingCount > 0 && <span style={{
                background: "rgba(255,255,255,0.25)", borderRadius: 10, padding: "1px 8px", fontSize: 11, marginLeft: 4
              }}>{pendingCount}</span>}</>
            )}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
          <KPICard title="AVG AMAZON COST" value={fmtDecimal(summary.avg_amazon_cost)} color="#ff9900" />
          <KPICard title="AVG CHEAPEST ALT" value={fmtDecimal(summary.avg_cheapest_cost)} color="#22c55e" />
          <KPICard title="AVG DELHIVERY" value={fmtDecimal(summary.avg_delhivery_cost)} color="#e23744" />
          <KPICard title="AVG BLUEDART" value={fmtDecimal(summary.avg_bluedart_cost)} color="#0066cc" />
          <KPICard
            title="POTENTIAL SAVINGS"
            value={fmt(summary.total_potential_savings)}
            color="#a855f7"
            subtitle={`Across ${summary.total_estimates} orders`}
          />
        </div>
      )}

      {/* Provider Wins + Avg Rates Chart */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Who Wins Most Often?</h3>
          {providerWins.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No data yet</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {providerWins.map((p) => {
                const carrier = CARRIERS.find(c =>
                  c.label.toLowerCase() === p.provider.toLowerCase() || p.provider.toLowerCase().includes(c.key)
                );
                const pct = Math.round((p.wins / totalWins) * 100);
                return (
                  <div key={p.provider}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{p.provider}</span>
                      <span style={{ color: "var(--text-muted)" }}>{p.wins} wins ({pct}%)</span>
                    </div>
                    <div style={{ background: "var(--bg-tertiary)", borderRadius: 6, height: 8, overflow: "hidden" }}>
                      <div style={{
                        width: `${pct}%`, height: "100%",
                        background: carrier?.color || "#888",
                        borderRadius: 6, transition: "width 0.5s ease",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Average Rate by Carrier</h3>
          {!summary ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No data yet</p>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 16, height: 180, paddingTop: 10 }}>
              {CARRIERS.map((c) => {
                const val = summary[`avg_${c.key}_cost` as keyof Summary] as number || 0;
                const maxVal = Math.max(
                  ...(CARRIERS.map(cc => (summary[`avg_${cc.key}_cost` as keyof Summary] as number) || 0))
                );
                const heightPct = maxVal > 0 ? (val / maxVal) * 100 : 0;
                return (
                  <div key={c.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: c.color }}>{val > 0 ? `\u20B9${val}` : "\u2014"}</span>
                    <div style={{
                      width: "100%",
                      height: `${Math.max(heightPct, 5)}%`,
                      background: `linear-gradient(180deg, ${c.color}, ${c.color}88)`,
                      borderRadius: "6px 6px 0 0", minHeight: 4,
                      transition: "height 0.5s ease",
                    }} />
                    <span style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center" }}>{c.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Filter Tabs + Table */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Order-wise Rate Comparison</h3>
            <div style={{ display: "flex", gap: 4 }}>
              {(["all", "estimated", "pending"] as FilterMode[]).map(f => (
                <button key={f} onClick={() => changeFilter(f)} style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid var(--border)",
                  background: filter === f ? "var(--accent)" : "transparent",
                  color: filter === f ? "#fff" : "var(--text-muted)", cursor: "pointer",
                }}>
                  {FILTER_LABELS[f]} {f === "pending" && pendingCount > 0 ? `(${pendingCount})` : ""}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                applySearch();
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
            >
              <input
                className="filter-input search-input"
                type="search"
                placeholder="Search Order ID..."
                aria-label="Search by order ID"
                value={orderIdSearch}
                onChange={(event) => setOrderIdSearch(event.target.value)}
                style={{ minWidth: 190 }}
              />
              <input
                className="filter-input search-input"
                type="search"
                placeholder="Search SKU..."
                aria-label="Search by SKU"
                value={skuSearch}
                onChange={(event) => setSkuSearch(event.target.value)}
                style={{ minWidth: 150 }}
              />
              <button
                className="btn btn-secondary"
                type="submit"
                style={{ fontSize: 13, padding: "8px 12px" }}
              >
                Search
              </button>
              {(appliedOrderIdSearch || appliedSkuSearch) && (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={clearSearch}
                  style={{ fontSize: 13, padding: "8px 10px" }}
                >
                  Clear
                </button>
              )}
            </form>
            <select
              className="filter-select"
              value={monthWindow}
              onChange={(e) => changeMonthWindow(Number(e.target.value) as ShipmentMonthWindow)}
              style={{ minWidth: 150 }}
            >
              {SHIPMENT_MONTH_OPTIONS.map((months) => (
                <option key={months} value={months}>
                  {getShipmentWindowLabel(months)}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              style={{ background: "#166534", fontSize: 13 }}
              onClick={handleDownloadExcel}
              disabled={downloadingReport || total === 0}
            >
              {downloadingReport ? "Preparing Excel..." : "Download Excel"}
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {total} placed orders{activeSearchSummary} &middot; {getShipmentWindowLabel(monthWindow)} &middot; Page {page + 1} of {Math.max(totalPages, 1)}
            </span>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center" }}>
            <div className="spinner" style={{ width: 24, height: 24, margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)" }}>Loading estimates...</p>
          </div>
        ) : estimates.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center" }}>
            <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>No placed orders found for this filter.</p>
            {filter === "all" && (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                Click <strong>&quot;Estimate New Orders&quot;</strong> to compute shipping costs.
              </p>
            )}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--bg-tertiary)" }}>
                  <SortTh field="purchase_date" label="Date" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#888" />
                  <th style={th}>Order ID</th>
                  <th style={th}>SKU</th>
                  <th style={th}>Destination</th>
                  <th style={{ ...th, cursor: "pointer", textAlign: "center" }} onClick={() => handleSort("chargeable_weight_kg")}>
                    Weights {sortField === "chargeable_weight_kg" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}
                  </th>
                  <th style={{ ...th, textAlign: "center", fontSize: 10, color: "var(--text-muted)" }}>Quotes</th>
                  <SortTh field="amazon_shipping_cost" label="Amazon" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#ff9900" />
                  <SortTh field="delhivery_cost" label="Delhivery" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#e23744" />
                  <SortTh field="bluedart_cost" label="BlueDart" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#0066cc" />
                  <SortTh field="dtdc_cost" label="DTDC" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#d42027" />
                  <SortTh field="xpressbees_cost" label="Xpressbees" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#f5a623" />
                  <SortTh field="ekart_cost" label="Ekart" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#2874f0" />
                  <SortTh field="cheapest_cost" label="Best" sortField={sortField} sortDir={sortDir} onClick={handleSort} color="#22c55e" />
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => {
                  const rowKey = `${e.amazon_order_id}-${e.sku}`;
                  const channel = (e.fulfillment_channel || "").toLowerCase();
                  const isAmazonFulfilled = channel.includes("amazon") || channel.includes("afn");
                  const costs = {
                    delhivery: e.delhivery_cost,
                    bluedart: e.bluedart_cost,
                    dtdc: e.dtdc_cost,
                    xpressbees: e.xpressbees_cost,
                    ekart: e.ekart_cost,
                  };
                  const validCosts = Object.values(costs).filter(Boolean) as number[];
                  const minCost = validCosts.length > 0 ? Math.min(...validCosts) : null;
                  const hasEstimates = Boolean(
                    e.delhivery_cost || e.bluedart_cost || e.dtdc_cost || e.xpressbees_cost || e.ekart_cost
                    || (e.cheapest_provider && e.cheapest_provider.trim() !== "")
                  );
                  const isExpanded = expandedRow === rowKey;
                  const isRecalcing = recalculating === rowKey;

                  return (
                    <tr key={rowKey} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...td, fontSize: 11, color: "var(--text-muted)" }}>
                        {fmtDate(e.purchase_date)}
                      </td>

                      <td style={td}>
                        <span style={{ fontFamily: "monospace", fontSize: 11 }}>
                          {e.amazon_order_id?.slice(-8)}
                        </span>
                      </td>

                      <td style={td}>
                        <span style={{ maxWidth: 100, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {e.sku}
                        </span>
                      </td>

                      <td style={td}>
                        <div style={{ fontSize: 12 }}>{e.destination_city || "\u2014"}</div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                          {e.destination_state ? `${e.destination_state} \u00B7 ` : ""}{e.destination_pincode}
                        </div>
                      </td>

                      <td
                        style={{ ...td, textAlign: "center", cursor: "pointer", position: "relative" }}
                        onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                      >
                        <div style={{ fontWeight: 600, fontSize: 12 }}>
                          {e.chargeable_weight_kg ? `${Number(e.chargeable_weight_kg).toFixed(2)}` : "0.50"}
                          <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 2 }}>kg</span>
                        </div>
                        <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
                          {e.actual_weight_kg != null || e.volumetric_weight_kg != null ? "\u25BE details" : "default"}
                        </div>
                        {isExpanded && (
                          <div style={{
                            position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
                            background: "var(--bg-secondary)", border: "1px solid var(--border)",
                            borderRadius: 8, padding: "10px 14px", zIndex: 20, minWidth: 200,
                            boxShadow: "0 4px 16px rgba(0,0,0,0.3)", textAlign: "left",
                          }}>
                            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: "var(--text-primary)" }}>
                              Weight Breakdown
                            </div>
                            <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-muted)" }}>Actual:</span>
                                <span style={{ fontWeight: 600 }}>{fmtWeight(e.actual_weight_kg)}</span>
                              </div>
                              {(e.length_cm != null && e.width_cm != null && e.height_cm != null) && (
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                  <span style={{ color: "var(--text-muted)" }}>Dims:</span>
                                  <span style={{ fontWeight: 600 }}>
                                    {Number(e.length_cm).toFixed(1)}\u00D7{Number(e.width_cm).toFixed(1)}\u00D7{Number(e.height_cm).toFixed(1)} cm
                                  </span>
                                </div>
                              )}
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-muted)" }}>Volumetric:</span>
                                <span style={{ fontWeight: 600 }}>{fmtWeight(e.volumetric_weight_kg)}</span>
                              </div>
                              <div style={{
                                borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4,
                                display: "flex", justifyContent: "space-between",
                              }}>
                                <span style={{ color: "#22c55e", fontWeight: 700 }}>Chargeable:</span>
                                <span style={{ fontWeight: 800, color: "#22c55e" }}>
                                  {fmtWeight(e.chargeable_weight_kg)}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}
                      </td>

                      <td style={{ ...td, textAlign: "center" }}>
                        {(() => {
                          const badge = getRateSourceBadge(e.rate_source);
                          if (!badge) {
                            return (
                              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{"\u2014"}</span>
                            );
                          }
                          return (
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                              background: badge.background,
                              color: badge.color,
                              textTransform: "uppercase", letterSpacing: 0.5,
                            }}>
                              {badge.label}
                            </span>
                          );
                        })()}
                      </td>

                      {isAmazonFulfilled ? (
                        e.amazon_shipping_cost != null && e.amazon_shipping_cost > 0 ? (
                          <CostCell
                            cost={e.amazon_shipping_cost}
                            isMin={false}
                            etd=""
                          />
                        ) : (
                          <td style={{ ...td, textAlign: "center", color: "var(--text-muted)", fontSize: 11 }} title="Awaiting Amazon Finance settlement">
                            {"\u2014"}
                          </td>
                        )
                      ) : (
                        <td style={{ ...td, textAlign: "center", color: "var(--text-muted)", fontWeight: 800 }}>---</td>
                      )}

                      {!hasEstimates ? (
                        <td colSpan={6} style={{ textAlign: "center", padding: "8px" }}>
                          <button
                            className="btn btn-primary btn-sm"
                            style={{ padding: "4px 12px", fontSize: 11 }}
                            disabled={isRecalcing}
                            onClick={() => recalculateOrder(e.amazon_order_id, e.sku)}
                          >
                            {isRecalcing ? "Calculating..." : "Calculate Cost"}
                          </button>
                        </td>
                      ) : (
                        <>
                          <CostCell cost={e.delhivery_cost} isMin={e.delhivery_cost === minCost} etd={e.delhivery_etd} />
                          <CostCell cost={e.bluedart_cost} isMin={e.bluedart_cost === minCost} etd={e.bluedart_etd} />
                          <CostCell cost={e.dtdc_cost} isMin={e.dtdc_cost === minCost} etd={e.dtdc_etd} />
                          <CostCell cost={e.xpressbees_cost} isMin={e.xpressbees_cost === minCost} etd={e.xpressbees_etd} />
                          <CostCell cost={e.ekart_cost} isMin={e.ekart_cost === minCost} etd={e.ekart_etd} />
                          <td style={{ ...td, textAlign: "center" }}>
                            {e.cheapest_provider ? (
                              <div style={{
                                background: "rgba(34, 197, 94, 0.15)", color: "#22c55e",
                                borderRadius: 6, padding: "4px 8px", fontSize: 12, fontWeight: 700,
                              }}>
                                {e.cheapest_provider}
                                <div style={{ fontSize: 11, fontWeight: 600 }}>{fmt(e.cheapest_cost)}</div>
                              </div>
                            ) : (
                              <span style={{ color: "var(--text-muted)" }}>{"\u2014"}</span>
                            )}
                          </td>
                        </>
                      )}

                      {/* Actions: Recalculate */}
                      <td style={{ ...td, textAlign: "center" }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "3px 8px", fontSize: 10 }}
                          disabled={isRecalcing}
                          onClick={() => recalculateOrder(e.amazon_order_id, e.sku)}
                          title="Recalculate shipment cost"
                        >
                          {isRecalcing ? "..." : "Recalc"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{
            padding: "12px 20px", borderTop: "1px solid var(--border)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Showing {page * PAGE_SIZE + 1}{"\u2013"}{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <button className="btn btn-ghost btn-sm" disabled={page === 0}
                onClick={() => { setPage(p => p - 1); fetchData(filter, page - 1, monthWindow, appliedOrderIdSearch, appliedSkuSearch); }}>
                Prev
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const pageNum = totalPages <= 7 ? i : page <= 3 ? i : page >= totalPages - 4 ? totalPages - 7 + i : page - 3 + i;
                if (pageNum < 0 || pageNum >= totalPages) return null;
                return (
                  <button key={pageNum} className="btn btn-ghost btn-sm"
                    style={{ fontWeight: page === pageNum ? 700 : 400, color: page === pageNum ? "var(--accent)" : undefined }}
                    onClick={() => { setPage(pageNum); fetchData(filter, pageNum, monthWindow, appliedOrderIdSearch, appliedSkuSearch); }}>
                    {pageNum + 1}
                  </button>
                );
              })}
              <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1}
                onClick={() => { setPage(p => p + 1); fetchData(filter, page + 1, monthWindow, appliedOrderIdSearch, appliedSkuSearch); }}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Info banner */}
      <div style={{
        marginTop: 16, padding: "12px 16px", borderRadius: 8,
        background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)",
        fontSize: 12, color: "var(--text-muted)",
      }}>
        Canceled orders are excluded from shipment estimates, table results, and Excel downloads.
        Amazon-fulfilled orders show only the actual SP API shipping cost (no carrier comparison).
        Self-fulfilled orders show <strong style={{ color: "#22c55e" }}>LIVE</strong> Shiprocket quotes only.
        Rows marked <strong style={{ color: "#cbd5e1" }}>PENDING</strong> are still waiting for Amazon Finance settlement.
        Rows marked <strong style={{ color: "#f87171" }}>NO QUOTE</strong> failed Shiprocket lookup — try Recalc.
        Shipment estimation runs automatically when the main sync runs.
      </div>

      {toast && <div className="toast toast-success">{toast}</div>}
    </div>
  );
}

/* --- Sub-components --- */

const th: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, whiteSpace: "nowrap", color: "var(--text-muted)",
};

const td: React.CSSProperties = {
  padding: "10px 12px", whiteSpace: "nowrap",
};

function KPICard({ title, value, color, subtitle }: {
  title: string; value: string; color: string; subtitle?: string;
}) {
  return (
    <div className="card" style={{ padding: "16px 20px", borderLeft: `3px solid ${color}` }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.5, marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
        {subtitle && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

function SortTh({ field, label, sortField, sortDir, onClick, color }: {
  field: string; label: string; sortField: string; sortDir: "asc" | "desc";
  onClick: (f: string) => void; color: string;
}) {
  const active = sortField === field;
  return (
    <th
      style={{ ...th, cursor: "pointer", color: active ? color : "var(--text-muted)", textAlign: "center" }}
      onClick={() => onClick(field)}
    >
      {label} {active ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}
    </th>
  );
}

function CostCell({ cost, isMin, etd }: { cost: number | null; isMin: boolean; etd: string }) {
  if (cost == null) return <td style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>{"\u2014"}</td>;
  return (
    <td style={{
      ...td, textAlign: "center",
      fontWeight: isMin ? 700 : 400,
      color: isMin ? "#22c55e" : undefined,
      background: isMin ? "rgba(34, 197, 94, 0.08)" : undefined,
    }}>
      <div>{fmt(cost)}</div>
      {etd && <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 400 }}>{etd}</div>}
    </td>
  );
}
