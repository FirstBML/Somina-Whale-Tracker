"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWhaleAlerts, WhaleAlert, BlockTx, LiveMetrics, clearFrontendCache, fetchFilteredMetrics } from "../lib/useWhaleAlerts";
import { useOraclePrices, formatUsd, OraclePrice } from "../lib/useOraclePrices";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, RadialBarChart, RadialBar, PolarAngleAxis } from "recharts";

type Theme = "dark";
const T = {
  dark: { pageBg:"#050d1a",headerBg:"#070f1eee",card:"#0a1628",border:"rgba(6,182,212,0.2)",text:"#e2f8ff",subtext:"#7ecde0",muted:"rgba(103,184,204,0.75)",accent:"#06b6d4",accentBg:"rgba(6,182,212,0.12)",input:"#05111f",chartGrid:"#0e2a3a",chartAxis:"#3d8fa6",tooltipBg:"#060e1c",tooltipBorder:"#0e4f5e",rowHover:"rgba(6,182,212,0.06)",errBg:"rgba(127,29,29,0.3)",errBorder:"rgba(185,28,28,0.4)",errText:"#f87171",statVal:"#67e8f9",tableHead:"#071322",tableRow:"#0a1628",tableAlt:"#0c1a30",badgeBg:"rgba(6,182,212,0.15)",badgeText:"#67e8f9",reactionRow:"rgba(168,85,247,0.08)",alertRow:"rgba(251,146,60,0.08)",myTxRow:"rgba(74,222,128,0.08)" },
};

const TOKEN_COLORS: Record<string,string> = {STT:"#06b6d4",USDC:"#2775CA",WETH:"#627EEA",WBTC:"#F7931A",USDT:"#26A17B",LINK:"#2A5ADA",UNI:"#FF007A",AAVE:"#B6509E"};
const TIME_PRESETS = [{label:"24h", ms:24*60*60_000}];
const short     = (a:string) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const shortHash = (h:string) => h ? `${h.slice(0,10)}…${h.slice(-6)}` : "—";
const addrUrl   = (a:string) => `https://shannon-explorer.somnia.network/address/${a}`;
const txUrl     = (h:string) => `https://shannon-explorer.somnia.network/tx/${h}`;
const num       = (s:string) => parseFloat((s ?? "0").replace(/,/g,"")) || 0;

const TOKEN_PRICE_MAP: Record<string,string> = {
  WBTC:"BTC", BTC:"BTC", WETH:"ETH", ETH:"ETH",
  USDC:"USDC", USDT:"USDT", SOL:"SOL",
};

function usdVal(amount:number, token:string, prices:Record<string,any>): string|null {
  const key = TOKEN_PRICE_MAP[token];
  if(!key || !prices[key]) return null;
  const usd = amount * prices[key].price;
  if(usd>=1_000_000) return `$${(usd/1_000_000).toFixed(2)}M`;
  if(usd>=1_000)     return `$${Math.round(usd).toLocaleString()}`;
  return `$${usd.toFixed(2)}`;
}

function timeAgo(ts: number) {
  if (!ts || ts <= 0) return "Just now";
  const ms = ts < 10000000000 ? ts * 1000 : ts;
  const d = Math.floor((Date.now() - ms) / 1000);
  if (d < 0)     return "Just now";
  if (d < 60)    return `${d}s ago`;
  if (d < 3600)  return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}

function fmtTime(ts:number){const ms=ts<10_000_000_000?ts*1000:ts;return new Date(ms).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function fmtMs(ms:number){if(ms<1000)return`${Math.round(ms)}ms`;if(ms<60000)return`${(ms/1000).toFixed(1)}s`;return`${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;}

let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  try { if(!_audioCtx) _audioCtx=new((window as any).AudioContext||(window as any).webkitAudioContext)(); return _audioCtx; } catch { return null; }
}
function resumeAudio() { const c=getAudioCtx(); if(c&&c.state==="suspended") c.resume(); }
function playPing() {
  try {
    const ctx=getAudioCtx(); if(!ctx) return;
    if(ctx.state==="suspended") ctx.resume();
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(880,ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(440,ctx.currentTime+0.3);
    g.gain.setValueAtTime(0.4,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4);
    o.start(); o.stop(ctx.currentTime+0.4);
  } catch {}
}
function downloadCSV(alerts:WhaleAlert[]){const rows=["type,timestamp,from,to,amount_tokens,token,tx_hash,block_number,reaction_count",...alerts.map(a=>`${a.type},${new Date(a.timestamp).toISOString()},${a.from},${a.to},${a.amount},${a.token},${a.txHash},${a.blockNumber},${a.reactionCount??""}`)];const blob=new Blob([rows.join("\n")],{type:"text/csv"});const url=URL.createObjectURL(blob);const el=document.createElement("a");el.href=url;el.download="whale_alerts.csv";el.click();URL.revokeObjectURL(url);}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Badge({text,color,t}:{text:string;color?:string;t:typeof T.dark}){return<span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:color?`${color}22`:t.badgeBg,color:color??t.badgeText,border:`1px solid ${color?`${color}44`:t.border}`}}>{text}</span>;}
function TypeBadge({type,t}:{type:string;t:typeof T.dark}){
  const map:Record<string,{label:string;color:string}>={whale:{label:"🐋 WHALE",color:"#06b6d4"},reaction:{label:"⚡ REACTION",color:"#a855f7"},alert:{label:"🚨 ALERT",color:"#f97316"},momentum:{label:"🔥 MOMENTUM",color:"#ef4444"}};
  const m=map[type]??map.whale;
  return<span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:`${m.color}22`,color:m.color,border:`1px solid ${m.color}44`,whiteSpace:"nowrap"}}>{m.label}</span>;
}
function Th({children,t}:{children?:string;t:typeof T.dark}){return<th style={{padding:"9px 12px",textAlign:"left",color:t.subtext,fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:"monospace",borderBottom:`1px solid ${t.border}`,background:t.tableHead,whiteSpace:"nowrap"}}>{children}</th>;}
function SortTh({children,t,active,dir,onClick}:{children:string;t:typeof T.dark;active:boolean;dir:"asc"|"desc";onClick:()=>void}){return<th onClick={onClick} style={{padding:"9px 12px",textAlign:"left",color:active?t.accent:t.subtext,fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:"monospace",borderBottom:`1px solid ${t.border}`,background:t.tableHead,whiteSpace:"nowrap",cursor:"pointer",userSelect:"none"}}>{children}{active?<span style={{marginLeft:4,fontSize:9}}>{dir==="desc"?"▼":"▲"}</span>:<span style={{marginLeft:4,fontSize:9,opacity:0.3}}>⇅</span>}</th>;}
function Td({children,t,bold,accent,color}:{children:React.ReactNode;t:typeof T.dark;bold?:boolean;accent?:boolean;color?:string}){return<td style={{padding:"10px 12px",color:color??(accent?t.accent:t.text),fontFamily:"monospace",fontSize:11,fontWeight:bold?700:400,borderBottom:`1px solid ${t.border}`,whiteSpace:"nowrap"}}>{children}</td>;}
function ExLink({href,label,t}:{href:string;label:string;t:typeof T.dark}){if(!href)return<span style={{color:t.muted,fontFamily:"monospace",fontSize:11}}>—</span>;return(<a href={href} target="_blank" rel="noreferrer" style={{color:t.subtext,textDecoration:"none",fontFamily:"monospace",fontSize:11,display:"inline-flex",alignItems:"center",gap:3}} onMouseEnter={e=>(e.currentTarget.style.color=t.accent)} onMouseLeave={e=>(e.currentTarget.style.color=t.subtext)}>{label}<span style={{fontSize:9,opacity:0.6}}>↗</span></a>);}
function KpiCard({label,value,sub,color,t}:{label:string;value:string|number;sub?:string;color?:string;t:typeof T.dark}){return(<div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 16px"}}><p style={{color:t.subtext,fontSize:10,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"monospace",margin:"0 0 4px"}}>{label}</p><p style={{color:color??t.statVal,fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>{sub&&<p style={{color:t.muted,fontSize:10,margin:"2px 0 0",fontFamily:"monospace"}}>{sub}</p>}</div>);}

// ── Whale Pressure Gauge ──────────────────────────────────────────────────────
function WhalePressureGauge({pressure, t}: {pressure: number; t: typeof T.dark}) {
  const getColor = (p: number) => {
    if (p >= 0.5)  return "#4ade80";
    if (p >= 0.2)  return "#86efac";
    if (p >= 0.05) return "#bef264";
    if (p <= -0.5) return "#ef4444";
    if (p <= -0.2) return "#f87171";
    if (p <= -0.05)return "#facc15";
    return "#6b7280";
  };
  const getLabel = (p: number) => {
    if (p >= 0.5)  return "STRONG ACCUMULATION";
    if (p >= 0.2)  return "MODERATE ACCUMULATION";
    if (p >= 0.05) return "LIGHT ACCUMULATION";
    if (p <= -0.5) return "STRONG DISTRIBUTION";
    if (p <= -0.2) return "MODERATE DISTRIBUTION";
    if (p <= -0.05)return "LIGHT DISTRIBUTION";
    return "BALANCED";
  };
  const color = getColor(pressure);
  const label = getLabel(pressure);
  const pressurePercent = pressure * 100;
  const displayVal = `${pressurePercent >= 0 ? "+" : ""}${pressurePercent.toFixed(1)}%`;
  const cx = 130, cy = 100, startDeg = 210, sweep = 240;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const pt = (r: number, d: number) => [cx + r * Math.cos(toRad(d)), cy - r * Math.sin(toRad(d))];
  const mappedPct = Math.min(100, Math.max(0, ((pressure + 1) / 2) * 100));
  const arcPath = (inner: number, outer: number, fill: number) => {
    const endDeg = startDeg - (sweep * (fill / 100));
    const [x1s,y1s]=pt(outer,startDeg),[x1e,y1e]=pt(outer,endDeg),[x2s,y2s]=pt(inner,endDeg),[x2e,y2e]=pt(inner,startDeg);
    return `M${x1s},${y1s} A${outer},${outer} 0 ${fill>50?1:0},0 ${x1e},${y1e} L${x2s},${y2s} A${inner},${inner} 0 ${fill>50?1:0},1 ${x2e},${y2e} Z`;
  };
  const bands = [
    {from:0,to:20,color:"#ef4444"},{from:20,to:40,color:"#f87171"},
    {from:40,to:60,color:"#6b7280"},{from:60,to:80,color:"#86efac"},{from:80,to:100,color:"#4ade80"},
  ];
  const bandPath = (from: number, to: number) => {
    const endDeg=startDeg-(sweep*(from/100)), startD=startDeg-(sweep*(to/100));
    const [x1s,y1s]=pt(72,startD),[x1e,y1e]=pt(72,endDeg),[x2s,y2s]=pt(88,endDeg),[x2e,y2e]=pt(88,startD);
    return `M${x1s},${y1s} A72,72 0 ${(to-from)>50?1:0},1 ${x1e},${y1e} L${x2s},${y2s} A88,88 0 ${(to-from)>50?1:0},0 ${x2e},${y2e} Z`;
  };
  const needleAngle = startDeg - (sweep * (mappedPct / 100));
  const [nx,ny] = pt(62, needleAngle);
  const ticks = [0,25,50,75,100];
  const tickLabels = ["-100%","-50%","0","+50%","+100%"];
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
      <svg width={260} height={165} viewBox="0 0 260 165">
        <defs>
          <filter id="pressureGlow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <radialGradient id="dialBg" cx="50%" cy="70%" r="60%"><stop offset="0%" stopColor="rgba(6,182,212,0.08)"/><stop offset="100%" stopColor="rgba(6,182,212,0)"/></radialGradient>
        </defs>
        <path d={arcPath(58,96,100)} fill="url(#dialBg)"/>
        <path d={arcPath(68,92,100)} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5"/>
        {bands.map((b,i)=><path key={i} d={bandPath(b.from,b.to)} fill={b.color} opacity="0.85"/>)}
        <path d={arcPath(70,88,mappedPct)} fill={color} opacity="0.35" filter="url(#pressureGlow)"/>
        <path d={arcPath(86,90,mappedPct)} fill={color} opacity="0.9" filter="url(#pressureGlow)"/>
        {ticks.map((p,i)=>{
          const a=startDeg-(sweep*(p/100));
          const [ox,oy]=pt(96,a),[ix,iy]=pt(88,a),[lx,ly]=pt(104,a);
          return(<g key={i}><line x1={ox} y1={oy} x2={ix} y2={iy} stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"/><text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fill="rgba(103,184,204,0.6)" fontSize="7" fontFamily="monospace">{tickLabels[i]}</text></g>);
        })}
        {Array.from({length:21},(_,i)=>{
          if([0,5,10,15,20].includes(i)) return null;
          const a=startDeg-(sweep*(i/20));
          const [ox,oy]=pt(93,a),[ix,iy]=pt(88,a);
          return<line key={i} x1={ox} y1={oy} x2={ix} y2={iy} stroke="rgba(255,255,255,0.2)" strokeWidth="0.8"/>;
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.5" strokeLinecap="round" filter="url(#pressureGlow)"/>
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="rgba(255,255,255,0.6)" strokeWidth="1" strokeLinecap="round"/>
        <circle cx={cx} cy={cy} r={7} fill="#0a1628" stroke={color} strokeWidth="2"/>
        <circle cx={cx} cy={cy} r={3} fill={color} filter="url(#pressureGlow)"/>
        <text x={cx} y={cy+32} textAnchor="middle" fill={color} fontSize="20" fontWeight="800" fontFamily="monospace" filter="url(#pressureGlow)">{displayVal}</text>
        <rect x={cx-48} y={cy+46} width={96} height={14} rx={4} fill={`${color}22`} stroke={`${color}44`} strokeWidth="1"/>
        <text x={cx} y={cy+57} textAnchor="middle" fill={color} fontSize="8" fontWeight="700" fontFamily="monospace" letterSpacing="0.1em">{label}</text>
      </svg>
    </div>
  );
}

// ── Price Ticker ──────────────────────────────────────────────────────────────
const TICKER_SYMBOLS = ["ETH","BTC","USDC","USDT","SOL"] as const;
const SYMBOL_COLORS: Record<string,string> = {ETH:"#627EEA",BTC:"#F7931A",USDC:"#2775CA",WETH:"#627EEA",USDT:"#26A17B",SOL:"#9945FF",SOMI:"#06b6d4"};

function PriceTicker({prices,loading,t,lastFetchedAt}:{prices:Record<string,OraclePrice>;loading:boolean;t:typeof T.dark;lastFetchedAt:number}){
  const available=TICKER_SYMBOLS.filter(s=>prices[s]&&prices[s].price>0);
  if(loading&&!available.length) return null;
  const items=available.map(s=>{const p=prices[s];const color=SYMBOL_COLORS[s]??t.accent;return(<span key={s} style={{display:"inline-flex",alignItems:"center",gap:5,marginRight:32,flexShrink:0}}><span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color,padding:"1px 5px",borderRadius:3,background:`${color}18`,border:`1px solid ${color}33`}}>{s}</span><span style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:t.text}}>{formatUsd(p.price)}</span></span>);});
  return(<div style={{display:"flex",alignItems:"center",gap:12,borderTop:`1px solid ${t.border}`,marginTop:8,paddingTop:8,overflow:"hidden"}}><span style={{color:t.muted,fontSize:8,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",flexShrink:0,whiteSpace:"nowrap"}}>Oracle Prices</span><div style={{flex:1,overflow:"hidden",position:"relative"}}><div style={{display:"inline-flex",animation:"tickerScroll 20s linear infinite",whiteSpace:"nowrap"}}>{items}{items}</div></div><span style={{fontSize:8,color:t.muted,fontFamily:"monospace",flexShrink:0,whiteSpace:"nowrap"}}>Protofire · DIA · Somnia Testnet{lastFetchedAt>0&&<span style={{marginLeft:6}}>· {timeAgo(lastFetchedAt)}</span>}</span></div>);
}

// ── Burst Banner ──────────────────────────────────────────────────────────────
type Burst = { count:number; volume:number; windowSec:number; dominantToken:string; tokenBreakdown:Record<string,number> } | null;

function BurstBanner({burst,t}:{burst:Burst;t:typeof T.dark}){
  const[visible,setVisible]=useState(false);
  const prevRef=useRef<Burst>(null);
  useEffect(()=>{if(burst&&!prevRef.current)setVisible(true);if(!burst)setVisible(false);prevRef.current=burst;},[burst]);
  if(!burst||!visible) return null;
  const tokenList=burst.tokenBreakdown?Object.entries(burst.tokenBreakdown).sort((a,b)=>b[1]-a[1]).map(([tk,n])=>`${n}× ${tk}`).join(", "):burst.dominantToken;
  return(<div style={{marginBottom:14,padding:"14px 18px",borderRadius:12,background:"rgba(249,115,22,0.1)",border:"1px solid rgba(249,115,22,0.45)",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",animation:"burstPulse 2s ease-in-out infinite"}}><span style={{fontSize:20}}>🚨</span><div><div style={{color:"#f97316",fontWeight:700,fontSize:12,fontFamily:"monospace",letterSpacing:"0.1em",textTransform:"uppercase"}}>Whale Momentum Detected</div><div style={{color:"#fed7aa",fontSize:11,fontFamily:"monospace",marginTop:2}}>{burst.count} transfers · {burst.volume.toFixed(8)} tokens · within {burst.windowSec}s<span style={{color:"#f97316",marginLeft:10}}>{tokenList}</span></div></div><button onClick={()=>setVisible(false)} style={{marginLeft:"auto",background:"none",border:"none",color:"#f97316",cursor:"pointer",fontSize:16}}>✕</button></div>);
}

// ── Live Feed Tab ─────────────────────────────────────────────────────────────
function LiveFeedTab({alerts,t,connectedAddr,burst,oraclePrices,blockTxs,totalBlockTxsSeen,timePreset,feedSubTab,setFeedSubTab,netMinAmt,setNetMinAmt,netMaxAmt,setNetMaxAmt}:{alerts:WhaleAlert[];t:typeof T.dark;connectedAddr?:string;burst:Burst;oraclePrices:Record<string,any>;blockTxs:BlockTx[];totalBlockTxsSeen:number;timePreset:number;feedSubTab:"alerts"|"network-activity";setFeedSubTab:(v:"alerts"|"network-activity")=>void;netMinAmt:string;setNetMinAmt:(v:string)=>void;netMaxAmt:string;setNetMaxAmt:(v:string)=>void;}){
  const[expanded,setExpanded]=useState<string|null>(null);
  const[page,setPage]=useState(0);
  const PAGE=10;
  type WhaleSortCol="type"|"amount"|"time"|"block"|"from"|"to";
  const[whaleSort,setWhaleSort]=useState<{col:WhaleSortCol;dir:"asc"|"desc"}>({col:"time",dir:"desc"});
  function toggleWhaleSort(col:WhaleSortCol){setWhaleSort(s=>s.col===col?{col,dir:s.dir==="desc"?"asc":"desc"}:{col,dir:col==="time"?"desc":"desc"});setPage(0);}
  const sortedAlerts=useMemo(()=>{const d=whaleSort.dir==="desc"?-1:1;return[...alerts].sort((a,b)=>{switch(whaleSort.col){case"type":return d*(a.type.localeCompare(b.type));case"amount":return d*(num(a.amount)-num(b.amount));case"block":return d*(parseInt(a.blockNumber||"0")-parseInt(b.blockNumber||"0"));case"from":return d*(a.from.localeCompare(b.from));case"to":return d*(a.to.localeCompare(b.to));case"time":default:return d*(a.timestamp-b.timestamp);}});},[alerts,whaleSort]);
  const totalPages=Math.max(1,Math.ceil(sortedAlerts.length/PAGE));
  const pageAlerts=sortedAlerts.slice(page*PAGE,(page+1)*PAGE);
  const prevCount=useRef(alerts.length);
  useEffect(()=>{if(alerts.length!==prevCount.current){setPage(0);prevCount.current=alerts.length;}},[alerts.length]);
  function rowBg(a:WhaleAlert,i:number){const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());if(isMyTx)return t.myTxRow;if(a.type==="reaction")return i%2===0?t.reactionRow:`${t.reactionRow}cc`;if(a.type==="alert")return i%2===0?t.alertRow:`${t.alertRow}cc`;if(a.type==="momentum")return"rgba(239,68,68,0.08)";return i%2===0?t.tableRow:t.tableAlt;}
  type NetSortCol="from"|"to"|"amount"|"fee"|"block"|"time";
  const[netSort,setNetSort]=useState<{col:NetSortCol;dir:"asc"|"desc"}>({col:"time",dir:"desc"});
  const[netPage,setNetPage]=useState(0);
  const[netData,setNetData]=useState<{rows:BlockTx[];total:number;pages:number;sttCount:number}>({rows:[],total:0,pages:1,sttCount:0});
  const[netLoading,setNetLoading]=useState(false);
  function toggleNetSort(col:NetSortCol){setNetSort(s=>({col,dir:s.col===col&&s.dir==="desc"?"asc":"desc"}));setNetPage(0);}
  useEffect(()=>{if(feedSubTab!=="network-activity")return;setNetLoading(true);const p=new URLSearchParams({page:String(netPage),sort:netSort.col,dir:netSort.dir,window:String(timePreset),...(netMinAmt?{min:netMinAmt}:{}),...(netMaxAmt?{max:netMaxAmt}:{})});fetch(`/api/network-activity?${p}`).then(r=>r.json()).then(d=>{setNetData(d);setNetLoading(false);}).catch(()=>setNetLoading(false));},[netPage,netSort,netMinAmt,netMaxAmt,feedSubTab,timePreset]);
  const prevBlockTxLen=useRef(0);
  useEffect(()=>{if(Math.abs(blockTxs.length-prevBlockTxLen.current)>=10){prevBlockTxLen.current=blockTxs.length;if(feedSubTab==="network-activity"&&netPage===0){const p=new URLSearchParams({page:"0",sort:netSort.col,dir:netSort.dir,window:String(timePreset),...(netMinAmt?{min:netMinAmt}:{}),...(netMaxAmt?{max:netMaxAmt}:{})});fetch(`/api/network-activity?${p}`).then(r=>r.json()).then(setNetData).catch(()=>{});}}},[blockTxs.length,timePreset]);
  return(<div style={{padding:"14px 14px 0"}}>
    <BurstBanner burst={burst} t={t}/>
    <div style={{display:"flex",gap:4,marginBottom:12,borderBottom:`1px solid ${t.border}`,paddingBottom:8}}>
      <button onClick={()=>setFeedSubTab("alerts")} style={{fontSize:10,fontFamily:"monospace",padding:"4px 12px",borderRadius:6,cursor:"pointer",background:feedSubTab==="alerts"?t.accentBg:"transparent",color:feedSubTab==="alerts"?t.accent:t.muted,border:`1px solid ${feedSubTab==="alerts"?t.accent:"transparent"}`}}>Whale Alerts</button>
      <button onClick={()=>setFeedSubTab("network-activity")} style={{fontSize:10,fontFamily:"monospace",padding:"4px 12px",borderRadius:6,cursor:"pointer",background:feedSubTab==="network-activity"?t.accentBg:"transparent",color:feedSubTab==="network-activity"?t.accent:t.muted,border:`1px solid ${feedSubTab==="network-activity"?t.accent:"transparent"}`}}>🌐 Network Activity</button>
    </div>
    {feedSubTab==="alerts"&&(<>
      {!alerts.length?<div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>Waiting for activity...</div>
      :<><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr>
          <SortTh t={t} active={whaleSort.col==="type"}  dir={whaleSort.dir} onClick={()=>toggleWhaleSort("type")}>Type</SortTh>
          <Th t={t}>Token</Th>
          <SortTh t={t} active={whaleSort.col==="amount"} dir={whaleSort.dir} onClick={()=>toggleWhaleSort("amount")}>Amount</SortTh>
          <Th t={t}>USD Value / Reason</Th>
          <Th t={t}>Tx Fee (STT)</Th>
          <SortTh t={t} active={whaleSort.col==="from"} dir={whaleSort.dir} onClick={()=>toggleWhaleSort("from")}>From</SortTh>
          <SortTh t={t} active={whaleSort.col==="to"}   dir={whaleSort.dir} onClick={()=>toggleWhaleSort("to")}>To</SortTh>
          <Th t={t}>TX Hash / Linked TX</Th>
          <SortTh t={t} active={whaleSort.col==="block"} dir={whaleSort.dir} onClick={()=>toggleWhaleSort("block")}>Block</SortTh>
          <SortTh t={t} active={whaleSort.col==="time"}  dir={whaleSort.dir} onClick={()=>toggleWhaleSort("time")}>Time</SortTh>
          <Th t={t}></Th>
        </tr></thead>
        <tbody>{pageAlerts.map((a,i)=>{
          const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());
          const usd=a.type==="whale"?usdVal(num(a.amount),a.token,oraclePrices):null;
          const isSignal=a.type==="momentum"||a.type==="alert"||a.type==="reaction";
          const sigColor=a.type==="momentum"?"#ef4444":a.type==="alert"?"#f97316":"#a855f7";
          return(<>
            <tr key={a.id} style={{background:rowBg(a,i),cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=rowBg(a,i))}>
              <Td t={t}><div style={{display:"flex",gap:4,alignItems:"center"}}><TypeBadge type={a.type} t={t}/>{isMyTx&&<span style={{fontSize:8,background:"rgba(74,222,128,0.2)",color:"#4ade80",border:"1px solid rgba(74,222,128,0.4)",borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>YOU</span>}{a.blockNumber==="simulated"&&<span style={{fontSize:8,background:"#f97316",color:"white",borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>🧪 TEST</span>}</div></Td>
              <Td t={t}>{a.token?<Badge text={a.token} color={TOKEN_COLORS[a.token]} t={t}/>:<span style={{color:t.muted,fontSize:11}}>—</span>}</Td>
              <Td t={t} accent bold>{a.type==="whale"?parseFloat(a.amount).toFixed(8):<span style={{color:t.muted}}>—</span>}</Td>
              <Td t={t}>{usd?<span style={{color:"#4ade80",fontFamily:"monospace",fontSize:11,fontWeight:700}}>{usd}</span>:isSignal&&a.signalReason?<span style={{color:sigColor,fontSize:9,fontFamily:"monospace",maxWidth:180,display:"inline-block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={a.signalReason}>{a.signalReason}</span>:<span style={{color:t.muted,fontSize:10}}>—</span>}</Td>
              <Td t={t}><span style={{color:a.txFee?.startsWith("~")?t.muted:"#f59e0b",fontSize:10,fontFamily:"monospace"}}>{a.txFee&&parseFloat(a.txFee.replace("~",""))>0?(a.txFee.startsWith("~")?"~":"")+parseFloat(a.txFee.replace("~","")).toFixed(8):"—"}</span></Td>
              <Td t={t}><ExLink href={a.from?addrUrl(a.from):""} label={a.from?short(a.from):"—"} t={t}/></Td>
              <Td t={t}><ExLink href={a.to?addrUrl(a.to):""} label={a.to?short(a.to):"—"} t={t}/></Td>
              <Td t={t}>{a.txHash?<ExLink href={txUrl(a.txHash)} label={shortHash(a.txHash)} t={t}/>:isSignal&&a.linkedTxHash?<span style={{display:"flex",alignItems:"center",gap:3}}><span style={{color:t.muted,fontSize:8}}>→</span><ExLink href={txUrl(a.linkedTxHash)} label={shortHash(a.linkedTxHash)} t={t}/></span>:<span style={{color:t.muted,fontSize:10}}>—</span>}</Td>
              <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{a.blockNumber||"—"}</span></Td>
              <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(a.timestamp)}</span></Td>
              <td style={{padding:"10px 12px",borderBottom:`1px solid ${t.border}`}}><button onClick={()=>setExpanded(expanded===a.id?null:a.id)} style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:4,cursor:"pointer",background:t.accentBg,color:t.accent,border:`1px solid ${t.border}`}}>{expanded===a.id?"▲":"▼"}</button></td>
            </tr>
            {expanded===a.id&&(<tr key={`${a.id}-exp`} style={{background:t.accentBg}}><td colSpan={11} style={{padding:"12px 16px",borderBottom:`1px solid ${t.border}`}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))",gap:12,fontFamily:"monospace",fontSize:11}}>
                {a.type==="whale"&&<><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>TX Hash</span><div style={{marginTop:4}}><ExLink href={txUrl(a.txHash)} label={a.txHash||"—"} t={t}/></div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>From</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.from)} label={a.from} t={t}/></div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>To</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.to)} label={a.to} t={t}/></div></div><div><span style={{color:t.accent,fontSize:9,textTransform:"uppercase"}}>Amount</span><div style={{color:t.accent,fontWeight:700,marginTop:4}}>{num(a.amount).toLocaleString()} <span style={{color:t.muted}}>{a.token}</span>{usd&&<span style={{color:"#4ade80",marginLeft:8}}>{usd}</span>}</div></div></>}
                {(a.type==="momentum"||a.type==="alert"||a.type==="reaction")&&<><div style={{gridColumn:"1/-1",background:`rgba(${a.type==="momentum"?"239,68,68":a.type==="alert"?"249,115,22":"168,85,247"},0.08)`,border:`1px solid rgba(${a.type==="momentum"?"239,68,68":a.type==="alert"?"249,115,22":"168,85,247"},0.25)`,borderRadius:8,padding:"10px 14px"}}><div style={{color:t.muted,fontSize:9,textTransform:"uppercase",marginBottom:6}}>{a.type==="momentum"?"🔥 Why This Momentum":a.type==="alert"?"🚨 Why This Alert":"⚡ Why This Reaction"}</div><div style={{color:t.text,fontSize:11,lineHeight:1.6}}>{a.signalReason||"On-chain signal — see linked transaction for context."}</div></div>{a.linkedTxHash&&<div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Linked Whale TX</span><div style={{marginTop:4}}><ExLink href={txUrl(a.linkedTxHash)} label={shortHash(a.linkedTxHash)} t={t}/></div></div>}{a.txHash&&<div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Signal TX Hash</span><div style={{marginTop:4}}><ExLink href={txUrl(a.txHash)} label={shortHash(a.txHash)} t={t}/></div></div>}{a.type==="reaction"&&a.handlerEmitter&&<div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Handler Emitter</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.handlerEmitter)} label={short(a.handlerEmitter)} t={t}/></div></div>}</>}
                <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Block</span><div style={{color:t.text,marginTop:4}}>{a.blockNumber||"—"}</div></div>
                <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Timestamp</span><div style={{color:t.text,marginTop:4}}>{fmtTime(a.timestamp)}</div></div>
              </div>
            </td></tr>)}
          </>);
        })}</tbody>
      </table></div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 4px",borderTop:`1px solid ${t.border}`}}>
        <span style={{color:t.muted,fontSize:10,fontFamily:"monospace"}}>{alerts.length} events · page {page+1} of {totalPages}</span>
        <div style={{display:"flex",gap:6}}>
          {[{label:"«",disabled:page===0,action:()=>setPage(0)},{label:"‹ Prev",disabled:page===0,action:()=>setPage(p=>Math.max(0,p-1))},{label:"Next ›",disabled:page>=totalPages-1,action:()=>setPage(p=>Math.min(totalPages-1,p+1))},{label:"»",disabled:page>=totalPages-1,action:()=>setPage(totalPages-1)}].map(({label,disabled,action})=>(
            <button key={label} onClick={action} disabled={disabled} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:disabled?"not-allowed":"pointer",background:t.accentBg,color:disabled?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:disabled?0.4:1}}>{label}</button>
          ))}
        </div>
      </div></>}
    </>)}
    {feedSubTab==="network-activity"&&(<>
      <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:12,marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))",gap:8}}>
          <div><label style={{color:t.subtext,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.1em",display:"block",marginBottom:4}}>Min Amount (STT)</label><input type="number" value={netMinAmt} onChange={e=>setNetMinAmt(e.target.value)} placeholder="0" style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"}}/></div>
          <div><label style={{color:t.subtext,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.1em",display:"block",marginBottom:4}}>Max Amount (STT)</label><input type="number" value={netMaxAmt} onChange={e=>setNetMaxAmt(e.target.value)} placeholder="∞" style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"}}/></div>
          <div style={{display:"flex",alignItems:"flex-end"}}><button onClick={()=>{setNetMinAmt("");setNetMaxAmt("");}} style={{fontSize:9,fontFamily:"monospace",padding:"6px 12px",borderRadius:6,cursor:"pointer",color:t.errText,background:"transparent",border:"1px solid transparent"}}>✕ Clear</button></div>
        </div>
      </div>
      {netLoading&&netData.rows.length===0?<div style={{padding:"24px",textAlign:"center",color:t.muted,fontSize:11,fontFamily:"monospace"}}>Loading...</div>
      :netData.total===0?<div style={{padding:"24px",textAlign:"center",color:t.muted,fontSize:11,fontFamily:"monospace"}}>Waiting for block activity...</div>
      :<><div style={{overflowX:"auto",opacity:netLoading?0.6:1,transition:"opacity 0.2s"}}>
        <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",minWidth:820}}>
          <colgroup><col style={{width:"14%"}}/><col style={{width:"14%"}}/><col style={{width:"13%"}}/><col style={{width:"13%"}}/><col style={{width:"20%"}}/><col style={{width:"12%"}}/><col style={{width:"14%"}}/></colgroup>
          <thead><tr>
            <SortTh t={t} active={netSort.col==="from"}   dir={netSort.dir} onClick={()=>toggleNetSort("from")}>From</SortTh>
            <SortTh t={t} active={netSort.col==="to"}     dir={netSort.dir} onClick={()=>toggleNetSort("to")}>To</SortTh>
            <SortTh t={t} active={netSort.col==="amount"} dir={netSort.dir} onClick={()=>toggleNetSort("amount")}>Amount (STT)</SortTh>
            <SortTh t={t} active={netSort.col==="fee"}    dir={netSort.dir} onClick={()=>toggleNetSort("fee")}>Tx Fee (STT)</SortTh>
            <Th t={t}>TX Hash</Th>
            <SortTh t={t} active={netSort.col==="block"}  dir={netSort.dir} onClick={()=>toggleNetSort("block")}>Block</SortTh>
            <SortTh t={t} active={netSort.col==="time"}   dir={netSort.dir} onClick={()=>toggleNetSort("time")}>Time</SortTh>
          </tr></thead>
          <tbody>{netData.rows.map((tx,i)=>(
            <tr key={tx.id} style={{background:i%2===0?t.tableRow:t.tableAlt}}>
              <Td t={t}><ExLink href={addrUrl(tx.from)} label={short(tx.from)} t={t}/></Td>
              <Td t={t}><ExLink href={addrUrl(tx.to)}   label={short(tx.to)}   t={t}/></Td>
              <Td t={t} accent bold>{tx.isTransfer?`${tx.amountRaw.toFixed(8)} STT`:<span style={{color:t.muted,fontSize:10}}>0.00000000 STT</span>}</Td>
              <Td t={t}><span style={{color:tx.txFee?.startsWith("~")?t.muted:"#f59e0b",fontSize:10,fontFamily:"monospace"}}>{tx.txFee&&parseFloat(tx.txFee.replace("~",""))>0?(tx.txFee.startsWith("~")?"~":"")+parseFloat(tx.txFee.replace("~","")).toFixed(8)+" STT":"—"}</span></Td>
              <Td t={t}><ExLink href={txUrl(tx.txHash)} label={shortHash(tx.txHash)} t={t}/></Td>
              <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{tx.blockNumber}</span></Td>
              <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(tx.timestamp)}</span></Td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 4px",borderTop:`1px solid ${t.border}`}}>
        <span style={{color:t.muted,fontSize:10,fontFamily:"monospace"}}>{netData.total.toLocaleString()} total · {netData.sttCount.toLocaleString()} STT transfers · page {netPage+1} of {netData.pages}</span>
        <div style={{display:"flex",gap:6}}>
          {[{label:"«",disabled:netPage===0||netLoading,action:()=>setNetPage(0)},{label:"‹ Prev",disabled:netPage===0||netLoading,action:()=>setNetPage(p=>Math.max(0,p-1))},{label:"Next ›",disabled:netPage>=netData.pages-1||netLoading,action:()=>setNetPage(p=>Math.min(netData.pages-1,p+1))},{label:"»",disabled:netPage>=netData.pages-1||netLoading,action:()=>setNetPage(netData.pages-1)}].map(({label,disabled,action})=>(
            <button key={label} onClick={action} disabled={disabled} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:disabled?"not-allowed":"pointer",background:t.accentBg,color:disabled?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:disabled?0.4:1}}>{label}</button>
          ))}
        </div>
      </div></>}
    </>)}
  </div>);
}

// ── My Wallet Tab ─────────────────────────────────────────────────────────────
function MyWalletTab({alerts,connectedAddr,t}:{alerts:WhaleAlert[];connectedAddr:string;t:typeof T.dark}){
  const myTxns=useMemo(()=>alerts.filter(a=>a.type==="whale"&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase())),[alerts,connectedAddr]);
  const myVolume=useMemo(()=>myTxns.reduce((s,a)=>s+num(a.amount),0),[myTxns]);
  const mySent=useMemo(()=>myTxns.filter(a=>a.from.toLowerCase()===connectedAddr.toLowerCase()),[myTxns,connectedAddr]);
  const myReceived=useMemo(()=>myTxns.filter(a=>a.to.toLowerCase()===connectedAddr.toLowerCase()),[myTxns,connectedAddr]);
  const sentVol=useMemo(()=>mySent.reduce((s,a)=>s+num(a.amount),0),[mySent]);
  const recvVol=useMemo(()=>myReceived.reduce((s,a)=>s+num(a.amount),0),[myReceived]);
  const netFlow=recvVol-sentVol;
  return(<div style={{padding:24}}>
    <div style={{marginBottom:20,padding:"12px 16px",borderRadius:10,background:t.accentBg,border:`1px solid ${t.border}`,display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:20}}>💛</span>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",margin:0}}>Connected Wallet</p><p style={{color:t.accent,fontFamily:"monospace",fontSize:12,fontWeight:700,margin:0}}>{connectedAddr}</p></div>
      <a href={addrUrl(connectedAddr)} target="_blank" rel="noreferrer" style={{marginLeft:"auto",fontSize:10,color:t.accent,fontFamily:"monospace",textDecoration:"none"}}>View on Explorer ↗</a>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:10,marginBottom:24}}>
      <KpiCard t={t} label="My Transfers" value={myTxns.length}/>
      <KpiCard t={t} label="My Volume" value={Math.round(myVolume).toLocaleString()} sub="tokens"/>
      <KpiCard t={t} label="Net Flow" value={(netFlow>=0?"+":"")+Math.round(netFlow).toLocaleString()} color={netFlow>=0?"#4ade80":"#f87171"} sub={netFlow>=0?"net inflow":"net outflow"}/>
      <KpiCard t={t} label="Sent / Received" value={`${mySent.length} / ${myReceived.length}`} sub="transactions"/>
    </div>
    {!myTxns.length?<div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>No whale transactions for this wallet.</div>
    :<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
      <thead><tr>{["Direction","Token","Amount","Counterparty","TX Hash","Block","Time"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
      <tbody>{myTxns.map((a,i)=>{
        const isSender=a.from.toLowerCase()===connectedAddr.toLowerCase();
        const counterparty=isSender?a.to:a.from;
        return(<tr key={a.id} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}>
          <Td t={t}><span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:isSender?"rgba(248,113,113,0.15)":"rgba(74,222,128,0.15)",color:isSender?"#f87171":"#4ade80",border:`1px solid ${isSender?"rgba(248,113,113,0.3)":"rgba(74,222,128,0.3)"}`}}>{isSender?"→ SENT":"← RECV"}</span></Td>
          <Td t={t}>{a.token?<Badge text={a.token} color={TOKEN_COLORS[a.token]} t={t}/>:<span style={{color:t.muted}}>—</span>}</Td>
          <Td t={t} accent bold>{num(a.amount).toLocaleString()}</Td>
          <Td t={t}><ExLink href={addrUrl(counterparty)} label={short(counterparty)} t={t}/></Td>
          <Td t={t}><ExLink href={txUrl(a.txHash)} label={shortHash(a.txHash)} t={t}/></Td>
          <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{a.blockNumber||"—"}</span></Td>
          <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(a.timestamp)}</span></Td>
        </tr>);
      })}</tbody>
    </table></div>}
  </div>);
}

//// ── Analytics Tab ─────────────────────────────────────────────────────────────
function AnalyticsTab({alerts,t,oraclePrices,shockData,metrics}:{alerts:WhaleAlert[];t:typeof T.dark;oraclePrices:Record<string,OraclePrice>;shockData:import("../lib/useWhaleAlerts").ShockDataPoint[];metrics:LiveMetrics;}){
  const whales=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const alertEvents=useMemo(()=>alerts.filter(a=>a.type==="alert"),[alerts]);
  const totalVol=useMemo(()=>whales.reduce((s,a)=>s+num(a.amount),0),[whales]);
  const uniqueWallets=useMemo(()=>new Set([...whales.map(a=>a.from),...whales.map(a=>a.to)]).size,[whales]);
  const avgWhaleSize=whales.length>0?totalVol/whales.length:0;
  const activityRate=useMemo(()=>{const c=Date.now()-60*60_000;return whales.filter(a=>a.timestamp>c&&a.blockNumber!=="simulated").length;},[whales]);
  const whaleVelocityLocal=useMemo(()=>{const c=Date.now()-5*60_000;return parseFloat((whales.filter(a=>a.timestamp>c&&a.blockNumber!=="simulated").length/5).toFixed(2));},[whales]);
  const momentum=useMemo(()=>{const now=Date.now(),half=30*60_000;const rv=whales.filter(a=>now-a.timestamp<half).reduce((s,a)=>s+num(a.amount),0);const pv=whales.filter(a=>{const age=now-a.timestamp;return age>=half&&age<half*2;}).reduce((s,a)=>s+num(a.amount),0);if(pv===0&&rv===0)return{label:"➡️ Neutral",color:t.muted,pct:0};if(pv===0)return{label:"🚀 Bullish",color:"#4ade80",pct:100};const pct=((rv-pv)/pv)*100;if(pct>10)return{label:"🚀 Bullish",color:"#4ade80",pct};if(pct<-10)return{label:"📉 Bearish",color:"#f87171",pct};return{label:"➡️ Neutral",color:t.muted,pct};},[whales,t.muted]);
  const concentration=useMemo(()=>{const sentVol:Record<string,number>={},recvVol:Record<string,number>={};whales.forEach(a=>{sentVol[a.from]=(sentVol[a.from]||0)+num(a.amount);recvVol[a.to]=(recvVol[a.to]||0)+num(a.amount);});const sorted=Object.values(sentVol).sort((a,b)=>b-a);const top5=sorted.slice(0,5).reduce((s,v)=>s+v,0);const top10=sorted.slice(0,10).reduce((s,v)=>s+v,0);return{top5pct:totalVol>0?Math.round((top5/totalVol)*100):0,top10pct:totalVol>0?Math.round((top10/totalVol)*100):0};},[whales,totalVol]);

  // Pressure comes from backend metrics — displayed as percentage for readability
  const pressure = metrics.whalePressure ?? 0;
  const pressurePercent = pressure * 100;
  const pressureColor = pressurePercent > 5 ? "#4ade80" : pressurePercent < -5 ? "#f87171" : t.muted;
  const pressureLabel = pressurePercent > 5 ? "Accumulation" : pressurePercent < -5 ? "Distribution" : "Balanced";
  const pressureDisplay = `${pressurePercent >= 0 ? "+" : ""}${pressurePercent.toFixed(1)}%`;

  const alertIntel=useMemo(()=>{if(alertEvents.length<2)return null;const sorted=[...alertEvents].sort((a,b)=>a.timestamp-b.timestamp);const gaps=sorted.slice(1).map((a,i)=>a.timestamp-sorted[i].timestamp);const avgGap=gaps.reduce((s,g)=>s+g,0)/gaps.length;const WINDOW=30_000;const vols=sorted.map(alert=>whales.filter(w=>Math.abs(w.timestamp-alert.timestamp)<WINDOW).reduce((s,a)=>s+num(a.amount),0));return{count:alertEvents.length,avgGap,avgAlertVol:vols.reduce((s,v)=>s+v,0)/vols.length,maxAlertVol:Math.max(...vols)};},[alertEvents,whales]);
  const netFlows=useMemo(()=>{const inflow:Record<string,number>={},outflow:Record<string,number>={};whales.forEach(a=>{inflow[a.to]=(inflow[a.to]||0)+num(a.amount);outflow[a.from]=(outflow[a.from]||0)+num(a.amount);});const wallets=new Set([...Object.keys(inflow),...Object.keys(outflow)]);return Array.from(wallets).map(w=>({wallet:w,net:(inflow[w]||0)-(outflow[w]||0),inflow:inflow[w]||0,outflow:outflow[w]||0})).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)).slice(0,10);},[whales]);
  const minuteData=useMemo(()=>{const b:Record<string,number>={};whales.forEach(a=>{const k=new Date(a.timestamp).toISOString().slice(0,16);b[k]=(b[k]||0)+num(a.amount);});return Object.entries(b).slice(-30).map(([time,volume])=>({time:time.slice(11),volume:Math.round(volume)}));},[whales]);
  const avgShock=shockData.length>0?Math.round(shockData.reduce((s,d)=>s+d.score,0)/shockData.length):0;
  const peakShock=shockData.length>0?Math.max(...shockData.map(d=>d.score)):0;
  const highImpactCount=shockData.filter(d=>d.score>=51).length;
  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};
  const secLabel=(text:string,color?:string):React.CSSProperties=>({color:color??t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase" as const,letterSpacing:"0.15em",marginBottom:14});
  
  return(
    <div style={{padding:24}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10,marginBottom:28}}>
        <KpiCard t={t} label="Unique Wallets" value={uniqueWallets}/>
        <KpiCard t={t} label="Avg Whale Size" value={Math.round(avgWhaleSize).toLocaleString()} sub="STT (whale txns only)"/>
        <KpiCard t={t} label="Median Whale Size" value={Math.round(metrics.medianWhaleSizeStt).toLocaleString()} sub="STT (Whale midpoint)" color={t.statVal}/>
        <KpiCard t={t} label="Activity (1h)" value={activityRate} sub={`${whaleVelocityLocal}/min velocity`}/>
        <KpiCard t={t} label="Market Momentum" value={momentum.label} color={momentum.color} sub={`${momentum.pct>=0?"+":""}${momentum.pct.toFixed(1)}% vs prev 30m`}/>
        <KpiCard t={t} label="Top 5 Concentration" value={`${concentration.top5pct}%`} color={concentration.top5pct>70?"#f97316":t.statVal} sub="of whale volume"/>
        <KpiCard t={t} label="Whale Pressure" value={pressureDisplay} color={pressureColor} sub={pressureLabel}/>
      </div>
      
      {/* Helper text for pressure */}
      <p style={{color:t.muted, fontSize:8, fontFamily:"monospace", margin:"-8px 0 12px", textAlign:"center"}}>
        Pressure = (Inflow - Outflow) / Total Volume · [-100% = max distribution, +100% = max accumulation]
      </p>
      
      <p style={secLabel("⚡ Network Impact Analysis","#06b6d4")}>⚡ Network Impact Analysis</p>
      {shockData.length===0?<div style={{padding:"20px 0 28px",color:t.muted,fontFamily:"monospace",fontSize:12}}>Accumulating data — network impact measured in 30s windows after each whale event.</div>:<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(130px, 1fr))",gap:10,marginBottom:20}}>
          {[{label:"Avg Shock Score",value:avgShock,color:avgShock>=51?"#f97316":avgShock>=21?"#f59e0b":t.statVal,sub:"0–100 composite"},{label:"Peak Shock",value:peakShock,color:peakShock>=81?"#ef4444":peakShock>=51?"#f97316":t.statVal,sub:"highest recorded"},{label:"High Impact",value:highImpactCount,color:highImpactCount>0?"#f97316":t.muted,sub:"score ≥ 51"},{label:"Events Measured",value:shockData.length,sub:"with network data"}].map(({label,value,color,sub})=>(<div key={label} style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 16px"}}><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.1em",margin:"0 0 4px"}}>{label}</p><p style={{color:color??t.statVal,fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>{sub&&<p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"2px 0 0"}}>{sub}</p>}</div>))}
        </div>
        <div style={{marginBottom:16}}><ResponsiveContainer width="100%" height={120}><BarChart data={shockData} barSize={14}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:8,fontFamily:"monospace"}} interval={Math.max(0,Math.floor(shockData.length/6)-1)}/><YAxis domain={[0,100]} tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt} formatter={(v:any,_:any,p:any)=>[`${v} (${p.payload.label}) — ${p.payload.txCount} txns, ${p.payload.uniqueWallets} wallets`,"Shock Score"]}/><Bar dataKey="score" radius={[3,3,0,0]}>{shockData.map((d,i)=><Cell key={i} fill={d.scoreColor}/>)}</Bar></BarChart></ResponsiveContainer></div>
        <div style={{overflowX:"auto",marginBottom:28}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["Time","Transfer","Score","Impact","Txns (30s)","Wallets (30s)","Follow-ups"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{[...shockData].reverse().slice(0,10).map((d,i)=>(<tr key={i} style={{background:i%2===0?t.tableRow:t.tableAlt}}><Td t={t}><span style={{color:t.muted,fontSize:10}}>{d.time}</span></Td><Td t={t} accent bold>{d.amount.toLocaleString()} {d.token}</Td><Td t={t}><div style={{display:"flex",alignItems:"center",gap:8}}><div style={{width:48,height:4,background:t.border,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${d.score}%`,background:d.scoreColor,borderRadius:2}}/></div><span style={{color:d.scoreColor,fontWeight:700,fontFamily:"monospace",fontSize:11}}>{d.score}</span></div></Td><Td t={t}><span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:`${d.scoreColor}22`,color:d.scoreColor,border:`1px solid ${d.scoreColor}44`}}>{d.label}</span></Td><Td t={t}>{d.txCount}</Td><Td t={t}>{d.uniqueWallets}</Td><Td t={t}><span style={{color:d.followups>0?"#f97316":t.muted}}>{d.followups}</span></Td></tr>))}</tbody></table></div>
        <div style={{display:"flex",gap:16,marginBottom:28,flexWrap:"wrap"}}>{[{label:"NORMAL",range:"0–20",color:t.muted},{label:"ELEVATED",range:"21–50",color:"#f59e0b"},{label:"HIGH",range:"51–80",color:"#f97316"},{label:"EXTREME",range:"81–100",color:"#ef4444"}].map(({label,range,color})=>(<div key={label} style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:color}}/><span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>{label} ({range})</span></div>))}<span style={{color:t.muted,fontSize:9,fontFamily:"monospace",marginLeft:"auto"}}>Score = txCount×2 + uniqueWallets×1.5 + followupWhales×10</span></div>
      </>}
      
      <p style={secLabel("Whale Concentration")}>Whale Concentration</p>
      <div style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:10,padding:16,marginBottom:28}}>
        {[{label:"Top 5 wallets (of whale vol)",pct:concentration.top5pct,color:concentration.top5pct>70?"#f97316":t.accent},{label:"Top 10 wallets (of whale vol)",pct:concentration.top10pct,color:concentration.top10pct>85?"#f97316":t.accent}].map(({label,pct,color})=>(<div key={label} style={{marginBottom:12}}><div style={{display:"flex",justifyContent:"space-between",fontFamily:"monospace",fontSize:10,color:t.subtext,marginBottom:4}}><span>{label}</span><span style={{color,fontWeight:700}}>{pct}% of volume</span></div><div style={{height:8,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${color},${color}88)`,borderRadius:4,transition:"width 0.6s ease"}}/></div></div>))}
        <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"8px 0 0"}}>{concentration.top5pct>70?"⚠️ High concentration — market may be whale-dominated":"✓ Moderate distribution across wallets"}</p>
      </div>
      
      <p style={secLabel("")}>Volume Momentum (per minute)</p>
      {!minuteData.length?<div style={{height:130,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12,marginBottom:28}}>No data yet</div>:<div style={{marginBottom:28}}><ResponsiveContainer width="100%" height={130}><AreaChart data={minuteData}><defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={4}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#mg)"/></AreaChart></ResponsiveContainer></div>}
      
      {alertIntel && (<>
        <p style={{...secLabel("","#f97316")}}>🚨 Alert Intelligence</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))",gap:10,marginBottom:28}}>
          {[{label:"Total Alerts",value:alertIntel.count},{label:"Avg Gap Between Alerts",value:fmtMs(alertIntel.avgGap),sub:"time between alerts"},{label:"Avg Vol During Alert",value:Math.round(alertIntel.avgAlertVol).toLocaleString(),sub:"tokens (±30s window)"},{label:"Peak Alert Volume",value:Math.round(alertIntel.maxAlertVol).toLocaleString()}].map(({label,value,sub}:any)=>(<div key={label} style={{background:t.pageBg,border:"1px solid rgba(249,115,22,0.3)",borderRadius:10,padding:"12px 16px"}}><p style={{color:"rgba(249,115,22,0.6)",fontSize:9,fontFamily:"monospace",textTransform:"uppercase",margin:"0 0 4px"}}>{label}</p><p style={{color:"#f97316",fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>{sub&&<p style={{color:"rgba(249,115,22,0.5)",fontSize:9,fontFamily:"monospace",margin:"2px 0 0"}}>{sub}</p>}</div>))}
        </div>
      </>)}
      
      <p style={secLabel("")}>Net Flow per Wallet (inflow − outflow)</p>
      {!netFlows.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</p>:<table style={{width:"100%",borderCollapse:"collapse"}}><thead> <tr>{["#","Wallet","Inflow","Outflow","Net Flow","Direction"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr> </thead><tbody>{netFlows.map((row,i)=>{const isAccum=row.net>=0;return(<tr key={row.wallet} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(row.wallet)} label={short(row.wallet)} t={t}/></Td><Td t={t}>{Math.round(row.inflow).toLocaleString()}</Td><Td t={t}>{Math.round(row.outflow).toLocaleString()}</Td><Td t={t} bold color={isAccum?"#4ade80":"#f87171"}>{(isAccum?"+":"")+Math.round(row.net).toLocaleString()}</Td><Td t={t}><span style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:4,background:isAccum?"rgba(74,222,128,0.15)":"rgba(248,113,113,0.15)",color:isAccum?"#4ade80":"#f87171",border:`1px solid ${isAccum?"rgba(74,222,128,0.3)":"rgba(248,113,113,0.3)"}`}}>{isAccum?"ACCUMULATING":"DISTRIBUTING"}</span></Td> </tr>);})}</tbody> </table>}
      
      {Object.keys(oraclePrices).length>0&&(<>
        <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",margin:"28px 0 14px"}}>🔮 Live Oracle Prices (Somnia Testnet)</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:10,marginBottom:12}}>
          {Object.values(oraclePrices).map(p=>{const color=SYMBOL_COLORS[p.symbol]??t.accent;return(<div key={p.symbol} style={{background:t.pageBg,border:`1px solid ${p.stale?"rgba(249,115,22,0.3)":color+"33"}`,borderRadius:10,padding:"12px 14px"}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}><span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color,padding:"1px 6px",borderRadius:3,background:`${color}18`}}>{p.symbol}/USD</span>{p.stale&&<span style={{fontSize:8,color:"#f97316",fontFamily:"monospace"}}>STALE</span>}</div><p style={{color:p.stale?t.muted:t.text,fontSize:16,fontWeight:700,fontFamily:"monospace",margin:0}}>{formatUsd(p.price)}</p><p style={{color:t.muted,fontSize:8,fontFamily:"monospace",margin:"4px 0 0"}}>{p.source} · {new Date(p.updatedAt).toLocaleTimeString()}</p></div>);})}
        </div>
        <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"4px 0 0"}}>Powered by Protofire (ETH/BTC/USDC) and DIA (WETH/USDT/SOL/SOMI) oracles deployed on Somnia. STT/USD feed not yet available — native STT transfers show token amounts only.</p>
      </>)}
    </div>
  );
}

// ── Charts Tab ────────────────────────────────────────────────────────────────
function ChartsTab({alerts,t}:{alerts:WhaleAlert[];t:typeof T.dark}){
  const whaleOnly=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const volData=useMemo(()=>{const b:Record<string,number>={};whaleOnly.forEach(a=>{const k=new Date(a.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});b[k]=(b[k]||0)+num(a.amount);});return Object.entries(b).slice(-30).map(([time,volume])=>({time,volume:Math.round(volume)}));},[whaleOnly]);
  const heatData=useMemo(()=>{const h=Array.from({length:24},(_,i)=>({hour:`${i}h`,count:0}));whaleOnly.forEach(a=>{h[new Date(a.timestamp).getHours()].count++;});return h;},[whaleOnly]);
  const reactionData=useMemo(()=>{const b:Record<string,number>={};alerts.filter(a=>a.type==="reaction").forEach(a=>{const k=new Date(a.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});b[k]=(b[k]||0)+1;});return Object.entries(b).slice(-30).map(([time,count])=>({time,count}));},[alerts]);
  const typeBreakdown=useMemo(()=>{const counts:Record<string,number>={whale:0,reaction:0,alert:0,momentum:0};alerts.forEach(a=>{if(counts[a.type]!==undefined)counts[a.type]++;});return Object.entries(counts).map(([type,count])=>({type,count})).filter(d=>d.count>0);},[alerts]);
  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};
  const typeColors:Record<string,string>={whale:"#06b6d4",reaction:"#a855f7",alert:"#f97316",momentum:"#ef4444"};
  const lbl=(text:string,color?:string)=><p style={{color:color??t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase" as const,letterSpacing:"0.15em",margin:"0 0 10px"}}>{text}</p>;
  return(<div style={{padding:20}}>
    <div style={{marginBottom:20}}>{lbl("🐋 Whale Transfer Volume Over Time")}{!volData.length?<div style={{height:140,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</div>:<ResponsiveContainer width="100%" height={140}><AreaChart data={volData}><defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={4}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#vg)"/></AreaChart></ResponsiveContainer>}</div>
    <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16,marginBottom:20}}>
      <div>{lbl("📅 Activity Heatmap by Hour")}<ResponsiveContainer width="100%" height={130}><BarChart data={heatData} barSize={8}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false}/><XAxis dataKey="hour" tick={{fill:t.chartAxis,fontSize:8,fontFamily:"monospace"}} interval={2}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Bar dataKey="count" radius={[3,3,0,0]}>{heatData.map((d,i)=><Cell key={i} fill={d.count>0?t.accent:t.border}/>)}</Bar></BarChart></ResponsiveContainer></div>
      <div>{lbl("📊 Event Type Breakdown")}{!typeBreakdown.length?<div style={{height:130,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontSize:11,fontFamily:"monospace"}}>No data</div>:<ResponsiveContainer width="100%" height={130}><BarChart data={typeBreakdown} layout="vertical" barSize={14}><XAxis type="number" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><YAxis type="category" dataKey="type" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} width={56}/><Tooltip {...tt}/><Bar dataKey="count" radius={[0,4,4,0]}>{typeBreakdown.map(d=><Cell key={d.type} fill={typeColors[d.type]??t.accent}/>)}</Bar></BarChart></ResponsiveContainer>}</div>
    </div>
    {reactionData.length>0&&<div>{lbl("⚡ Handler Reactions Over Time","#a855f7")}<ResponsiveContainer width="100%" height={120}><AreaChart data={reactionData}><defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#a855f7" stopOpacity={0.3}/><stop offset="95%" stopColor="#a855f7" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={4}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="count" stroke="#a855f7" strokeWidth={2} fill="url(#rg)"/></AreaChart></ResponsiveContainer></div>}
  </div>);
}

// ── Token Flow Tab ────────────────────────────────────────────────────────────
function TokenFlowTab({alerts,t}:{alerts:WhaleAlert[];t:typeof T.dark}){
  const[period,setPeriod]=useState(0);
  const whaleOnly=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const inPeriod=useMemo(()=>period===0?whaleOnly:whaleOnly.filter(a=>Date.now()-a.timestamp<=period),[whaleOnly,period]);
  const tokenStats=useMemo(()=>{const map:Record<string,{count:number;volume:number;largest:number}>={};inPeriod.forEach(a=>{const v=num(a.amount);if(!map[a.token])map[a.token]={count:0,volume:0,largest:0};map[a.token].count++;map[a.token].volume+=v;if(v>map[a.token].largest)map[a.token].largest=v;});return Object.entries(map).sort((a,b)=>b[1].volume-a[1].volume).slice(0,10).map(([symbol,s])=>({symbol,...s}));},[inPeriod]);
  const pairFlows=useMemo(()=>{const map:Record<string,number>={};inPeriod.forEach(a=>{const k=`${short(a.from)} → ${short(a.to)}`;map[k]=(map[k]||0)+num(a.amount);});return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([pair,volume])=>({pair,volume:Math.round(volume)}));},[inPeriod]);
  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};
  return(<div style={{padding:24}}>
    <div style={{display:"flex",gap:6,marginBottom:24,alignItems:"center"}}><span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>PERIOD:</span>{TIME_PRESETS.map(p=>(<button key={p.label} onClick={()=>setPeriod(p.ms)} style={{fontSize:10,fontFamily:"monospace",padding:"4px 10px",borderRadius:6,cursor:"pointer",background:period===p.ms?t.accentBg:"transparent",color:period===p.ms?t.accent:t.muted,border:`1px solid ${period===p.ms?t.accent:"transparent"}`}}>{p.label}</button>))}</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24,marginBottom:32}}>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:12}}>Top 10 Tokens by Volume</p>{!tokenStats.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</p>:<table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:11}}><thead><tr>{["#","Token","Volume","Txns","Largest"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{tokenStats.map((row,i)=>(<tr key={row.symbol} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><Badge text={row.symbol} color={TOKEN_COLORS[row.symbol]} t={t}/></Td><Td t={t} bold>{Math.round(row.volume).toLocaleString()}</Td><Td t={t}>{row.count}</Td><Td t={t}>{Math.round(row.largest).toLocaleString()}</Td></tr>))}</tbody></table>}</div>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:12}}>Volume by Token</p>{!tokenStats.length?<div style={{height:240,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontSize:12,fontFamily:"monospace"}}>No data</div>:<ResponsiveContainer width="100%" height={240}><BarChart data={tokenStats} layout="vertical" barSize={14}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} horizontal={false}/><XAxis type="number" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><YAxis type="category" dataKey="symbol" tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}} width={42}/><Tooltip {...tt} formatter={(v:any)=>[Math.round(v).toLocaleString(),"Volume"]}/><Bar dataKey="volume" radius={[0,4,4,0]}>{tokenStats.map(row=><Cell key={row.symbol} fill={TOKEN_COLORS[row.symbol]??t.accent}/>)}</Bar></BarChart></ResponsiveContainer>}</div>
    </div>
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:16}}>Top 10 Address Pair Flows</p>
    {!pairFlows.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No pair data</p>:pairFlows.map((row,i)=>(<div key={row.pair} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{color:t.muted,fontFamily:"monospace",fontSize:10,width:16}}>{i+1}</span><span style={{color:t.subtext,fontFamily:"monospace",fontSize:11,width:150,flexShrink:0}}>{row.pair}</span><div style={{flex:1,height:6,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(row.volume/pairFlows[0].volume)*100}%`,background:`linear-gradient(90deg,${t.accent},#22d3ee)`,borderRadius:4}}/></div><span style={{color:t.text,fontFamily:"monospace",fontSize:11,width:90,textAlign:"right"}}>{row.volume.toLocaleString()}</span></div>))}
  </div>);
}

// ── Leaderboard Tab ───────────────────────────────────────────────────────────
function LeaderboardTab({alerts,t,persistedEntries,timePreset}:{alerts:WhaleAlert[];t:typeof T.dark;persistedEntries:{wallet:string;totalVolume:string;txCount:number;lastSeen:number;}[];timePreset:number;}){
  const[mode,setMode]=useState<"senders"|"receivers"|"intelligence">("intelligence");
  const[source,setSource]=useState<"live"|"persistent">("live");
  const whaleOnly=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const walletProfiles=useMemo(()=>{const map:Record<string,{inVol:number;outVol:number;txCount:number;firstSeen:number;lastSeen:number;burstCount:number;tokens:Set<string>;}>={}; const now=Date.now();const wc=timePreset>0?now-timePreset:0;whaleOnly.forEach(a=>{const v=num(a.amount),ts=a.timestamp;if(wc>0&&ts<wc)return;if(!map[a.from])map[a.from]={inVol:0,outVol:0,txCount:0,firstSeen:ts,lastSeen:ts,burstCount:0,tokens:new Set()};map[a.from].outVol+=v;map[a.from].txCount+=1;map[a.from].firstSeen=Math.min(map[a.from].firstSeen,ts);map[a.from].lastSeen=Math.max(map[a.from].lastSeen,ts);if(a.token)map[a.from].tokens.add(a.token);if(!map[a.to])map[a.to]={inVol:0,outVol:0,txCount:0,firstSeen:ts,lastSeen:ts,burstCount:0,tokens:new Set()};map[a.to].inVol+=v;map[a.to].txCount+=1;map[a.to].firstSeen=Math.min(map[a.to].firstSeen,ts);map[a.to].lastSeen=Math.max(map[a.to].lastSeen,ts);if(a.token)map[a.to].tokens.add(a.token);});const BW=60_000;const ww=whaleOnly.filter(w=>wc===0||w.timestamp>=wc).sort((a,b)=>a.timestamp-b.timestamp);let left=0;for(let right=0;right<ww.length;right++){while(ww[right].timestamp-ww[left].timestamp>=BW)left++;if(right-left+1>=3){const w=ww[right];if(map[w.from])map[w.from].burstCount++;if(map[w.to])map[w.to].burstCount++;}}return Object.entries(map).map(([address,d])=>{const tv=d.inVol+d.outVol;const is=Math.min(100,Math.round((tv>0?Math.log10(tv+1)*10:0)+d.burstCount*2+(d.txCount>0?Math.log10(d.txCount+1)*5:0)));const ratio=d.outVol>0?d.inVol/d.outVol:d.inVol>0?999:1;let bt:string,bc:string;if(d.burstCount>=6){bt="MARKET MOVER";bc="#ef4444";}else if(ratio>=1.2){bt="ACCUMULATOR";bc="#4ade80";}else{bt="DISTRIBUTOR";bc="#f87171";}return{address,totalVol:tv,inVol:d.inVol,outVol:d.outVol,txCount:d.txCount,firstSeen:d.firstSeen,lastSeen:d.lastSeen,burstCount:d.burstCount,tokens:Array.from(d.tokens),influenceScore:is,behaviorType:bt,behaviorColor:bc};}).filter(p=>p.totalVol>0).sort((a,b)=>b.influenceScore-a.influenceScore).slice(0,15);},[whaleOnly,timePreset]);
  const liveTop=useMemo(()=>{const map:Record<string,{count:number;volume:number;tokens:Set<string>}>={};whaleOnly.forEach(a=>{const k=mode==="senders"?a.from:a.to;if(!map[k])map[k]={count:0,volume:0,tokens:new Set()};map[k].count++;map[k].volume+=num(a.amount);map[k].tokens.add(a.token);});return Object.entries(map).sort((a,b)=>b[1].volume-a[1].volume).slice(0,10);},[whaleOnly,mode]);
  const maxVol=liveTop[0]?.[1].volume||1;
  const BEHAVIOR_META:Record<string,{icon:string;desc:string}>={"MARKET MOVER":{icon:"🔥",desc:"6+ burst clusters — drives momentum events"},"ACCUMULATOR":{icon:"📥",desc:"Net inflow dominant — building position"},"DISTRIBUTOR":{icon:"📤",desc:"Net outflow dominant — exiting or distributing"}};
  return(<div style={{padding:24}}>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
      {([{key:"intelligence",label:"🧠 Intelligence"},{key:"senders",label:"Senders"},{key:"receivers",label:"Receivers"}] as const).map(({key,label})=>(<button key={key} onClick={()=>setMode(key)} style={{fontSize:11,fontFamily:"monospace",padding:"6px 16px",borderRadius:8,cursor:"pointer",background:mode===key?t.accentBg:"transparent",color:mode===key?t.accent:t.muted,border:`1px solid ${mode===key?t.accent:"transparent"}`}}>{label}</button>))}
      {mode!=="intelligence"&&(<div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}><span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>SOURCE:</span>{[{key:"live",label:"Live"},{key:"persistent",label:"💾 Streams"}].map(({key,label})=>(<button key={key} onClick={()=>setSource(key as "live"|"persistent")} style={{fontSize:10,fontFamily:"monospace",padding:"4px 10px",borderRadius:6,cursor:"pointer",background:source===key?t.accentBg:"transparent",color:source===key?t.accent:t.muted,border:`1px solid ${source===key?t.accent:"transparent"}`}}>{label}</button>))}</div>)}
    </div>
    {mode==="intelligence"&&(!walletProfiles.length?<div style={{padding:32,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No whale data yet — profiles build as transfers arrive.</div>:<><div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:20}}>{Object.entries(BEHAVIOR_META).map(([type,{icon,desc}])=>{const cm:Record<string,string>={"MARKET MOVER":"#ef4444","ACCUMULATOR":"#4ade80","DISTRIBUTOR":"#f87171"};const color=cm[type];return(<div key={type} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:6,background:`${color}11`,border:`1px solid ${color}33`}}><span style={{fontSize:13}}>{icon}</span><div><span style={{color,fontSize:9,fontFamily:"monospace",fontWeight:700}}>{type}</span><p style={{color:t.muted,fontSize:8,fontFamily:"monospace",margin:0}}>{desc}</p></div></div>);})}</div><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["#","Wallet","Influence","Behavior","Vol In","Vol Out","Txns","Bursts","Tokens","Last Active"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{walletProfiles.map((p,i)=>(<tr key={p.address} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(p.address)} label={short(p.address)} t={t}/></Td><Td t={t}><div style={{display:"flex",alignItems:"center",gap:7}}><div style={{width:50,height:5,background:t.border,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${p.influenceScore}%`,background:p.influenceScore>=81?"#ef4444":p.influenceScore>=61?"#f97316":p.influenceScore>=31?"#f59e0b":t.accent,borderRadius:3}}/></div><span style={{color:t.text,fontWeight:700,fontFamily:"monospace",fontSize:11}}>{p.influenceScore}</span></div></Td><Td t={t}><span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:`${p.behaviorColor}18`,color:p.behaviorColor,border:`1px solid ${p.behaviorColor}33`,whiteSpace:"nowrap"}}>{BEHAVIOR_META[p.behaviorType]?.icon} {p.behaviorType}</span></Td><Td t={t}>{Math.round(p.inVol).toLocaleString()}</Td><Td t={t}>{Math.round(p.outVol).toLocaleString()}</Td><Td t={t}>{p.txCount}</Td><Td t={t}><span style={{color:p.burstCount>0?"#f97316":t.muted}}>{p.burstCount}</span></Td><Td t={t}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{p.tokens.map(tk=><Badge key={tk} text={tk} color={TOKEN_COLORS[tk]} t={t}/>)}</div></Td><Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(p.lastSeen)}</span></Td></tr>))}</tbody></table></div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"10px 0 0"}}>Influence = log₁₀(volume)×10 + burstParticipation×2 + log₁₀(txCount)×5 · capped at 100</p></>)}
    {(mode==="senders"||mode==="receivers")&&(source==="persistent"?persistedEntries.length===0?<div style={{padding:32,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No persistent data yet.</div>:<table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["#","Wallet","Total Volume","Txns","Last Seen"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{persistedEntries.slice(0,10).map(({wallet,totalVolume,txCount,lastSeen},i)=>(<tr key={wallet} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(wallet)} label={short(wallet)} t={t}/></Td><Td t={t} bold accent>{Number(totalVolume).toLocaleString()}</Td><Td t={t}>{txCount}</Td><Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(lastSeen)}</span></Td></tr>))}</tbody></table>:!liveTop.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:13,textAlign:"center",padding:32}}>No data</p>:<table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["#","Address","Volume","Txns","Tokens","Share"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{liveTop.map(([addr,{count,volume,tokens}],i)=>(<tr key={addr} style={{background:i%2===0?t.tableRow:t.tableAlt,transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(addr)} label={short(addr)} t={t}/></Td><Td t={t} bold accent>{Math.round(volume).toLocaleString()}</Td><Td t={t}>{count}</Td><Td t={t}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{Array.from(tokens).map(tk=><Badge key={tk} text={tk} color={TOKEN_COLORS[tk]} t={t}/>)}</div></Td><Td t={t}><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:60,height:4,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(volume/maxVol)*100}%`,background:t.accent}}/></div><span style={{color:t.muted,fontSize:10}}>{Math.round((volume/maxVol)*100)}%</span></div></Td></tr>))}</tbody></table>)}
  </div>);
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function WhaleDashboard(){
  const {
    alerts, blockTxs, blockTxTotal, totalBlockTxsSeen, connected, error,
    whaleThresholdSTT, whalePercentile,
    metrics: liveMetrics,
    shockData,
  } = useWhaleAlerts();
  const{address:walletAddr,isConnected}=useAccount();
  const{prices:oraclePrices,loading:pricesLoading,lastFetchedAt}=useOraclePrices(10_000);
  const[serverMetrics,setServerMetrics]=useState<LiveMetrics|null>(null);
  const[simulating,setSimulating]=useState(false);
  const[soundEnabled,setSoundEnabled]=useState(true);
  const[pulse,setPulse]=useState(false);
  const prevAlertsLen=useRef(0);
  const prevBlockTxsLen=useRef(0);

  useEffect(()=>{
    const na=alerts.length!==prevAlertsLen.current, nt=blockTxs.length!==prevBlockTxsLen.current;
    if(na||nt){setPulse(true);setTimeout(()=>setPulse(false),400);}
    prevAlertsLen.current=alerts.length; prevBlockTxsLen.current=blockTxs.length;
  },[alerts.length,blockTxs.length]);

  const latestBlock=blockTxs.length?blockTxs[0].blockNumber:null;
  const theme="dark" as const;
  const[tab,setTab]=useState<"feed"|"analytics"|"charts"|"leaderboard"|"flow"|"howto"|"mywallet">("feed");
  const[feedSubTab,setFeedSubTab]=useState<"alerts"|"network-activity">("alerts");
  const[filters,setFilters]=useState({search:"",minAmt:"",maxAmt:"",token:"All",timePreset:24*60*60_000,dateFrom:"",dateTo:"",showTypes:["whale","reaction","alert","momentum"] as string[],netMinAmt:"",netMaxAmt:""});
  useEffect(()=>{setFilters(f=>({...f,netMinAmt:"",netMaxAmt:""}));},[]);
  const setNetMinAmt=(v:string)=>setFilters(f=>({...f,netMinAmt:v}));
  const setNetMaxAmt=(v:string)=>setFilters(f=>({...f,netMaxAmt:v}));
  const{search,minAmt,maxAmt,token:tokenFilter,timePreset,dateFrom,dateTo,showTypes,netMinAmt,netMaxAmt}=filters;
  const setSearch    =(v:string)=>setFilters(f=>({...f,search:v}));
  const setMinAmt    =(v:string)=>setFilters(f=>({...f,minAmt:v}));
  const setMaxAmt    =(v:string)=>setFilters(f=>({...f,maxAmt:v}));
  const setTokenFilter=(v:string)=>setFilters(f=>({...f,token:v}));
  const setTimePreset=(v:number)=>setFilters(f=>({...f,timePreset:v}));
  const setShowTypes =(v:string[])=>setFilters(f=>({...f,showTypes:v}));
  const[persistedEntries,setPersistedEntries]=useState<any[]>([]);
  const t=T[theme];

  useEffect(()=>{fetch("/api/streams-leaderboard").then(r=>r.json()).then(d=>{if(d.entries?.length)setPersistedEntries(d.entries);}).catch(()=>{});},[]);

  const[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(id);},[]);

  const prevLen=useRef(0);
  useEffect(()=>{if(alerts.length>prevLen.current&&soundEnabled&&prevLen.current>0)playPing();prevLen.current=alerts.length;},[alerts.length,soundEnabled]);

  // ── Whale velocity data for sparkline (frontend only — uses local alert cache) ──
  const whaleVelocityData=useMemo(()=>{
    const cutoff=Date.now()-24*60*60_000;
    const whales24h=alerts.filter(a=>a.type==="whale"&&a.timestamp>cutoff&&a.blockNumber!=="simulated");
    if(!whales24h.length) return [];
    const hourlyData:Record<string,{count:number;volume:number}>={};
    for(let i=23;i>=0;i--){
      const hs=Date.now()-(i+1)*60*60_000, he=Date.now()-i*60*60_000;
      const hk=new Date(hs).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
      const hw=whales24h.filter(w=>w.timestamp>=hs&&w.timestamp<he);
      hourlyData[hk]={count:hw.length,volume:hw.reduce((s,w)=>s+num(w.amount),0)};
    }
    return Object.entries(hourlyData).map(([time,data])=>({time,velocity:data.count,volume:data.volume}));
  },[alerts]);

  // ── Filtered metrics — reads whalePressure from backend, no frontend recalc ──
  const filteredMetrics:LiveMetrics=useMemo(()=>{
    const isDefault=timePreset===24*60*60_000&&!minAmt&&!maxAmt&&tokenFilter==="All"&&!search;
    if(timePreset<24*60*60_000&&serverMetrics) return serverMetrics;
    const cutoff=isDefault?0:Date.now()-timePreset;
    const walletLow=search.toLowerCase();
    const minStt=minAmt?parseFloat(minAmt):undefined;
    const maxStt=maxAmt?parseFloat(maxAmt):undefined;
    const tokFilter=tokenFilter!=="All"?tokenFilter:undefined;
    let totalTx=0,sttTx=0,whaleTx=0,whaleVol=0,largestStt=0,whaleFees=0;
    let feeEst=false,alertCount=0,momCount=0,reactCount=0;
    const whaleSizes:number[]=[];
    for(const tx of blockTxs){
      if(cutoff>0&&tx.timestamp<cutoff) continue;
      if(walletLow&&tx.from.toLowerCase()!==walletLow&&tx.to.toLowerCase()!==walletLow) continue;
      if(minStt!=null&&tx.amountRaw<minStt) continue;
      if(maxStt!=null&&tx.amountRaw>maxStt) continue;
      totalTx++;
      if(tx.amountRaw>0) sttTx++;
    }
    for(const a of alerts){
      if(cutoff>0&&a.timestamp<cutoff) continue;
      if(walletLow&&a.from.toLowerCase()!==walletLow&&a.to.toLowerCase()!==walletLow) continue;
      if(tokFilter&&a.token!==tokFilter) continue;
      if(a.type==="whale"){
        if(a.blockNumber==="simulated") continue;
        const stt=Number(a.amountRaw)/1e18;
        if(minStt!=null&&stt<minStt) continue;
        if(maxStt!=null&&stt>maxStt) continue;
        whaleTx++;whaleVol+=stt;
        if(stt>largestStt)largestStt=stt;
        const fee=parseFloat((a.txFee??"0").replace("~",""));
        if(!isNaN(fee)&&fee>0){whaleFees+=fee;if(a.txFee?.startsWith("~"))feeEst=true;}
        whaleSizes.push(stt);
      } else if(a.type==="alert"){alertCount++;} else if(a.type==="momentum"){momCount++;} else if(a.type==="reaction"){reactCount++;}
    }
    const avg=whaleSizes.length>0?whaleSizes.reduce((s,v)=>s+v,0)/whaleSizes.length:0;
    const whaleTxRateRaw=sttTx>0?(whaleTx/sttTx)*100:0;
    const whaleTxRate=Math.min(100,Math.max(0,whaleTxRateRaw));
    if(isDefault){
      const finalRate=sttTx>=50?whaleTxRate:liveMetrics.whaleTxRate;
      return{
        ...liveMetrics,
        whaleTxRate:finalRate,whaleTxRateRaw:finalRate,
        whaleTx24h:whaleTx,whaleVolumeStt:whaleVol,avgWhaleSizeStt:avg,
        medianWhaleSizeStt:liveMetrics.medianWhaleSizeStt,largestWhaleStt:largestStt,
        whaleVelocity:liveMetrics.whaleVelocity,whaleFees,whaleFeeEstimated:feeEst,
        alerts24h:alertCount,momentum24h:momCount,reactions24h:reactCount,
        // whalePressure always from backend liveMetrics
        whalePressure:liveMetrics.whalePressure,
      };
    }
    return{
      totalTx24h:totalTx,sttTx24h:sttTx,whaleTx24h:whaleTx,whaleVolumeStt:whaleVol,
      avgWhaleSizeStt:avg,medianWhaleSizeStt:liveMetrics.medianWhaleSizeStt,
      largestWhaleStt:largestStt,whaleVelocity:liveMetrics.whaleVelocity,
      whaleFees,whaleFeeEstimated:feeEst,alerts24h:alertCount,momentum24h:momCount,
      reactions24h:reactCount,whaleTxRate,whaleTxRateRaw,
      // whalePressure always from backend liveMetrics (filtered pressure computed backend-side)
      whalePressure:serverMetrics?.whalePressure??liveMetrics.whalePressure,
      whaleThresholdStt:liveMetrics.whaleThresholdStt,whalePercentile:liveMetrics.whalePercentile,
      updatedAt:Date.now(),
    };
  },[alerts,blockTxs,timePreset,minAmt,maxAmt,tokenFilter,search,liveMetrics,serverMetrics]);

  // Fetch server metrics for filtered views
  useEffect(()=>{
    const isDefault=timePreset===24*60*60_000&&!minAmt&&!maxAmt&&tokenFilter==="All"&&!search;
    if(isDefault){setServerMetrics(null);return;}
    const fetchM=async()=>{
      const params=new URLSearchParams({window:String(timePreset),...(minAmt&&{min:minAmt}),...(maxAmt&&{max:maxAmt}),...(tokenFilter!=="All"&&{token:tokenFilter}),...(search&&{wallet:search})});
      try{const res=await fetch(`/api/metrics?${params}`);const data=await res.json();if(data.metrics)setServerMetrics(data.metrics);}catch{}
    };
    const id=setTimeout(fetchM,300);
    return()=>clearTimeout(id);
  },[timePreset,minAmt,maxAmt,tokenFilter,search]);

  const isDefaultFilter=timePreset===24*60*60_000&&!minAmt&&!maxAmt&&tokenFilter==="All"&&!search;
  const displayMetrics=filteredMetrics;

  // whalePressure is always read from displayMetrics (which gets it from backend)
  const whalePressure=displayMetrics.whalePressure??0;

  const whales=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const reactions=useMemo(()=>alerts.filter(a=>a.type==="reaction"),[alerts]);
  const windowCutoff=timePreset>0?now-timePreset:0;
  const windowedWhales=useMemo(()=>whales.filter(a=>!windowCutoff||a.timestamp>=windowCutoff),[whales,windowCutoff]);
  const windowedReactions=useMemo(()=>reactions.filter(a=>!windowCutoff||a.timestamp>=windowCutoff),[reactions,windowCutoff]);
  const windowedVol=displayMetrics.whaleVolumeStt;
  const whaleTotalFees=displayMetrics.whaleFees;
  const whaleFeeEstimated=displayMetrics.whaleFeeEstimated;
  const windowedAlertCount=displayMetrics.alerts24h;
  const windowedMomentumCount=displayMetrics.momentum24h;

  const windowedBlockTxs=useMemo(()=>!windowCutoff?blockTxs:blockTxs.filter(tx=>tx.timestamp>=windowCutoff),[blockTxs,windowCutoff]);
  const tokenList=useMemo(()=>{const seen=new Set<string>();whales.forEach(a=>{if(a.token)seen.add(a.token);});return["All",...Array.from(seen).sort()];},[whales]);

  const burst:Burst=useMemo(()=>{
    const WINDOW=60_000,MIN=3,now=Date.now();
    const recent=whales.filter(a=>now-a.timestamp<WINDOW);
    if(recent.length<MIN) return null;
    const vol=recent.reduce((s,a)=>s+num(a.amount),0);
    const oldest=Math.min(...recent.map(a=>a.timestamp));
    const tkCounts:Record<string,number>={};
    recent.forEach(a=>{tkCounts[a.token]=(tkCounts[a.token]||0)+1;});
    const dominantToken=Object.entries(tkCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]??"";
    return{count:recent.length,volume:vol,windowSec:Math.round((now-oldest)/1000),dominantToken,tokenBreakdown:tkCounts};
  },[whales]);

  const filtered=useMemo(()=>{
    const from=dateFrom?new Date(dateFrom).getTime():timePreset>0?now-timePreset:0;
    const to=dateTo?new Date(dateTo).getTime():null;
    return alerts.filter(a=>{
      if(!showTypes.includes(a.type)) return false;
      const tsMs=a.timestamp<10_000_000_000?a.timestamp*1000:a.timestamp;
      if(tsMs<from) return false;
      if(to!==null&&tsMs>to) return false;
      if(search&&!a.from.toLowerCase().includes(search.toLowerCase())&&!a.to.toLowerCase().includes(search.toLowerCase())) return false;
      if(tokenFilter!=="All"&&a.token!==tokenFilter&&a.type==="whale") return false;
      if(minAmt&&a.type==="whale"&&num(a.amount)<parseFloat(minAmt)) return false;
      if(maxAmt&&a.type==="whale"&&num(a.amount)>parseFloat(maxAmt)) return false;
      return true;
    });
  },[alerts,search,minAmt,maxAmt,tokenFilter,timePreset,dateFrom,dateTo,showTypes,now]);

  async function simulateWhale(){setSimulating(true);try{const res=await fetch("/api/simulate-whale",{method:"POST"});const d=await res.json();if(!d.success)throw new Error(d.error);}catch(e){alert("Simulation failed: "+e);}finally{setSimulating(false);}}
  const refreshData=()=>{clearFrontendCache();window.location.reload();};
  const allTabs=[{key:"feed",label:"⚡ Live Feed"},{key:"analytics",label:"📈 Analytics"},{key:"charts",label:"📊 Charts"},{key:"leaderboard",label:"🏆 Leaderboard"},{key:"flow",label:"🔀 Token Flow"},{key:"howto",label:"ℹ How It Works"},...(isConnected?[{key:"mywallet",label:"💛 My Wallet"}]:[])] as const;
  const btn:React.CSSProperties={fontSize:11,fontFamily:"monospace",padding:"7px 13px",borderRadius:8,cursor:"pointer",transition:"all 0.15s",fontWeight:600,whiteSpace:"nowrap"};

  return(
    <div style={{height:"100vh",display:"flex",flexDirection:"row",background:t.pageBg,color:t.text,overflow:"hidden"}}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes eventPulse{0%{transform:scale(1);opacity:1}40%{transform:scale(2.2);opacity:0.9}100%{transform:scale(1);opacity:1}}
        @keyframes burstPulse{0%,100%{box-shadow:0 0 0 0 rgba(249,115,22,0.15)}50%{box-shadow:0 0 0 10px rgba(249,115,22,0)}}
        @keyframes tickerScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
        input,select{color-scheme:dark}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:rgba(6,182,212,0.25);border-radius:3px}
      `}</style>

      {/* ── LEFT SIDEBAR ────────────────────────────────────────────────── */}
      <div style={{width:280,flexShrink:0,background:"linear-gradient(180deg,#0A1A2F 0%,#0D1E36 40%,#0F2340 100%)",borderRight:`1px solid ${t.border}`,display:"flex",flexDirection:"column",overflowY:"auto",overflowX:"hidden",boxShadow:"4px 0 20px rgba(0,0,0,0.3)"}}>
        <div style={{height:2,background:"linear-gradient(90deg,transparent,#06b6d4,transparent)",flexShrink:0}}/>
        {/* Logo */}
        <div style={{padding:"14px 16px 12px",borderBottom:`1px solid ${t.border}`,flexShrink:0}}>
          <div style={{width:"100%",display:"flex",justifyContent:"center",marginBottom:10}}>
            <img src="https://shannon-explorer.somnia.network/assets/configs/network_logo_dark.png" alt="Somnia Testnet" style={{maxWidth:"100%",maxHeight:40,width:"auto",height:"auto",objectFit:"contain",display:"block"}}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{flex:1,height:1,background:"linear-gradient(90deg,transparent,rgba(6,182,212,0.3))"}}/><span style={{fontSize:12,color:t.muted,fontFamily:"monospace",letterSpacing:"0.1em"}}>🐋 WHALE TRACKER</span><div style={{flex:1,height:1,background:"linear-gradient(90deg,rgba(6,182,212,0.3),transparent)"}}/>
          </div>
          <div style={{textAlign:"center",marginTop:4}}><span style={{fontSize:8,color:t.muted,fontFamily:"monospace",letterSpacing:"0.1em"}}>TESTNET 50312</span></div>
        </div>

        {/* Whale Pressure Gauge — reads directly from backend metrics */}
        <div style={{padding:"12px 10px 6px",borderBottom:`1px solid ${t.border}`,flexShrink:0}}>
          <div style={{fontSize:8,fontFamily:"monospace",color:t.accent,textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:4,textAlign:"center"}}>
            🐋 WHALE PRESSURE{!isDefaultFilter&&<span style={{color:t.accent,marginLeft:6,fontSize:7}}>● filtered</span>}
          </div>
          <WhalePressureGauge pressure={whalePressure} t={t}/>
          <div style={{textAlign:"center",marginTop:8,fontSize:8,fontFamily:"monospace",color:t.muted}}>
            {whalePressure>0.05?"🟢 Accumulation → Bullish":whalePressure<-0.05?"🔴 Distribution → Bearish":"⚪ Balanced Market"}
          </div>
          <div style={{textAlign:"center",marginTop:4,fontSize:7,fontFamily:"monospace",color:t.muted}}>
            {`${(whalePressure * 100).toFixed(1)}% net flow`}
          </div>
        </div>

        {/* Network Activity */}
        <div style={{padding:"12px 12px",borderBottom:`1px solid ${t.border}`,flexShrink:0}}>
          <div style={{fontSize:8,fontFamily:"monospace",color:t.accent,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12,display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:11}}>🌐</span> Network Activity</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            <div style={{textAlign:"center",padding:"4px 0"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,marginBottom:4}}><span style={{fontSize:9}}>📊</span><span style={{color:t.muted,fontSize:8,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.08em"}}>Total transactions</span></div>
              <div style={{color:t.statVal,fontSize:28,fontWeight:800,fontFamily:"'Courier New', monospace",lineHeight:1,letterSpacing:"-0.02em",textShadow:"0 0 20px rgba(103,232,249,0.3)"}}>{displayMetrics.totalTx24h.toLocaleString()}</div>
              <div style={{color:t.muted,fontSize:8,fontFamily:"monospace",marginTop:4}}>{isDefaultFilter?"24h total":`${timePreset<3600_000?`${Math.round(timePreset/60_000)}m`:timePreset<86400_000?`${Math.round(timePreset/3600_000)}h`:`${Math.ceil(timePreset/86400_000)}d`} window`}{(minAmt||maxAmt||tokenFilter!=="All"||search)&&<span style={{color:t.accent,fontSize:7,marginLeft:4}}>● filtered</span>}</div>
            </div>
            <div style={{textAlign:"center",padding:"4px 0",borderLeft:`1px solid ${t.border}`}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,marginBottom:4}}><span style={{fontSize:9}}>💸</span><span style={{color:t.muted,fontSize:8,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.08em"}}>STT TXN</span></div>
              <div style={{color:t.statVal,fontSize:28,fontWeight:800,fontFamily:"'Courier New', monospace",lineHeight:1,letterSpacing:"-0.02em",textShadow:"0 0 20px rgba(103,232,249,0.3)"}}>{displayMetrics.sttTx24h.toLocaleString()}</div>
              <div style={{color:t.muted,fontSize:8,fontFamily:"monospace",marginTop:4}}>{isDefaultFilter?"24h total":`${timePreset<3600_000?`${Math.round(timePreset/60_000)}m`:timePreset<86400_000?`${Math.round(timePreset/3600_000)}h`:`${Math.ceil(timePreset/86400_000)}d`} window`}{(minAmt||maxAmt||tokenFilter!=="All"||search)&&<span style={{color:t.accent,fontSize:7,marginLeft:4}}>● filtered</span>}</div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div style={{padding:"10px 12px",flex:1}}>
          <div style={{fontSize:8,fontFamily:"monospace",color:t.muted,textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:8}}>⚙ Filters{!isDefaultFilter&&<span style={{color:t.accent,marginLeft:6}}>● active</span>}</div>
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:3,letterSpacing:"0.08em"}}>WALLET</label><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="0x..." style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 8px",fontSize:10,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"}}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:3,letterSpacing:"0.08em"}}>TOKEN</label><select value={tokenFilter} onChange={e=>setTokenFilter(e.target.value)} style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 6px",fontSize:10,fontFamily:"monospace",color:t.text,outline:"none",width:"100%"}}>{tokenList.map(tk=><option key={tk}>{tk}</option>)}</select></div>
              <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:3,letterSpacing:"0.08em"}}>WINDOW</label><select value={timePreset} onChange={e=>setTimePreset(parseInt(e.target.value))} style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 6px",fontSize:10,fontFamily:"monospace",color:t.text,outline:"none",width:"100%"}}>{TIME_PRESETS.map(p=><option key={p.label} value={p.ms}>{p.label}</option>)}</select></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:3,letterSpacing:"0.08em"}}>MIN AMT</label><input type="number" value={minAmt} onChange={e=>setMinAmt(e.target.value)} placeholder="0" style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 8px",fontSize:10,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"}}/></div>
              <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:3,letterSpacing:"0.08em"}}>MAX AMT</label><input type="number" value={maxAmt} onChange={e=>setMaxAmt(e.target.value)} placeholder="∞" style={{background:t.input,border:`1px solid ${t.border}`,borderRadius:6,padding:"5px 8px",fontSize:10,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"}}/></div>
            </div>
            <div><label style={{color:t.subtext,fontSize:8,fontFamily:"monospace",display:"block",marginBottom:4,letterSpacing:"0.08em"}}>TYPE</label><div style={{display:"flex",gap:4}}>{[{key:"whale",label:"🐋",color:"#06b6d4"},{key:"reaction",label:"⚡",color:"#a855f7"},{key:"alert",label:"🚨",color:"#f97316"},{key:"momentum",label:"🔥",color:"#ef4444"}].map(({key,label,color})=>(<button key={key} onClick={()=>setShowTypes(showTypes.includes(key)?showTypes.filter(x=>x!==key):[...showTypes,key])} style={{flex:1,fontSize:13,padding:"4px 0",borderRadius:6,cursor:"pointer",background:showTypes.includes(key)?`${color}22`:"transparent",color:showTypes.includes(key)?color:t.muted,border:`1px solid ${showTypes.includes(key)?`${color}55`:t.border}`}}>{label}</button>))}</div></div>
            <button onClick={()=>{setSearch("");setMinAmt("");setMaxAmt("");setTokenFilter("All");setTimePreset(24*60*60_000);setShowTypes(["whale","reaction","alert","momentum"]);setNetMinAmt("");setNetMaxAmt("");}} style={{fontSize:9,padding:"5px",borderRadius:6,cursor:"pointer",color:t.errText,background:"rgba(248,113,113,0.05)",border:`1px solid rgba(248,113,113,0.2)`,fontFamily:"monospace",letterSpacing:"0.05em"}}>✕ Clear Filters</button>
          </div>
        </div>
        <div style={{height:2,background:"linear-gradient(90deg,transparent,#06b6d4,transparent)",flexShrink:0}}/>
      </div>

      {/* ── RIGHT MAIN ───────────────────────────────────────────────────── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        <div style={{background:t.headerBg,borderBottom:`1px solid ${t.border}`,backdropFilter:"blur(12px)",flexShrink:0,zIndex:10}}>
          <div style={{padding:"8px 14px"}}>
            {/* Top bar */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 8px",borderRadius:6,background:"rgba(6,182,212,0.08)",border:"1px solid rgba(6,182,212,0.15)"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:connected?"#4ade80":"#f87171",animation:pulse?"eventPulse 0.4s ease-out":connected?"pulse 2s infinite":"none",boxShadow:pulse?"0 0 8px #4ade80":"none"}}/>
                  <span style={{fontSize:9,fontFamily:"monospace",color:connected?t.accent:t.muted,fontWeight:pulse?700:400}}>{connected?"LIVE":"CONNECTING"}</span>
                  {latestBlock&&<span style={{fontSize:8,fontFamily:"monospace",color:t.muted,borderLeft:`1px solid ${t.border}`,paddingLeft:5,marginLeft:2}}>#{latestBlock} ~100ms</span>}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <ConnectButton showBalance={false} chainStatus="none" accountStatus="address"/>
                <button onClick={()=>{resumeAudio();setSoundEnabled(v=>!v);}} style={{...btn,background:soundEnabled?t.accentBg:"transparent",color:soundEnabled?t.accent:t.muted,border:`1px solid ${soundEnabled?t.accent:t.border}`}}>{soundEnabled?"🔊":"🔇"}</button>
                <button onClick={()=>downloadCSV(filtered)} disabled={filtered.length===0} style={{...btn,background:"transparent",color:t.muted,border:`1px solid ${t.border}`,opacity:filtered.length===0?0.4:1}}>↓ CSV</button>
                <button onClick={simulateWhale} disabled={simulating} style={{...btn,background:t.accentBg,color:t.accent,border:`1px solid ${t.accent}`,opacity:simulating?0.6:1}}>{simulating?"⏳":"⚡ SIM"}</button>
                <button onClick={refreshData} style={{...btn,background:"transparent",color:t.muted,border:`1px solid ${t.border}`}}>🔄 Refresh</button>
              </div>
            </div>

            {/* KPI row */}
            <div style={{marginBottom:8}}>
              <div style={{fontSize:7,fontFamily:"monospace",color:t.muted,textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:4,paddingLeft:1}}>🐋 Whale Activity</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))",gap:5}}>
                <KpiCard t={t} label="Whale Events" value={windowedWhales.length}/>
                <KpiCard t={t} label="Responses" value={windowedReactions.length}/>
                <KpiCard t={t} label="Alerts" value={windowedAlertCount}/>
                <KpiCard t={t} label="🔥 Momentum" value={windowedMomentumCount>0?windowedMomentumCount:burst?.count??0} color="#ef4444" sub={windowedMomentumCount>0?"on-chain bursts":burst?burst.count+" in "+burst.windowSec+"s · live":"on-chain bursts"}/>
                <KpiCard t={t} label="🐋 Whale Volume" value={Math.round(windowedVol).toLocaleString()} sub="tokens"/>
                <KpiCard t={t} label="💸 Whale Fees" value={whaleTotalFees>0?(whaleTotalFees>=1000?`${Math.round(whaleTotalFees).toLocaleString()} STT`:`${whaleTotalFees.toFixed(8)} STT`):"—"} color="#f59e0b" sub={whaleTotalFees>0?(whaleFeeEstimated?"~estimated":"actual fees"):"no data"}/>
                {/* Velocity sparkline */}
                <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 16px"}}>
                  <p style={{color:t.subtext,fontSize:10,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"monospace",margin:"0 0 4px"}}>🐋 Velocity</p>
                  <p style={{color:t.statVal,fontSize:18,fontWeight:700,fontFamily:"monospace",margin:"0 0 4px"}}>{whaleVelocityData[whaleVelocityData.length-1]?.velocity??0}/h</p>
                  {whaleVelocityData.length>0?(
                    <ResponsiveContainer width="100%" height={36}>
                      <AreaChart data={whaleVelocityData} margin={{top:0,right:0,bottom:0,left:0}}>
                        <defs><linearGradient id="vSparkGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs>
                        <Tooltip contentStyle={{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:4,fontSize:9,fontFamily:"monospace",padding:"2px 6px"}} labelStyle={{display:"none"}} formatter={(v:any)=>[`${v}/h`,"Whale Frequency"]}/>
                        <Area type="monotone" dataKey="velocity" stroke={t.accent} strokeWidth={1.5} fill="url(#vSparkGrad)" dot={false} isAnimationActive={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  ):<p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:0}}>no data</p>}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{display:"flex",gap:3,overflowX:"auto",paddingBottom:1}}>
              {allTabs.map(tb=>(<button key={tb.key} onClick={()=>setTab(tb.key as any)} style={{...btn,padding:"4px 12px",fontSize:10,background:tab===tb.key?t.accentBg:"transparent",color:tab===tb.key?t.accent:t.muted,border:`1px solid ${tab===tb.key?t.accent:"transparent"}`}}>{tb.label}</button>))}
            </div>
            <PriceTicker prices={oraclePrices} loading={pricesLoading} t={t} lastFetchedAt={lastFetchedAt}/>
          </div>
        </div>

        {/* Tab content */}
        <div style={{flex:1,overflowY:"auto"}}>
          {error&&<div style={{background:t.errBg,border:`1px solid ${t.errBorder}`,margin:"8px 12px 0",borderRadius:8,padding:10,color:t.errText,fontSize:11,fontFamily:"monospace"}}>⚠ {error}</div>}
          <div style={{padding:"8px 12px"}}>
            <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,overflow:"hidden"}}>
              {tab==="feed"        &&<LiveFeedTab alerts={filtered} t={t} connectedAddr={walletAddr||""} burst={burst} oraclePrices={oraclePrices} blockTxs={windowedBlockTxs} totalBlockTxsSeen={totalBlockTxsSeen} timePreset={timePreset} feedSubTab={feedSubTab} setFeedSubTab={setFeedSubTab} netMinAmt={netMinAmt} setNetMinAmt={setNetMinAmt} netMaxAmt={netMaxAmt} setNetMaxAmt={setNetMaxAmt}/>}
              {tab==="analytics"   &&<AnalyticsTab alerts={filtered} t={t} oraclePrices={oraclePrices} shockData={shockData} metrics={displayMetrics}/>}
              {tab==="charts"      &&<ChartsTab alerts={filtered} t={t}/>}
              {tab==="leaderboard" &&<LeaderboardTab alerts={filtered} t={t} persistedEntries={persistedEntries} timePreset={timePreset}/>}
              {tab==="flow"        &&<TokenFlowTab alerts={filtered} t={t}/>}
              {tab==="howto"       &&(
                <div style={{padding:20}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))",gap:14,marginBottom:16}}>
                    {[{icon:"⛓",color:"#06b6d4",title:"On-Chain Event",desc:"WhaleTracker.sol emits WhaleTransfer on each reportTransfer() call above threshold."},{icon:"⚡",color:"#06b6d4",title:"Somnia Reactivity",desc:"Reactivity Engine pushes events natively — zero polling, zero indexers, zero latency."},{icon:"🔍",color:"#a855f7",title:"Handler Contract",desc:"WhaleHandler._onEvent() called by precompile 0x0100. Emits ReactedToWhaleTransfer on-chain."},{icon:"💾",color:"#4ade80",title:"Data Streams",desc:"Leaderboard persists to Somnia Data Streams on every whale event — survives server restarts."},{icon:"🚨",color:"#f97316",title:"Burst Detection",desc:"WhaleHandler emits WhaleMomentumDetected on-chain when ≥3 transfers occur within 60 seconds."},{icon:"💛",color:"#4ade80",title:"Wallet Connect",desc:"Connect wallet to see your personal transfers, net flow, and YOU badge in Live Feed."}].map((s,i)=>(<div key={i} style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:10,padding:14}}><div style={{fontSize:22,marginBottom:8}}>{s.icon}</div><p style={{color:s.color,fontFamily:"monospace",fontSize:10,fontWeight:700,margin:"0 0 4px"}}>{s.title}</p><p style={{color:t.subtext,fontSize:10,lineHeight:1.6,margin:0}}>{s.desc}</p></div>))}
                  </div>
                  <div style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:10,padding:14}}>
                    <pre style={{color:t.subtext,fontSize:10,fontFamily:"monospace",lineHeight:1.8,margin:0,whiteSpace:"pre-wrap"}}>{`WhaleTracker.sol       → emits WhaleTransfer\nSomnia Reactivity       → pushes to handler (precompile 0x0100)\nWhaleHandler._onEvent() → emits ReactedToWhaleTransfer\n                        → emits AlertThresholdCrossed (every N)\n                        → emits WhaleMomentumDetected (≥3 in 60s window)\nFrontend burst detector → ≥3 transfers/60s → 🚨 banner\nData Streams            → persists leaderboard across restarts\nSSE stream              → 🐋 whale  ⚡ reaction  🚨 alert  🔥 Whale Spikes`}</pre>
                  </div>
                </div>
              )}
              {tab==="mywallet"&&isConnected&&walletAddr&&<MyWalletTab alerts={alerts} connectedAddr={walletAddr} t={t}/>}
              {tab==="mywallet"&&!isConnected&&<div style={{padding:40,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>Connect your wallet to view your transactions.</div>}
            </div>
            <div style={{marginTop:10,display:"flex",justifyContent:"space-between",color:t.muted,fontSize:9,fontFamily:"monospace"}}>
              <span>Contract: <a href={addrUrl(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS||"")} target="_blank" rel="noreferrer" style={{color:t.accent,textDecoration:"none"}}>{short(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS||"0x0000000000000000000000000000000000000000")}</a></span>
              <span>Somnia Testnet · Chain ID 50312</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
