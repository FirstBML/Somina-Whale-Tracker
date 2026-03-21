import { getMetrics, getWindowMetrics, getShockData } from "../../../lib/analyticsEngine";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url  = new URL(req.url);
  const win  = parseInt(url.searchParams.get("window") ?? "86400000", 10);

  const metrics = getMetrics();
  const window  = getWindowMetrics(win);
  const shock   = getShockData();

  return Response.json({ metrics, window, shock });
}