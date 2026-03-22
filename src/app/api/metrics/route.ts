/**
 * /api/metrics — Returns live KPI metrics, optionally filtered.
 *
 * Query params (all optional):
 *   window  — time window in ms (default: 86400000 = 24h)
 *   min     — minimum whale size in STT
 *   max     — maximum whale size in STT
 *   token   — token symbol filter (e.g. "STT")
 *   wallet  — wallet address filter (matches from or to)
 */
import { getMetrics, getWindowMetrics, getShockData, getFilteredMetrics, type MetricsFilter } from "../../../lib/analyticsEngine";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url    = new URL(req.url);
  const win    = parseInt(url.searchParams.get("window") ?? "86400000", 10);
  const minStt = parseFloat(url.searchParams.get("min") ?? "");
  const maxStt = parseFloat(url.searchParams.get("max") ?? "");
  const token  = url.searchParams.get("token") ?? undefined;
  const wallet = url.searchParams.get("wallet") ?? undefined;

  const hasFilter = !isNaN(minStt) || !isNaN(maxStt) || !!token || !!wallet || win !== 86400000;

  const filter: MetricsFilter = {
    windowMs: win,
    minStt:   !isNaN(minStt) ? minStt : undefined,
    maxStt:   !isNaN(maxStt) ? maxStt : undefined,
    token,
    wallet,
  };

  // Use O(1) incremental path when no filter is active
  const metrics = hasFilter ? getFilteredMetrics(filter) : getMetrics();
  const window  = getWindowMetrics(win);
  const shock   = getShockData();

  return Response.json({ metrics, window, shock });
}