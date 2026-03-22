// Server-side paginated network activity
// FIX: accepts ?window=ms so the table respects the dashboard time filter

import { NextRequest } from "next/server";
import Database from "better-sqlite3";

const db = new Database("whales.db");

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h default
const PAGE_SIZE = 20;

// Valid sort columns — whitelist to prevent SQL injection
const VALID_SORTS: Record<string, string> = {
  time:   "received_at",
  amount: "CAST(amount AS REAL)",
  fee:    "CAST(REPLACE(tx_fee,'~','') AS REAL)",
  block:  "CAST(block_number AS INTEGER)",
  from:   "from_addr",
  to:     "to_addr",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawPage = Math.max(0, parseInt(searchParams.get("page") ?? "0"));
  const page    = Math.min(rawPage, 100_000); // hard cap at 100k pages
  const minAmt  = parseFloat(searchParams.get("min") ?? "0") || 0;
  const maxAmt  = parseFloat(searchParams.get("max") ?? "0") || null;
  const sortKey = searchParams.get("sort") ?? "time";
  const dir     = searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  const col     = VALID_SORTS[sortKey] ?? "received_at";

  // FIX: respect the window filter from the dashboard
  const windowMs = parseInt(searchParams.get("window") ?? String(DEFAULT_WINDOW_MS), 10);
  const safeWindow = Math.min(Math.max(windowMs, 60_000), DEFAULT_WINDOW_MS); // clamp 1m–24h
  const cutoff = Date.now() - safeWindow;

  const offset = page * PAGE_SIZE;

  try {
    // Build WHERE clause
    const conditions = [`received_at >= ${cutoff}`];
    if (minAmt > 0)       conditions.push(`CAST(amount AS REAL) >= ${minAmt}`);
    if (maxAmt !== null)  conditions.push(`CAST(amount AS REAL) <= ${maxAmt}`);
    const where = conditions.join(" AND ");

    const rows = db.prepare(`
      SELECT
        id, from_addr, to_addr, amount, is_transfer,
        tx_hash, block_number, tx_fee,
        COALESCE(block_timestamp, received_at) AS display_ts,
        received_at
      FROM block_tx_events
      WHERE ${where}
      ORDER BY ${col} ${dir}
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `).all() as any[];

    const { n: total } = db.prepare(`
      SELECT COUNT(*) as n FROM block_tx_events WHERE ${where}
    `).get() as { n: number };

    const { n: sttCount } = db.prepare(`
      SELECT COUNT(*) as n FROM block_tx_events
      WHERE ${where} AND CAST(amount AS REAL) > 0
    `).get() as { n: number };

    return Response.json({
      rows: rows.map(r => ({
        id:          r.id,
        from:        r.from_addr,
        to:          r.to_addr,
        amount:      r.amount,
        amountRaw:   parseFloat(r.amount ?? "0"),
        isTransfer:  r.is_transfer === 1,
        txHash:      r.tx_hash,
        blockNumber: r.block_number ?? "",
        timestamp:   r.display_ts,
        txFee:       r.tx_fee ?? "0",
      })),
      total,
      sttCount,
      page,
      pages:    Math.max(1, Math.ceil(total / PAGE_SIZE)),
      pageSize: PAGE_SIZE,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}