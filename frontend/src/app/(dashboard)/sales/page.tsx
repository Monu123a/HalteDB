"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
  AreaChart, Area, Legend
} from "recharts";
import dynamic from "next/dynamic";

const IndiaMapChart = dynamic(() => import("./IndiaMapChart"), { ssr: false });

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ──────────────────────────────────────────────────────────
   Constants
   ────────────────────────────────────────────────────────── */
const COLORS = ["#6366f1","#8b5cf6","#06b6d4","#10b981","#f59e0b","#ef4444","#ec4899","#14b8a6","#a855f7","#f97316","#22d3ee","#84cc16"];
const TIER_COLORS: Record<string, string> = { "Tier 1": "#6366f1", "Tier 2": "#f59e0b", "Tier 3": "#10b981" };

const STATE_COORDS: Record<string, [number, number]> = {
  "Maharashtra": [75.7,19.7], "Delhi": [77.1,28.7], "Karnataka": [75.7,15.3], "Tamil Nadu": [78.6,11.1],
  "Telangana": [79.0,18.1], "Gujarat": [72.0,22.3], "Uttar Pradesh": [80.9,26.8], "West Bengal": [87.9,22.9],
  "Rajasthan": [74.2,27.0], "Madhya Pradesh": [78.6,23.5], "Kerala": [76.3,10.8], "Punjab": [75.3,31.1],
  "Haryana": [76.1,29.0], "Bihar": [85.3,25.1], "Andhra Pradesh": [79.7,15.9], "Odisha": [85.1,20.9],
  "Jharkhand": [85.3,23.6], "Assam": [92.9,26.2], "Chandigarh": [76.8,30.7], "Chhattisgarh": [81.9,21.3],
  "Uttarakhand": [79.0,30.1], "Himachal Pradesh": [77.2,31.1], "Goa": [74.1,15.4], "Jammu And Kashmir": [76.5,33.7],
  "Tripura": [91.9,23.9], "Meghalaya": [91.4,25.5], "Manipur": [93.9,24.8], "Nagaland": [94.6,26.2],
  "Arunachal Pradesh": [94.7,28.2], "Mizoram": [92.9,23.2], "Sikkim": [88.5,27.5], "Puducherry": [79.8,11.9],
};

const fmtCur = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtNum = (v: number) => v.toLocaleString("en-IN");
const fmtK = (v: number) => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : v >= 1000 ? `₹${(v/1000).toFixed(0)}K` : `₹${v.toFixed(0)}`;

/* ──────────────────────────────────────────────────────────
   Interfaces
   ────────────────────────────────────────────────────────── */
interface Filters {
  sku: string; brand: string; year: string; month: string; startDate: string; endDate: string;
  city: string; state: string; tier: string;
}

/* ──────────────────────────────────────────────────────────
   Component
   ────────────────────────────────────────────────────────── */
export default function SalesPage() {
  const [filters, setFilters] = useState<Filters>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return {
        sku: p.get("sku") || "",
        brand: p.get("brand") || "",
        year: p.get("year") || "",
        month: p.get("month") || "",
        startDate: p.get("startDate") || "",
        endDate: p.get("endDate") || "",
        city: p.get("city") || "",
        state: p.get("state") || "",
        tier: p.get("tier") || "",
      };
    }
    return {
      sku: "", brand: "", year: "", month: "", startDate: "", endDate: "", city: "", state: "", tier: "",
    };
  });
  const [summary, setSummary] = useState<any>(null);
  const [geo, setGeo] = useState<any>(null);
  const [orders, setOrders] = useState<any>(null);
  const [predictions, setPredictions] = useState<any>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview"|"geography"|"orders"|"predictions">("overview");
  const [cityDropdownOpen, setCityDropdownOpen] = useState(false);
  const [citySearch, setCitySearch] = useState("");
  const cityDropdownRef = useRef<HTMLDivElement>(null);
  const [skuDropdownOpen, setSkuDropdownOpen] = useState(false);
  const [skuSearch, setSkuSearch] = useState("");
  const skuDropdownRef = useRef<HTMLDivElement>(null);

  // Close city/sku dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cityDropdownRef.current && !cityDropdownRef.current.contains(e.target as Node)) {
        setCityDropdownOpen(false);
      }
      if (skuDropdownRef.current && !skuDropdownRef.current.contains(e.target as Node)) {
        setSkuDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ── Fetchers ── */
  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    if (filters.sku) p.set("sku", filters.sku);
    if (filters.brand) p.set("brand", filters.brand);
    if (filters.year) p.set("year", filters.year);
    if (filters.month) p.set("month", filters.month);
    if (filters.startDate) p.set("startDate", filters.startDate);
    if (filters.endDate) p.set("endDate", filters.endDate);
    if (filters.city) p.set("city", filters.city);
    if (filters.state) p.set("state", filters.state);
    if (filters.tier) p.set("tier", filters.tier);
    return p;
  }, [filters]);

  // Synchronize filters to browser URL query string so refreshes/navigation never lose state
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = buildParams();
    const query = p.toString();
    const newUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [filters, buildParams]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const p = buildParams();
    try {
      const [sumRes, geoRes, ordRes, predRes] = await Promise.all([
        fetch(`/api/sales/summary?${p}`),
        fetch(`/api/sales/geography?${p}`),
        fetch(`/api/sales?${p.toString()}&limit=50&offset=${page*50}`),
        fetch("/api/sales/predictions"),
      ]);
      const [sumData, geoData, ordData, predData] = await Promise.all([
        sumRes.json(), geoRes.json(), ordRes.json(), predRes.json(),
      ]);
      setSummary(sumData);
      setGeo(geoData);
      setOrders(ordData);
      setPredictions(predData);
    } catch (err) { console.error("Fetch error", err); }
    finally { setLoading(false); }
  }, [buildParams, page]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* ── Derived data ── */
  const totalRevenue = useMemo(() => summary?.monthly?.reduce((a: number, m: any) => a + Number(m.total_revenue || 0), 0) || 0, [summary]);
  const totalOrders = useMemo(() => summary?.monthly?.reduce((a: number, m: any) => a + Number(m.total_orders || 0), 0) || 0, [summary]);
  const totalProfit = useMemo(() => summary?.monthly?.reduce((a: number, m: any) => a + Number(m.total_profit || 0), 0) || 0, [summary]);
  const totalUnits = useMemo(() => summary?.monthly?.reduce((a: number, m: any) => a + Number(m.total_units || 0), 0) || 0, [summary]);
  const asp = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const monthlyChart = useMemo(() => summary?.monthly?.map((m: any) => ({
    month: m.month, revenue: Number(m.total_revenue), orders: Number(m.total_orders), profit: Number(m.total_profit),
  })) || [], [summary]);

  const topSkus = useMemo(() => (summary?.bySku || [])
    .map((s: any) => ({ name: s.sku, revenue: Number(s.total_revenue), orders: Number(s.total_orders), units: Number(s.total_units) }))
    .sort((a: any, b: any) => b.revenue - a.revenue).slice(0, 15), [summary]);

  const topSkusByUnits = useMemo(() => (summary?.bySku || [])
    .map((s: any) => ({ name: s.sku, units: Number(s.total_units), orders: Number(s.total_orders), revenue: Number(s.total_revenue) }))
    .sort((a: any, b: any) => b.units - a.units).slice(0, 15), [summary]);

  const stateData = useMemo(() => (geo?.byState || [])
    .map((s: any) => ({ name: s.state, revenue: Number(s.total_revenue), orders: Number(s.total_orders), profit: Number(s.total_profit) }))
    .sort((a: any, b: any) => b.revenue - a.revenue), [geo]);

  const cityData = useMemo(() => (geo?.byCity || [])
    .map((c: any) => ({ name: c.city, state: c.state, revenue: Number(c.total_revenue), orders: Number(c.total_orders), tier: c.tier }))
    .sort((a: any, b: any) => b.revenue - a.revenue), [geo]);

  const tierData = useMemo(() => (geo?.byTier || [])
    .filter((t: any) => t.total_revenue > 0)
    .map((t: any) => ({ name: t.tier, revenue: t.total_revenue, orders: t.total_orders })), [geo]);

  const mapMarkers = useMemo(() => stateData
    .filter((s: any) => STATE_COORDS[s.name])
    .map((s: any) => ({ ...s, coords: STATE_COORDS[s.name] })), [stateData]);

  const maxMapRevenue = useMemo(() => Math.max(...mapMarkers.map((m: any) => m.revenue), 1), [mapMarkers]);

  // Choropleth: map state name → revenue for boundary fill
  const stateRevenueMap = useMemo(() => {
    const m: Record<string, number> = {};
    stateData.forEach((s: any) => { m[s.name?.toLowerCase()] = s.revenue; });
    return m;
  }, [stateData]);

  const getStateFill = useCallback((geoName: string) => {
    const rev = stateRevenueMap[geoName?.toLowerCase()] || stateRevenueMap[geoName?.toLowerCase()?.replace(/ and /g, " & ")] || 0;
    if (rev === 0) return "#0f172a";
    const intensity = Math.min(1, rev / maxMapRevenue);
    // Blend from dark (#1e293b) to accent (#6366f1)
    const alpha = 0.15 + intensity * 0.75;
    return `rgba(99, 102, 241, ${alpha.toFixed(2)})`;
  }, [stateRevenueMap, maxMapRevenue]);

  /* ── Filter helpers ── */
  const setFilter = (key: keyof Filters, val: string) => {
    setFilters((f: Filters) => ({ ...f, [key]: f[key] === val ? "" : val }));
    setPage(0);
  };
  const resetFilters = () => {
    setFilters({ sku: "", brand: "", year: "", month: "", startDate: "", endDate: "", city: "", state: "", tier: "" });
    setPage(0);
  };

  const handleDateChange = (key: "startDate" | "endDate", rawVal: string) => {
    let val = rawVal.trim();
    if (val.startsWith("0025-")) val = "2025-" + val.slice(5);
    else if (val.startsWith("0026-")) val = "2026-" + val.slice(5);
    else if (val.startsWith("0024-")) val = "2024-" + val.slice(5);
    else if (val.startsWith("0023-")) val = "2023-" + val.slice(5);
    else if (val.startsWith("0022-")) val = "2022-" + val.slice(5);
    else if (val.startsWith("0021-")) val = "2021-" + val.slice(5);

    const twoDigit = val.match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (twoDigit) {
      val = `20${twoDigit[1]}-${twoDigit[2]}-${twoDigit[3]}`;
    }

    setFilters((f: Filters) => ({ ...f, year: "", month: "", [key]: val }));
    setPage(0);
  };

  const applyPreset = (preset: { year: string; month: string; startDate: string; endDate: string }) => {
    setFilters((f: Filters) => ({
      ...f,
      year: preset.year,
      month: preset.month,
      startDate: preset.startDate,
      endDate: preset.endDate,
    }));
    setPage(0);
  };

  const isAllTime = !filters.year && !filters.month && !filters.startDate && !filters.endDate;

  const isPresetActive = (label: string) => {
    if (label === "All Time") return isAllTime;
    if (label === "2026 (YTD)") return filters.year === "2026" && !filters.startDate && !filters.endDate;
    if (label === "2025") return filters.year === "2025" && !filters.startDate && !filters.endDate;
    if (label === "2024") return filters.year === "2024" && !filters.startDate && !filters.endDate;
    if (label === "Jan – Oct 2025") return filters.startDate === "2025-01-01" && filters.endDate === "2025-10-31";
    return false;
  };

  const activePeriodLabel = useMemo(() => {
    if (filters.startDate && filters.endDate) {
      return `${filters.startDate} → ${filters.endDate}`;
    }
    if (filters.startDate) return `From ${filters.startDate}`;
    if (filters.endDate) return `Up to ${filters.endDate}`;
    if (filters.month) return `Month ${filters.month}`;
    if (filters.year) return `Year ${filters.year}`;
    return "All Time (2021 – 2026)";
  }, [filters.startDate, filters.endDate, filters.month, filters.year]);

  const selectedCities = useMemo(() => filters.city ? filters.city.split(",").filter(Boolean) : [], [filters.city]);
  const selectedSkus = useMemo(() => filters.sku ? filters.sku.split(",").filter(Boolean) : [], [filters.sku]);

  const toggleSku = (sku: string) => {
    setFilters((f: Filters) => {
      const current = f.sku ? f.sku.split(",").filter(Boolean) : [];
      const idx = current.findIndex(s => s.toLowerCase() === sku.toLowerCase());
      const next = idx >= 0 ? current.filter((_, i) => i !== idx) : [...current, sku];
      return { ...f, sku: next.join(",") };
    });
    setPage(0);
  };

  const removeSku = (sku: string) => {
    setFilters((f: Filters) => {
      const current = f.sku ? f.sku.split(",").filter(Boolean) : [];
      return { ...f, sku: current.filter(s => s.toLowerCase() !== sku.toLowerCase()).join(",") };
    });
    setPage(0);
  };

  const toggleCity = (city: string) => {
    setFilters((f: Filters) => {
      const current = f.city ? f.city.split(",").filter(Boolean) : [];
      const idx = current.findIndex(c => c.toLowerCase() === city.toLowerCase());
      const next = idx >= 0 ? current.filter((_, i) => i !== idx) : [...current, city];
      return { ...f, city: next.join(",") };
    });
    setPage(0);
  };

  const removeCity = (city: string) => {
    setFilters((f: Filters) => {
      const current = f.city ? f.city.split(",").filter(Boolean) : [];
      return { ...f, city: current.filter(c => c.toLowerCase() !== city.toLowerCase()).join(",") };
    });
    setPage(0);
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const tabs = [
    { key: "overview", label: "📊 Overview" },
    { key: "geography", label: "📍 Geography" },
    { key: "orders", label: "📦 Orders" },
    { key: "predictions", label: "🔮 Predictions" },
  ];

  if (loading && !summary) {
    return (<div className="loading-spinner"><div className="spinner" />Loading sales analytics...</div>);
  }

  return (
    <div>
      {/* ═══════════════════ HEADER ═══════════════════ */}
      <div className="page-header">
        <h1 className="page-title">Sales Dashboard</h1>
        <p className="page-subtitle">Power BI-style interactive analytics · Click charts to filter</p>
      </div>

      {/* ═══════════════════ FILTER BAR ═══════════════════ */}
      <div className="card" style={{ marginBottom: 16, padding: "12px 16px", position: "relative", zIndex: 50 }}>
        {/* Quick Date Range Presets */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, marginRight: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Quick Period:</span>
          {[
            { label: "All Time", getFilters: () => ({ year: "", month: "", startDate: "", endDate: "" }) },
            { label: "2026 (YTD)", getFilters: () => ({ year: "2026", month: "", startDate: "", endDate: "" }) },
            { label: "2025", getFilters: () => ({ year: "2025", month: "", startDate: "", endDate: "" }) },
            { label: "Jan – Oct 2025", getFilters: () => ({ year: "", month: "", startDate: "2025-01-01", endDate: "2025-10-31" }) },
            { label: "2024", getFilters: () => ({ year: "2024", month: "", startDate: "", endDate: "" }) },
            { label: "Last 12 Months", getFilters: () => {
              const now = new Date();
              const start = new Date();
              start.setFullYear(now.getFullYear() - 1);
              return { year: "", month: "", startDate: start.toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10) };
            }},
            { label: "Last 30 Days", getFilters: () => {
              const now = new Date();
              const start = new Date();
              start.setDate(now.getDate() - 30);
              return { year: "", month: "", startDate: start.toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10) };
            }},
          ].map(preset => {
            const isActive = isPresetActive(preset.label);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset.getFilters())}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                  border: isActive ? "1px solid #6366f1" : "1px solid var(--border)",
                  background: isActive ? "rgba(99,102,241,0.25)" : "transparent",
                  color: isActive ? "#a5b4fc" : "var(--text-muted)",
                  cursor: "pointer", transition: "all 0.15s ease",
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative" }} ref={skuDropdownRef}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, width: 180 }}>
              <input
                className="filter-input"
                placeholder={selectedSkus.length === 0 ? "🔍 Search SKUs..." : `🔍 ${selectedSkus.length} selected`}
                value={skuSearch}
                onChange={e => { setSkuSearch(e.target.value); setSkuDropdownOpen(true); }}
                onFocus={() => setSkuDropdownOpen(true)}
                style={{ width: "100%", fontSize: 12 }}
              />
              {selectedSkus.length > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); setFilters(f => ({ ...f, sku: "" })); setPage(0); }}
                  style={{ fontSize: 10, padding: "2px 6px" }}
                  title="Clear all"
                >✕</button>
              )}
            </div>
            {skuDropdownOpen && (
              <div style={{
                position: "absolute", top: "100%", left: 0, zIndex: 9999, width: 240,
                background: "var(--card-bg, #1e293b)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, marginTop: 4, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxHeight: 260, display: "flex", flexDirection: "column",
              }}>
                <div style={{ overflowY: "auto", maxHeight: 260, padding: "4px 0" }}>
                  {(() => {
                    const allSkus: string[] = summary?.filters?.skus || [];
                    const search = skuSearch.toLowerCase();
                    const filtered = search ? allSkus.filter(s => s.toLowerCase().includes(search)) : allSkus;
                    const selected = filtered.filter(s => selectedSkus.some(x => x.toLowerCase() === s.toLowerCase()));
                    const unselected = filtered.filter(s => !selectedSkus.some(x => x.toLowerCase() === s.toLowerCase()));
                    const sorted = [...selected, ...unselected];
                    if (sorted.length === 0) return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-muted)" }}>No SKUs found</div>;
                    return sorted.map(s => {
                      const isSelected = selectedSkus.some(x => x.toLowerCase() === s.toLowerCase());
                      return (
                        <div
                          key={s}
                          onClick={() => toggleSku(s)}
                          style={{
                            padding: "5px 12px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                            background: isSelected ? "rgba(99,102,241,0.15)" : "transparent",
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.05)"; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? "rgba(99,102,241,0.15)" : "transparent"; }}
                        >
                          <span style={{
                            width: 14, height: 14, borderRadius: 3, border: "1.5px solid",
                            borderColor: isSelected ? "#6366f1" : "rgba(255,255,255,0.25)",
                            background: isSelected ? "#6366f1" : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0,
                          }}>
                            {isSelected && "✓"}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
          </div>
          <select className="filter-select" value={filters.brand} onChange={e => { setFilters(f => ({ ...f, brand: e.target.value })); setPage(0); }}>
            <option value="">All Brands</option>
            {(summary?.filters?.brands || []).map((b: string) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select className="filter-select" value={filters.year} onChange={e => { setFilters(f => ({ ...f, year: e.target.value, startDate: "", endDate: "", month: "" })); setPage(0); }}>
            <option value="">All Years</option>
            {(summary?.filters?.years || []).map((y: number) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
          <select className="filter-select" value={filters.tier} onChange={e => { setFilters(f => ({ ...f, tier: e.target.value })); setPage(0); }}>
            <option value="">All Tiers</option>
            <option value="Tier 1">Tier 1</option>
            <option value="Tier 2">Tier 2</option>
            <option value="Tier 3">Tier 3</option>
          </select>
          <select className="filter-select" value={filters.state} onChange={e => { setFilters(f => ({ ...f, state: e.target.value })); setPage(0); }}>
            <option value="">All States</option>
            {(geo?.filters?.states || []).map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div style={{ position: "relative" }} ref={cityDropdownRef}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, width: 160 }}>
              <input
                className="filter-input"
                placeholder={selectedCities.length === 0 ? "🏙️ Cities..." : `🏙️ ${selectedCities.length} selected`}
                value={citySearch}
                onChange={e => { setCitySearch(e.target.value); setCityDropdownOpen(true); }}
                onFocus={() => setCityDropdownOpen(true)}
                style={{ width: "100%", fontSize: 12 }}
              />
              {selectedCities.length > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); setFilters(f => ({ ...f, city: "" })); setPage(0); }}
                  style={{ fontSize: 10, padding: "2px 6px" }}
                  title="Clear all"
                >✕</button>
              )}
            </div>
            {cityDropdownOpen && (
              <div style={{
                position: "absolute", top: "100%", right: 0, zIndex: 9999, width: 220,
                background: "var(--card-bg, #1e293b)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, marginTop: 4, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxHeight: 240, display: "flex", flexDirection: "column",
              }}>
                <div style={{ overflowY: "auto", maxHeight: 240, padding: "4px 0" }}>
                  {(() => {
                    const allCities: string[] = geo?.filters?.cities || [];
                    const search = citySearch.toLowerCase();
                    const filtered = search ? allCities.filter(c => c.toLowerCase().includes(search)) : allCities;
                    const selected = filtered.filter(c => selectedCities.some(s => s.toLowerCase() === c.toLowerCase()));
                    const unselected = filtered.filter(c => !selectedCities.some(s => s.toLowerCase() === c.toLowerCase()));
                    const sorted = [...selected, ...unselected];
                    if (sorted.length === 0) return <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-muted)" }}>No cities found</div>;
                    return sorted.map(c => {
                      const isSelected = selectedCities.some(s => s.toLowerCase() === c.toLowerCase());
                      return (
                        <div
                          key={c}
                          onClick={() => toggleCity(c)}
                          style={{
                            padding: "5px 12px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                            background: isSelected ? "rgba(99,102,241,0.15)" : "transparent",
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.05)"; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? "rgba(99,102,241,0.15)" : "transparent"; }}
                        >
                          <span style={{
                            width: 14, height: 14, borderRadius: 3, border: "1.5px solid",
                            borderColor: isSelected ? "#6366f1" : "rgba(255,255,255,0.25)",
                            background: isSelected ? "#6366f1" : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0,
                          }}>
                            {isSelected && "✓"}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
          </div>
          <input
            className="filter-input"
            type="month"
            value={filters.month}
            onChange={e => { setFilters(f => ({ ...f, month: e.target.value, year: "", startDate: "", endDate: "" })); setPage(0); }}
            style={{ width: 140 }}
            title="Filter by specific month"
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>From</span>
            <input
              className="filter-input"
              type="date"
              value={filters.startDate}
              onChange={e => handleDateChange("startDate", e.target.value)}
              style={{ width: 130, fontSize: 11 }}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>To</span>
            <input
              className="filter-input"
              type="date"
              value={filters.endDate}
              onChange={e => handleDateChange("endDate", e.target.value)}
              style={{ width: 130, fontSize: 11 }}
            />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={resetFilters} style={{ fontSize: 12 }}>
            ✕ Reset {activeFilterCount > 0 && `(${activeFilterCount})`}
          </button>
        </div>
        {activeFilterCount > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {selectedSkus.map(s => <span key={s} className="badge badge-accent" onClick={() => removeSku(s)} style={{ cursor: "pointer" }}>SKU: {s} ✕</span>)}
            {filters.brand && <span className="badge badge-accent" onClick={() => setFilter("brand", filters.brand)} style={{ cursor: "pointer" }}>Brand: {filters.brand} ✕</span>}
            {filters.year && <span className="badge badge-accent" onClick={() => setFilter("year", filters.year)} style={{ cursor: "pointer" }}>Year: {filters.year} ✕</span>}
            {filters.tier && <span className="badge badge-accent" onClick={() => setFilter("tier", filters.tier)} style={{ cursor: "pointer" }}>Tier: {filters.tier} ✕</span>}
            {filters.state && <span className="badge badge-accent" onClick={() => setFilter("state", filters.state)} style={{ cursor: "pointer" }}>State: {filters.state} ✕</span>}
            {selectedCities.map(c => <span key={c} className="badge badge-accent" onClick={() => removeCity(c)} style={{ cursor: "pointer" }}>City: {c} ✕</span>)}
            {filters.month && <span className="badge badge-accent" onClick={() => setFilter("month", filters.month)} style={{ cursor: "pointer" }}>Month: {filters.month} ✕</span>}
            {filters.startDate && <span className="badge badge-accent" onClick={() => { setFilters(f => ({ ...f, startDate: "" })); setPage(0); }} style={{ cursor: "pointer" }}>From: {filters.startDate} ✕</span>}
            {filters.endDate && <span className="badge badge-accent" onClick={() => { setFilters(f => ({ ...f, endDate: "" })); setPage(0); }} style={{ cursor: "pointer" }}>To: {filters.endDate} ✕</span>}
          </div>
        )}
      </div>

      {/* ═══════════════════ PERIOD BANNER ═══════════════════ */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "var(--bg-secondary)", border: "1px solid var(--border)",
        borderRadius: 8, padding: "8px 16px", marginBottom: 16, flexWrap: "wrap", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
            📅 Active Period: <span style={{ color: "#6366f1" }}>{activePeriodLabel}</span>
          </span>
          {isAllTime ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 4 }}>
              Lifetime cumulative sales (2021 – 2026)
            </span>
          ) : (
            <span style={{ fontSize: 11, color: "#10b981", background: "rgba(16,185,129,0.12)", padding: "2px 8px", borderRadius: 4 }}>
              Filtered view · {totalOrders.toLocaleString()} orders
            </span>
          )}
        </div>
        {isAllTime ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            2025: <strong style={{ color: "var(--text-primary)" }}>₹3.76Cr</strong> · 2026: <strong style={{ color: "var(--text-primary)" }}>₹3.17Cr</strong> · 2024: <strong style={{ color: "var(--text-primary)" }}>₹2.46Cr</strong>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => applyPreset({ year: "", month: "", startDate: "", endDate: "" })}
            style={{ fontSize: 11, padding: "2px 8px" }}
          >
            Switch to All Time
          </button>
        )}
      </div>

      {/* ═══════════════════ TABS ═══════════════════ */}
      <div className="tabs-bar" style={{ marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.key} className={`tab-btn ${activeTab === t.key ? "active" : ""}`}
            onClick={() => setActiveTab(t.key as any)}>{t.label}</button>
        ))}
      </div>

      {/* ═══════════════════ KPI CARDS ═══════════════════ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        {[
          {
            label: "Total Sales",
            value: fmtCur(totalRevenue),
            color: "#6366f1",
            icon: "💰",
            subtitle: isAllTime ? "All-time (2025: ₹3.76Cr · 2026: ₹3.17Cr)" : `Period total (${totalOrders.toLocaleString()} orders)`,
          },
          {
            label: "Net Profit",
            value: fmtCur(totalProfit),
            color: totalProfit >= 0 ? "#10b981" : "#ef4444",
            icon: "📈",
            subtitle: `${((totalProfit / (totalRevenue || 1)) * 100).toFixed(1)}% margin`,
          },
          {
            label: "Total Units",
            value: fmtNum(totalUnits),
            color: "#06b6d4",
            icon: "📦",
            subtitle: `${(totalUnits / (totalOrders || 1)).toFixed(1)} units/order`,
          },
          {
            label: "Total Orders",
            value: fmtNum(totalOrders),
            color: "#f59e0b",
            icon: "🛒",
            subtitle: activePeriodLabel,
          },
          {
            label: "ASP",
            value: fmtCur(asp),
            color: "#8b5cf6",
            icon: "🏷️",
            subtitle: "Average selling price",
          },
        ].map(kpi => (
          <div key={kpi.label} className="card" style={{ padding: "16px 20px", borderLeft: `4px solid ${kpi.color}`, position: "relative" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{kpi.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: kpi.color }}>{kpi.value}</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{kpi.subtitle}</div>
            <div style={{ position: "absolute", top: 12, right: 16, fontSize: 22, opacity: 0.3 }}>{kpi.icon}</div>
          </div>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 8, color: "var(--text-muted)", fontSize: 12 }}>Updating...</div>}

      {/* ═══════════════════ OVERVIEW TAB ═══════════════════ */}
      {activeTab === "overview" && (
        <>
          {/* Monthly Trend */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><div className="card-title">Total Sales by Month</div></div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={monthlyChart}>
                <defs>
                  <linearGradient id="gRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => fmtK(v)} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: any) => fmtCur(Number(v))} />
                <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2.5} fill="url(#gRevenue)" name="Revenue" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* SKU Bar + State Donut — 2 columns */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            {/* Top SKUs Bar */}
            <div className="card">
              <div className="card-header"><div className="card-title">Total Sales by SKU</div><div className="card-subtitle">Click bar to filter</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={topSkus} layout="vertical" margin={{ left: 70 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={65} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => fmtCur(Number(v))} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d: any) => toggleSku(d.name)}>
                    {topSkus.map((s: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={selectedSkus.length > 0 && !selectedSkus.some(x => x.toLowerCase() === s.name?.toLowerCase()) ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* SKU Donut */}
            <div className="card">
              <div className="card-header"><div className="card-title">Sales Distribution by SKU</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <PieChart>
                  <Pie data={topSkus.slice(0, 10)} cx="50%" cy="50%" innerRadius={70} outerRadius={130}
                    paddingAngle={2} dataKey="revenue" nameKey="name"
                    label={({ name, percent }: any) => `${name} (${((percent || 0) * 100).toFixed(1)}%)`}
                    labelLine={{ strokeWidth: 1 }} cursor="pointer"
                    onClick={(d: any) => toggleSku(d.name)}>
                    {topSkus.slice(0, 10).map((s: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={selectedSkus.length > 0 && !selectedSkus.some(x => x.toLowerCase() === s.name?.toLowerCase()) ? 0.3 : 1} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => fmtCur(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Units Bar + Units Donut — 2 columns */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-header"><div className="card-title">Total Units by SKU</div><div className="card-subtitle">Click bar to filter</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={topSkusByUnits} layout="vertical" margin={{ left: 70 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" tickFormatter={(v: number) => fmtNum(v)} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={65} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => `${fmtNum(Number(v))} units`} />
                  <Bar dataKey="units" radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d: any) => toggleSku(d.name)}>
                    {topSkusByUnits.map((s: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={selectedSkus.length > 0 && !selectedSkus.some(x => x.toLowerCase() === s.name?.toLowerCase()) ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-header"><div className="card-title">Units Distribution by SKU</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <PieChart>
                  <Pie data={topSkusByUnits.slice(0, 10)} cx="50%" cy="50%" innerRadius={70} outerRadius={130}
                    paddingAngle={2} dataKey="units" nameKey="name"
                    label={({ name, percent }: any) => `${name} (${((percent || 0) * 100).toFixed(1)}%)`}
                    labelLine={{ strokeWidth: 1 }} cursor="pointer"
                    onClick={(d: any) => toggleSku(d.name)}>
                    {topSkusByUnits.slice(0, 10).map((s: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={selectedSkus.length > 0 && !selectedSkus.some(x => x.toLowerCase() === s.name?.toLowerCase()) ? 0.3 : 1} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => `${fmtNum(Number(v))} units`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* State Bar + State Donut — 2 columns */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-header"><div className="card-title">Total Sales by State</div><div className="card-subtitle">Click to filter</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={stateData.slice(0, 12)} layout="vertical" margin={{ left: 90 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={85} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => fmtCur(Number(v))} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d: any) => setFilter("state", d.name)}>
                    {stateData.slice(0, 12).map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={filters.state && filters.state !== stateData[i]?.name ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-header"><div className="card-title">State Distribution</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <PieChart>
                  <Pie data={stateData.slice(0, 10)} cx="50%" cy="50%" innerRadius={70} outerRadius={130}
                    paddingAngle={2} dataKey="revenue" nameKey="name"
                    label={({ name, percent }: any) => `${name?.substring(0,8)} (${((percent||0)*100).toFixed(0)}%)`}
                    labelLine={{ strokeWidth: 1 }} cursor="pointer"
                    onClick={(d: any) => setFilter("state", d.name)}>
                    {stateData.slice(0, 10).map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={filters.state && filters.state !== stateData[i]?.name ? 0.3 : 1} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => fmtCur(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tier Donut + Date-wise Table — 2 columns */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-header"><div className="card-title">Revenue by City Tier</div><div className="card-subtitle">Click to filter</div></div>
              {tierData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={tierData} cx="50%" cy="50%" innerRadius={60} outerRadius={110}
                      paddingAngle={4} dataKey="revenue" nameKey="name" cursor="pointer"
                      label={({ name, percent }: any) => `${name} (${((percent||0)*100).toFixed(0)}%)`}
                      onClick={(d: any) => setFilter("tier", d.name)}>
                      {tierData.map((e: any) => (
                        <Cell key={e.name} fill={TIER_COLORS[e.name] || "#64748b"} opacity={filters.tier && filters.tier !== e.name ? 0.3 : 1} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                      formatter={(v: any) => fmtCur(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>No tier data</div>}
            </div>

            {/* Date-wise summary table */}
            <div className="card">
              <div className="card-header"><div className="card-title">Date-wise Summary</div></div>
              <div className="table-container" style={{ maxHeight: 300, overflowY: "auto" }}>
                <table>
                  <thead><tr><th>Month</th><th>Revenue</th><th>Profit</th><th>Orders</th><th>ASP</th></tr></thead>
                  <tbody>
                    {monthlyChart.map((m: any) => (
                      <tr key={m.month}>
                        <td style={{ fontWeight: 600 }}>{m.month}</td>
                        <td>{fmtCur(m.revenue)}</td>
                        <td style={{ color: m.profit >= 0 ? "var(--success)" : "var(--danger)" }}>{fmtCur(m.profit)}</td>
                        <td>{fmtNum(m.orders)}</td>
                        <td>{fmtNum(m.revenue / (m.orders || 1))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* State-wise detail table */}
          <div className="card">
            <div className="card-header"><div className="card-title">State-wise Summary</div></div>
            <div className="table-container" style={{ maxHeight: 350, overflowY: "auto" }}>
              <table>
                <thead><tr><th>State</th><th>Revenue</th><th>Profit</th><th>Orders</th></tr></thead>
                <tbody>
                  {stateData.map((s: any) => (
                    <tr key={s.name} style={{ cursor: "pointer" }} onClick={() => setFilter("state", s.name)}>
                      <td style={{ fontWeight: 600, color: filters.state === s.name ? "var(--accent)" : undefined }}>{s.name}</td>
                      <td>{fmtCur(s.revenue)}</td>
                      <td style={{ color: s.profit >= 0 ? "var(--success)" : "var(--danger)" }}>{fmtCur(s.profit)}</td>
                      <td>{fmtNum(s.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════ GEOGRAPHY TAB ═══════════════════ */}
      {activeTab === "geography" && (
        <>
          {/* India Map */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div className="card-title">Net Sales by State</div>
              <div className="card-subtitle">State color = revenue intensity · Bubbles = volume · Click to filter</div>
            </div>
            <div style={{ width: "100%", maxWidth: 800, margin: "0 auto" }}>
              <IndiaMapChart
                selectedState={filters.state}
                onStateClick={(name) => setFilter("state", name)}
                mapMarkers={mapMarkers}
                maxMapRevenue={maxMapRevenue}
                getStateFill={getStateFill}
                fmtK={fmtK}
              />
              {/* Map Legend */}
              <div style={{ display: "flex", justifyContent: "center", gap: 16, padding: "8px 0", fontSize: 11, color: "var(--text-muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(99,102,241,0.15)", border: "1px solid #475569" }} /> Low
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(99,102,241,0.5)" }} /> Medium
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(99,102,241,0.9)" }} /> High
                </span>
              </div>
            </div>
          </div>

          {/* Top Cities Bar + Tier Distribution */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-header"><div className="card-title">Top Cities by Revenue</div><div className="card-subtitle">Click to filter</div></div>
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={cityData.slice(0, 12)} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={75} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => fmtCur(Number(v))}
                    labelFormatter={(l: any) => { const c = cityData.find((x: any) => x.name === l); return `${l} (${c?.tier || ""})`; }}
                  />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d: any) => toggleCity(d.name)}>
                    {cityData.slice(0, 12).map((c: any, i: number) => (
                      <Cell key={i} fill={TIER_COLORS[c.tier] || "#64748b"} opacity={selectedCities.length > 0 && !selectedCities.some(s => s.toLowerCase() === c.name?.toLowerCase()) ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-header"><div className="card-title">Revenue by City Tier</div></div>
              {tierData.length > 0 ? (
                <ResponsiveContainer width="100%" height={380}>
                  <PieChart>
                    <Pie data={tierData} cx="50%" cy="50%" innerRadius={70} outerRadius={130}
                      paddingAngle={4} dataKey="revenue" nameKey="name" cursor="pointer"
                      label={({ name, percent }: any) => `${name} (${((percent||0)*100).toFixed(0)}%)`}
                      onClick={(d: any) => setFilter("tier", d.name)}>
                      {tierData.map((e: any) => (
                        <Cell key={e.name} fill={TIER_COLORS[e.name] || "#64748b"} opacity={filters.tier && filters.tier !== e.name ? 0.3 : 1} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                      formatter={(v: any) => fmtCur(Number(v))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>No tier data</div>}
            </div>
          </div>

          {/* City Details Table */}
          <div className="card">
            <div className="card-header"><div className="card-title">City-wise Sales Details</div></div>
            <div className="table-container" style={{ maxHeight: 400, overflowY: "auto" }}>
              <table>
                <thead><tr><th>City</th><th>State</th><th>Tier</th><th>Revenue</th><th>Orders</th></tr></thead>
                <tbody>
                  {cityData.slice(0, 30).map((c: any) => (
                    <tr key={`${c.name}-${c.state}`} style={{ cursor: "pointer" }} onClick={() => toggleCity(c.name)}>
                      <td style={{ fontWeight: 600, color: selectedCities.some(s => s.toLowerCase() === c.name?.toLowerCase()) ? "var(--accent)" : undefined }}>{c.name}</td>
                      <td>{c.state}</td>
                      <td><span className="badge" style={{ background: TIER_COLORS[c.tier] || "#64748b", color: "#fff", fontSize: 10, padding: "2px 8px" }}>{c.tier}</span></td>
                      <td>{fmtCur(c.revenue)}</td>
                      <td>{fmtNum(c.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════ ORDERS TAB ═══════════════════ */}
      {activeTab === "orders" && orders && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Order Details ({orders.pagination?.total || 0})</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: "32px" }}>Page {page + 1}</span>
              <button className="btn btn-ghost btn-sm" disabled={(page + 1) * 50 >= (orders.pagination?.total || 0)} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          </div>
          <div className="table-container" style={{ maxHeight: 500, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr><th>Order ID</th><th>Date</th><th>SKU</th><th>Qty</th><th>Price</th><th>Profit</th><th>City</th><th>State</th><th>Channel</th></tr>
              </thead>
              <tbody>
                {(orders.orders || []).map((o: any, i: number) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11, fontFamily: "monospace" }}>{o.amazon_order_id}</td>
                    <td style={{ fontSize: 11 }}>{o.purchase_date ? new Date(o.purchase_date).toLocaleDateString("en-IN") : "—"}</td>
                    <td style={{ fontWeight: 600, cursor: "pointer", color: "var(--accent-hover)" }} onClick={() => toggleSku(o.sku)}>{o.sku}</td>
                    <td>{o.quantity}</td>
                    <td>{fmtCur(Number(o.item_price || 0))}</td>
                    <td style={{ color: Number(o.profit || 0) >= 0 ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
                      {o.profit != null ? fmtCur(Number(o.profit)) : "—"}
                    </td>
                    <td style={{ cursor: "pointer" }} onClick={() => o.ship_city && toggleCity(o.ship_city)}>{o.ship_city || "—"}</td>
                    <td style={{ cursor: "pointer" }} onClick={() => o.ship_state && setFilter("state", o.ship_state)}>{o.ship_state || "—"}</td>
                    <td style={{ fontSize: 10 }}>{o.fulfillment_channel || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════ PREDICTIONS TAB ═══════════════════ */}
      {activeTab === "predictions" && predictions && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Sales Forecast</div>
            <div className="card-subtitle">{predictions.methodology}</div>
          </div>
          {predictions.aggregateForecasts?.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={[
                ...(predictions.historical || []).map((h: any) => ({ month: h.month, revenue: h.total_revenue, type: "historical" })),
                ...(predictions.aggregateForecasts || []).map((f: any) => ({ month: f.month, predicted: f.predicted_revenue, lower: f.confidence_lower, upper: f.confidence_upper, type: "forecast" })),
              ]}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                  formatter={(v: any) => fmtCur(Number(v))} />
                <Area type="monotone" dataKey="revenue" stroke="#6366f1" fill="#6366f1" fillOpacity={0.2} name="Actual" />
                <Area type="monotone" dataKey="predicted" stroke="#f59e0b" strokeDasharray="5 5" fill="#f59e0b" fillOpacity={0.1} name="Forecast" />
                <Area type="monotone" dataKey="upper" stroke="none" fill="#f59e0b" fillOpacity={0.05} name="Upper Bound" />
                <Legend />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>
              Not enough historical data for predictions. Need at least 3 months.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
