"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWhaleAlerts, WhaleAlert, BlockTx } from "../lib/useWhaleAlerts";
import { useOraclePrices, formatUsd, OraclePrice } from "../lib/useOraclePrices";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";

type Theme = "dark" | "light";
const T = {
  dark:  { pageBg:"#050d1a",headerBg:"#070f1eee",card:"#0a1628",border:"rgba(6,182,212,0.2)",text:"#e2f8ff",subtext:"#67b8cc",muted:"rgba(103,184,204,0.4)",accent:"#06b6d4",accentBg:"rgba(6,182,212,0.12)",input:"#05111f",chartGrid:"#0e2a3a",chartAxis:"#2a7a90",tooltipBg:"#060e1c",tooltipBorder:"#0e4f5e",rowHover:"rgba(6,182,212,0.06)",errBg:"rgba(127,29,29,0.3)",errBorder:"rgba(185,28,28,0.4)",errText:"#f87171",statVal:"#67e8f9",tableHead:"#071322",tableRow:"#0a1628",tableAlt:"#0c1a30",badgeBg:"rgba(6,182,212,0.15)",badgeText:"#67e8f9",reactionRow:"rgba(168,85,247,0.08)",alertRow:"rgba(251,146,60,0.08)",myTxRow:"rgba(74,222,128,0.08)" },
  light: { pageBg:"#f0f9ff",headerBg:"#dbeafedd",card:"#ffffff",border:"rgba(3,105,161,0.2)",text:"#0a2540",subtext:"#0369a1",muted:"rgba(3,105,161,0.5)",accent:"#0284c7",accentBg:"rgba(2,132,199,0.1)",input:"#e0f2fe",chartGrid:"#bae6fd",chartAxis:"#0369a1",tooltipBg:"#ffffff",tooltipBorder:"#7dd3fc",rowHover:"rgba(2,132,199,0.06)",errBg:"rgba(254,226,226,0.9)",errBorder:"rgba(239,68,68,0.4)",errText:"#b91c1c",statVal:"#0c4a6e",tableHead:"#e0f2fe",tableRow:"#ffffff",tableAlt:"#f0f9ff",badgeBg:"rgba(2,132,199,0.12)",badgeText:"#0369a1",reactionRow:"rgba(168,85,247,0.06)",alertRow:"rgba(234,88,12,0.06)",myTxRow:"rgba(22,163,74,0.06)" },
};

const TOKEN_COLORS: Record<string,string> = {STT:"#06b6d4",USDC:"#2775CA",WETH:"#627EEA",WBTC:"#F7931A",USDT:"#26A17B",LINK:"#2A5ADA",UNI:"#FF007A",AAVE:"#B6509E"};
// ALL_TOKENS used as fallback — filter will be populated dynamically from actual events
const ALL_TOKENS_FALLBACK = ["All","STT","USDC","WETH","WBTC","USDT","LINK","UNI","AAVE"];
const TIME_PRESETS = [{label:"30m",ms:30*60_000},{label:"1h",ms:60*60_000},{label:"6h",ms:6*60*60_000},{label:"24h",ms:24*60*60_000},{label:"All",ms:0}];

const short     = (a:string) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const shortHash = (h:string) => h ? `${h.slice(0,10)}…${h.slice(-6)}` : "—";
const addrUrl   = (a:string) => `https://shannon-explorer.somnia.network/address/${a}`;
const txUrl     = (h:string) => `https://shannon-explorer.somnia.network/tx/${h}`;
const num       = (s:string) => parseFloat((s ?? "0").replace(/,/g,"")) || 0;

// Maps token symbol to oracle price key for USD estimation
const TOKEN_PRICE_MAP: Record<string,string> = {
  WBTC:"BTC", BTC:"BTC",
  WETH:"ETH", ETH:"ETH",
  USDC:"USDC", USDT:"USDT",
  SOL:"SOL",
};
function usdVal(amount:number, token:string, prices:Record<string,any>): string|null {
  const key = TOKEN_PRICE_MAP[token];
  if(!key || !prices[key]) return null;
  const usd = amount * prices[key].price;
  if(usd>=1_000_000) return `$${(usd/1_000_000).toFixed(2)}M`;
  if(usd>=1_000)     return `$${Math.round(usd).toLocaleString()}`;
  return `$${usd.toFixed(2)}`;
}

function timeAgo(ts:number){const d=Math.floor((Date.now()-ts)/1000);if(d<60)return`${d}s ago`;if(d<3600)return`${Math.floor(d/60)}m ago`;return`${Math.floor(d/3600)}h ago`;}
function fmtTime(ts:number){return new Date(ts).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function fmtMs(ms:number){if(ms<1000)return`${Math.round(ms)}ms`;if(ms<60000)return`${(ms/1000).toFixed(1)}s`;return`${Math.floor(ms/60000)}m ${Math.round((ms%60000)/1000)}s`;}
function playPing(){try{const ctx=new((window as any).AudioContext||(window as any).webkitAudioContext)();const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.setValueAtTime(880,ctx.currentTime);o.frequency.exponentialRampToValueAtTime(440,ctx.currentTime+0.3);g.gain.setValueAtTime(0.3,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4);o.start();o.stop(ctx.currentTime+0.4);}catch{}}
function downloadCSV(alerts:WhaleAlert[]){const rows=["type,timestamp,from,to,amount_tokens,token,tx_hash,block_number,reaction_count",...alerts.map(a=>`${a.type},${new Date(a.timestamp).toISOString()},${a.from},${a.to},${a.amount},${a.token},${a.txHash},${a.blockNumber},${a.reactionCount??""}`)];const blob=new Blob([rows.join("\n")],{type:"text/csv"});const url=URL.createObjectURL(blob);const el=document.createElement("a");el.href=url;el.download="whale_alerts.csv";el.click();URL.revokeObjectURL(url);}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Badge({text,color,t}:{text:string;color?:string;t:typeof T.dark}){return<span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:color?`${color}22`:t.badgeBg,color:color??t.badgeText,border:`1px solid ${color?`${color}44`:t.border}`}}>{text}</span>;}
function TypeBadge({type,t}:{type:string;t:typeof T.dark}){const map:Record<string,{label:string;color:string}>={whale:{label:"🐋 WHALE",color:"#06b6d4"},reaction:{label:"⚡ REACTION",color:"#a855f7"},alert:{label:"🚨 ALERT",color:"#f97316"},momentum:{label:"🔥 MOMENTUM",color:"#ef4444"}};const m=map[type]??map.whale;return<span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:`${m.color}22`,color:m.color,border:`1px solid ${m.color}44`,whiteSpace:"nowrap"}}>{m.label}</span>;}
function Th({children,t}:{children:string;t:typeof T.dark}){return<th style={{padding:"9px 12px",textAlign:"left",color:t.muted,fontSize:9,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"monospace",borderBottom:`1px solid ${t.border}`,background:t.tableHead,whiteSpace:"nowrap"}}>{children}</th>;}
function Td({children,t,bold,accent,color}:{children:React.ReactNode;t:typeof T.dark;bold?:boolean;accent?:boolean;color?:string}){return<td style={{padding:"10px 12px",color:color??(accent?t.accent:t.text),fontFamily:"monospace",fontSize:11,fontWeight:bold?700:400,borderBottom:`1px solid ${t.border}`,whiteSpace:"nowrap"}}>{children}</td>;}
function ExLink({href,label,t}:{href:string;label:string;t:typeof T.dark}){if(!href)return<span style={{color:t.muted,fontFamily:"monospace",fontSize:11}}>—</span>;return(<a href={href} target="_blank" rel="noreferrer" style={{color:t.subtext,textDecoration:"none",fontFamily:"monospace",fontSize:11,display:"inline-flex",alignItems:"center",gap:3}} onMouseEnter={e=>(e.currentTarget.style.color=t.accent)} onMouseLeave={e=>(e.currentTarget.style.color=t.subtext)}>{label}<span style={{fontSize:9,opacity:0.6}}>↗</span></a>);}
function KpiCard({label,value,sub,color,t}:{label:string;value:string|number;sub?:string;color?:string;t:typeof T.dark}){return(<div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 16px"}}><p style={{color:t.muted,fontSize:9,textTransform:"uppercase",letterSpacing:"0.15em",fontFamily:"monospace",margin:"0 0 4px"}}>{label}</p><p style={{color:color??t.statVal,fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>{sub&&<p style={{color:t.muted,fontSize:9,margin:"2px 0 0",fontFamily:"monospace"}}>{sub}</p>}</div>);}

// ── Price Ticker ──────────────────────────────────────────────────────────────
const TICKER_SYMBOLS = ["ETH","BTC","USDC","USDT","SOL"] as const;
const SYMBOL_COLORS: Record<string,string> = {ETH:"#627EEA",BTC:"#F7931A",USDC:"#2775CA",WETH:"#627EEA",USDT:"#26A17B",SOL:"#9945FF",SOMI:"#06b6d4"};

function PriceTicker({prices,loading,t,lastFetchedAt}:{prices:Record<string,OraclePrice>;loading:boolean;t:typeof T.dark;lastFetchedAt:number}){
  const available=TICKER_SYMBOLS.filter(s=>prices[s]&&prices[s].price>0);
  if(loading&&!available.length) return null;
  return(
    <div style={{display:"flex",gap:20,alignItems:"center",overflowX:"auto",flexWrap:"nowrap",borderTop:`1px solid ${t.border}`,marginTop:8,paddingTop:8}}>
      <span style={{color:t.muted,fontSize:8,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",flexShrink:0}}>Oracle Prices</span>
      {available.map(s=>{
        const p=prices[s];
        const color=SYMBOL_COLORS[s]??t.accent;
        return(
          <div key={s} style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
            <span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color,padding:"1px 5px",borderRadius:3,background:`${color}18`,border:`1px solid ${color}33`}}>{s}</span>
            <span style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:t.text}}>{formatUsd(p.price)}</span>
          </div>
        );
      })}
      <span style={{fontSize:8,color:t.muted,fontFamily:"monospace",marginLeft:"auto",flexShrink:0}}>
        Protofire · DIA · Somnia Testnet
        {lastFetchedAt>0&&<span style={{marginLeft:6,color:t.muted}}>· fetched {timeAgo(lastFetchedAt)}</span>}
      </span>
    </div>
  );
}

// ── Burst Banner ──────────────────────────────────────────────────────────────
type Burst = { count:number; volume:number; windowSec:number; dominantToken:string; tokenBreakdown:Record<string,number> } | null;

function BurstBanner({burst,t}:{burst:Burst;t:typeof T.dark}){
  const[visible,setVisible]=useState(false);
  const prevBurstRef=useRef<Burst>(null);
  useEffect(()=>{
    if(burst&&!prevBurstRef.current) setVisible(true);
    if(!burst) setVisible(false);
    prevBurstRef.current=burst;
  },[burst]);
  if(!burst||!visible) return null;
  const tokenList=burst.tokenBreakdown
    ? Object.entries(burst.tokenBreakdown).sort((a,b)=>b[1]-a[1]).map(([tk,n])=>`${n}× ${tk}`).join(", ")
    : burst.dominantToken;
  return(
    <div style={{marginBottom:14,padding:"14px 18px",borderRadius:12,background:"rgba(249,115,22,0.1)",border:"1px solid rgba(249,115,22,0.45)",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",animation:"burstPulse 2s ease-in-out infinite"}}>
      <span style={{fontSize:20}}>🚨</span>
      <div>
        <div style={{color:"#f97316",fontWeight:700,fontSize:12,fontFamily:"monospace",letterSpacing:"0.1em",textTransform:"uppercase"}}>Whale Momentum Detected</div>
        <div style={{color:"#fed7aa",fontSize:11,fontFamily:"monospace",marginTop:2}}>
          {burst.count} transfers · {Math.round(burst.volume).toLocaleString()} tokens · within {burst.windowSec}s
          <span style={{color:"#f97316",marginLeft:10}}>{tokenList}</span>
        </div>
      </div>
      <button onClick={()=>setVisible(false)} style={{marginLeft:"auto",background:"none",border:"none",color:"#f97316",cursor:"pointer",fontSize:16}}>✕</button>
    </div>
  );
}

// ── Filter Bar ────────────────────────────────────────────────────────────────
function FilterBar({t,search,setSearch,minAmt,setMinAmt,maxAmt,setMaxAmt,token,setToken,timePreset,setTimePreset,dateFrom,setDateFrom,dateTo,setDateTo,showTypes,setShowTypes,tokenList}:{t:typeof T.dark;search:string;setSearch:(v:string)=>void;minAmt:string;setMinAmt:(v:string)=>void;maxAmt:string;setMaxAmt:(v:string)=>void;token:string;setToken:(v:string)=>void;timePreset:number;setTimePreset:(v:number)=>void;dateFrom:string;setDateFrom:(v:string)=>void;dateTo:string;setDateTo:(v:string)=>void;showTypes:string[];setShowTypes:(v:string[])=>void;tokenList:string[];}){
  const inp:React.CSSProperties={background:t.input,border:`1px solid ${t.border}`,borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"};
  const lbl:React.CSSProperties={color:t.subtext,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.1em",display:"block",marginBottom:4};
  const toggleType=(type:string)=>setShowTypes(showTypes.includes(type)?showTypes.filter(x=>x!==type):[...showTypes,type]);
  return(<div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:16,marginBottom:14}}>
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",margin:"0 0 12px"}}>Filters</p>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10}}>
      <div><label style={lbl}>Wallet</label><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="0x..." style={inp}/></div>
      <div><label style={lbl}>Token</label><select value={token} onChange={e=>setToken(e.target.value)} style={{...inp,cursor:"pointer"}}>{tokenList.map(tk=><option key={tk}>{tk}</option>)}</select></div>
      <div><label style={lbl}>Min Amount</label><input type="number" value={minAmt} onChange={e=>setMinAmt(e.target.value)} placeholder="0" style={inp}/></div>
      <div><label style={lbl}>Max Amount</label><input type="number" value={maxAmt} onChange={e=>setMaxAmt(e.target.value)} placeholder="∞" style={inp}/></div>
      <div><label style={lbl}>Date From</label><input type="datetime-local" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={inp}/></div>
      <div><label style={lbl}>Date To</label><input type="datetime-local" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={inp}/></div>
    </div>
    <div style={{display:"flex",gap:6,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>TYPE:</span>
      {[{key:"whale",label:"🐋 Whale",color:"#06b6d4"},{key:"reaction",label:"⚡ Reaction",color:"#a855f7"},{key:"alert",label:"🚨 Alert",color:"#f97316"},{key:"momentum",label:"🔥 Momentum",color:"#ef4444"}].map(({key,label,color})=>(
        <button key={key} onClick={()=>toggleType(key)} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",background:showTypes.includes(key)?`${color}22`:"transparent",color:showTypes.includes(key)?color:t.muted,border:`1px solid ${showTypes.includes(key)?`${color}66`:"transparent"}`}}>{label}</button>
      ))}
      <span style={{color:t.muted,fontSize:9,fontFamily:"monospace",marginLeft:8}}>QUICK:</span>
      {TIME_PRESETS.map(p=>(<button key={p.label} onClick={()=>{setTimePreset(p.ms);setDateFrom("");setDateTo("");}} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",background:timePreset===p.ms?t.accentBg:"transparent",color:timePreset===p.ms?t.accent:t.muted,border:`1px solid ${timePreset===p.ms?t.accent:"transparent"}`}}>{p.label}</button>))}
      <button onClick={()=>{setSearch("");setMinAmt("");setMaxAmt("");setToken("All");setTimePreset(0);setDateFrom("");setDateTo("");setShowTypes(["whale","reaction","alert","momentum"]);}} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",color:t.errText,background:"transparent",border:"1px solid transparent",marginLeft:"auto"}}>✕ Clear</button>
    </div>
  </div>);}

// ── Live Feed Tab ─────────────────────────────────────────────────────────────
function LiveFeedTab({alerts,t,connectedAddr,burst,oraclePrices,blockTxs,totalBlockTxsSeen,timePreset}:{alerts:WhaleAlert[];t:typeof T.dark;connectedAddr?:string;burst:Burst;oraclePrices:Record<string,any>;blockTxs:BlockTx[];totalBlockTxsSeen:number;timePreset:number}){
  const[expanded,setExpanded]=useState<string|null>(null);
  const[page,setPage]=useState(0);
  const[netPage,setNetPage]=useState(0);
  const PAGE=10, NET_PAGE=10;
  const totalPages=Math.max(1,Math.ceil(alerts.length/PAGE));
  const pageAlerts=alerts.slice(page*PAGE,(page+1)*PAGE);
  const[sttOnly,setSttOnly]=useState(false);
  const filteredBlockTxs=useMemo(()=>sttOnly?blockTxs.filter(tx=>tx.amountRaw>0):blockTxs,[blockTxs,sttOnly]);

  // Reset to page 0 when new alerts arrive
  const prevCount=useRef(alerts.length);
  useEffect(()=>{if(alerts.length!==prevCount.current){setPage(0);prevCount.current=alerts.length;}},[alerts.length]);
  function rowBg(a:WhaleAlert,i:number){
    const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());
    if(isMyTx)return t.myTxRow;
    if(a.type==="reaction")return i%2===0?t.reactionRow:`${t.reactionRow}cc`;
    if(a.type==="alert")return i%2===0?t.alertRow:`${t.alertRow}cc`;
    if(a.type==="momentum")return "rgba(239,68,68,0.08)";
    return i%2===0?t.tableRow:t.tableAlt;
  }
  return(<div style={{padding:"14px 14px 0"}}>
    <BurstBanner burst={burst} t={t}/>
    {!alerts.length
      ? <div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>Waiting for activity...</div>
      : <><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{["Type","Token","Amount","USD Value","From","To","TX Hash","Block","Time",""].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
          <tbody>{pageAlerts.map((a,i)=>{
            const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());
            const usd=a.type==="whale"?usdVal(num(a.amount),a.token,oraclePrices):null;
            return(<>
              <tr key={a.id} style={{background:rowBg(a,i),cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=rowBg(a,i))}>
                <Td t={t}><div style={{display:"flex",gap:4,alignItems:"center"}}><TypeBadge type={a.type} t={t}/>{isMyTx&&<span style={{fontSize:8,background:"rgba(74,222,128,0.2)",color:"#4ade80",border:"1px solid rgba(74,222,128,0.4)",borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>YOU</span>}</div></Td>
                <Td t={t}>{a.token?<Badge text={a.token} color={TOKEN_COLORS[a.token]} t={t}/>:<span style={{color:t.muted,fontSize:11}}>—</span>}</Td>
                <Td t={t} accent bold>{a.type==="whale"?num(a.amount).toLocaleString():<span style={{color:t.muted}}>—</span>}</Td>
                <Td t={t}>{usd?<span style={{color:"#4ade80",fontFamily:"monospace",fontSize:11,fontWeight:700}}>{usd}</span>:a.type==="whale"&&a.token?<span style={{color:t.muted,fontSize:10}}>{num(a.amount).toLocaleString()} {a.token}</span>:<span style={{color:t.muted,fontSize:10}}>—</span>}</Td>
                <Td t={t}><ExLink href={a.from?addrUrl(a.from):""} label={a.from?short(a.from):"—"} t={t}/></Td>
                <Td t={t}><ExLink href={a.to?addrUrl(a.to):""} label={a.to?short(a.to):"—"} t={t}/></Td>
                <Td t={t}><ExLink href={a.txHash?txUrl(a.txHash):""} label={shortHash(a.txHash)} t={t}/></Td>
                <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{a.blockNumber||"—"}</span></Td>
                <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(a.timestamp)}</span></Td>
                <td style={{padding:"10px 12px",borderBottom:`1px solid ${t.border}`}}><button onClick={()=>setExpanded(expanded===a.id?null:a.id)} style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:4,cursor:"pointer",background:t.accentBg,color:t.accent,border:`1px solid ${t.border}`}}>{expanded===a.id?"▲":"▼"}</button></td>
              </tr>
              {expanded===a.id&&(<tr key={`${a.id}-exp`} style={{background:t.accentBg}}><td colSpan={10} style={{padding:"12px 16px",borderBottom:`1px solid ${t.border}`}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))",gap:12,fontFamily:"monospace",fontSize:11}}>
                  <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Full TX Hash</span><div style={{marginTop:4}}><ExLink href={txUrl(a.txHash)} label={a.txHash||"—"} t={t}/></div></div>
                  {a.type==="whale"&&<><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>From</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.from)} label={a.from} t={t}/></div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>To</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.to)} label={a.to} t={t}/></div></div><div><span style={{color:t.accent,fontWeight:700,marginTop:4,fontSize:9,textTransform:"uppercase"}}>Amount</span><div style={{color:t.accent,fontWeight:700,marginTop:4}}>{num(a.amount).toLocaleString()} <span style={{color:t.muted}}>{a.token}</span>{usd&&<span style={{color:"#4ade80",marginLeft:8}}>{usd}</span>}</div></div></>}
                  {a.type==="reaction"&&<><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Reaction #</span><div style={{color:"#a855f7",fontWeight:700,marginTop:4}}>{a.reactionCount}</div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Handler Emitter</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.handlerEmitter??"")} label={short(a.handlerEmitter??"")} t={t}/></div></div></>}
                  {a.type==="alert"&&<div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Alert At Reaction</span><div style={{color:"#f97316",fontWeight:700,marginTop:4}}>#{a.reactionCount}</div></div>}
                  <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Block</span><div style={{color:t.text,marginTop:4}}>{a.blockNumber||"—"}</div></div>
                  <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Timestamp</span><div style={{color:t.text,marginTop:4}}>{fmtTime(a.timestamp)}</div></div>
                </div>
              </td></tr>)}
            </>);
          })}</tbody>
        </table></div>
        {/* Pagination */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 4px",borderTop:`1px solid ${t.border}`}}>
          <span style={{color:t.muted,fontSize:10,fontFamily:"monospace"}}>{alerts.length} events · page {page+1} of {totalPages}</span>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setPage(0)} disabled={page===0} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:page===0?"not-allowed":"pointer",background:t.accentBg,color:page===0?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:page===0?0.4:1}}>«</button>
            <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:page===0?"not-allowed":"pointer",background:t.accentBg,color:page===0?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:page===0?0.4:1}}>‹ Prev</button>
            <button onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:page>=totalPages-1?"not-allowed":"pointer",background:t.accentBg,color:page>=totalPages-1?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:page>=totalPages-1?0.4:1}}>Next ›</button>
            <button onClick={()=>setPage(totalPages-1)} disabled={page>=totalPages-1} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:page>=totalPages-1?"not-allowed":"pointer",background:t.accentBg,color:page>=totalPages-1?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:page>=totalPages-1?0.4:1}}>»</button>
          </div>
        </div>
      </>
    }

    {/* ── Network Activity Table ─────────────────────────────────────────── */}
    <div style={{marginTop:20,borderTop:`1px solid ${t.border}`,paddingTop:14}}>
      {(()=>{
        const netPages=Math.max(1,Math.ceil(filteredBlockTxs.length/NET_PAGE));
        const netSlice=filteredBlockTxs.slice(netPage*NET_PAGE,(netPage+1)*NET_PAGE);
        const windowLabel=timePreset>0?`last ${TIME_PRESETS.find(p=>p.ms===timePreset)?.label??""}`:"all buffered";
        return(<>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{color:"#4ade80",fontSize:10,fontFamily:"monospace",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.12em"}}>🌐 Network Activity</span>
            <span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>
              {blockTxs.filter(tx=>tx.amountRaw>0).length} STT transfers · {blockTxs.filter(tx=>tx.amountRaw===0).length} contract calls
            </span>
            <button onClick={()=>{setSttOnly(v=>!v);setNetPage(0);}} style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:5,cursor:"pointer",background:sttOnly?t.accentBg:"transparent",color:sttOnly?t.accent:t.muted,border:`1px solid ${sttOnly?t.accent:t.border}`}}>
              {sttOnly?"✓ STT only":"STT only"}
            </button>
            <span style={{marginLeft:"auto",color:t.muted,fontSize:9,fontFamily:"monospace"}}>{filteredBlockTxs.length} shown · {totalBlockTxsSeen.toLocaleString()} seen total</span>
          </div>
          {filteredBlockTxs.length===0
            ? <div style={{padding:"24px",textAlign:"center",color:t.muted,fontSize:11,fontFamily:"monospace"}}>Waiting for block activity...</div>
            : <><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr>{["From","To","Amount (STT)","TX Hash","Block","Time"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
                <tbody>{netSlice.map((tx,i)=>(
                  <tr key={tx.id} style={{background:i%2===0?t.tableRow:t.tableAlt}}>
                    <Td t={t}><ExLink href={addrUrl(tx.from)} label={short(tx.from)} t={t}/></Td>
                    <Td t={t}><ExLink href={addrUrl(tx.to)}   label={short(tx.to)}   t={t}/></Td>
                    <Td t={t} accent bold>{tx.amountRaw>0?`${tx.amount} STT`:<span style={{color:t.muted,fontSize:10}}>contract call</span>}</Td>
                    <Td t={t}><ExLink href={txUrl(tx.txHash)} label={shortHash(tx.txHash)} t={t}/></Td>
                    <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{tx.blockNumber}</span></Td>
                    <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(tx.timestamp)}</span></Td>
                  </tr>
                ))}</tbody>
              </table></div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 4px",borderTop:`1px solid ${t.border}`}}>
                <span style={{color:t.muted,fontSize:10,fontFamily:"monospace"}}>{filteredBlockTxs.length} shown · page {netPage+1} of {netPages}</span>
                <div style={{display:"flex",gap:6}}>
                  {[["«",()=>setNetPage(0),netPage===0],["‹ Prev",()=>setNetPage(p=>Math.max(0,p-1)),netPage===0],["Next ›",()=>setNetPage(p=>Math.min(netPages-1,p+1)),netPage>=netPages-1],["»",()=>setNetPage(netPages-1),netPage>=netPages-1]].map(([label,fn,dis])=>(
                    <button key={label as string} onClick={fn as any} disabled={dis as boolean} style={{fontSize:10,fontFamily:"monospace",padding:"3px 8px",borderRadius:5,cursor:(dis as boolean)?"not-allowed":"pointer",background:t.accentBg,color:(dis as boolean)?t.muted:t.accent,border:`1px solid ${t.border}`,opacity:(dis as boolean)?0.4:1}}>{label as string}</button>
                  ))}
                </div>
              </div>
            </>
          }
        </>);
      })()}
    </div>
  </div>);}

// ── My Wallet Tab ─────────────────────────────────────────────────────────────
function MyWalletTab({alerts,connectedAddr,t}:{alerts:WhaleAlert[];connectedAddr:string;t:typeof T.dark}){
  const myTxns    =useMemo(()=>alerts.filter(a=>a.type==="whale"&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase())),[alerts,connectedAddr]);
  const myVolume  =useMemo(()=>myTxns.reduce((s,a)=>s+num(a.amount),0),[myTxns]);
  const mySent    =useMemo(()=>myTxns.filter(a=>a.from.toLowerCase()===connectedAddr.toLowerCase()),[myTxns,connectedAddr]);
  const myReceived=useMemo(()=>myTxns.filter(a=>a.to.toLowerCase()===connectedAddr.toLowerCase()),[myTxns,connectedAddr]);
  const sentVol   =useMemo(()=>mySent.reduce((s,a)=>s+num(a.amount),0),[mySent]);
  const recvVol   =useMemo(()=>myReceived.reduce((s,a)=>s+num(a.amount),0),[myReceived]);
  const netFlow   =recvVol-sentVol;
  return(<div style={{padding:24}}>
    <div style={{marginBottom:20,padding:"12px 16px",borderRadius:10,background:t.accentBg,border:`1px solid ${t.border}`,display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:20}}>💛</span>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",margin:0}}>Connected Wallet</p><p style={{color:t.accent,fontFamily:"monospace",fontSize:12,fontWeight:700,margin:0}}>{connectedAddr}</p></div>
      <a href={addrUrl(connectedAddr)} target="_blank" rel="noreferrer" style={{marginLeft:"auto",fontSize:10,color:t.accent,fontFamily:"monospace",textDecoration:"none"}}>View on Explorer ↗</a>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:10,marginBottom:24}}>
      <KpiCard t={t} label="My Transfers"   value={myTxns.length}/>
      <KpiCard t={t} label="My Volume"      value={Math.round(myVolume).toLocaleString()} sub="tokens"/>
      <KpiCard t={t} label="Net Flow"       value={(netFlow>=0?"+":"")+Math.round(netFlow).toLocaleString()} color={netFlow>=0?"#4ade80":"#f87171"} sub={netFlow>=0?"net inflow":"net outflow"}/>
      <KpiCard t={t} label="Sent / Received" value={`${mySent.length} / ${myReceived.length}`} sub="transactions"/>
    </div>
    {!myTxns.length
      ? <div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>No whale transactions for this wallet.</div>
      : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
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
        </table></div>
    }
  </div>);}

// ── Analytics Tab ─────────────────────────────────────────────────────────────
function AnalyticsTab({alerts,t,oraclePrices}:{alerts:WhaleAlert[];t:typeof T.dark;oraclePrices:Record<string,OraclePrice>}){
  const whales      = useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const alertEvents = useMemo(()=>alerts.filter(a=>a.type==="alert"),[alerts]);
  const totalVol    = useMemo(()=>whales.reduce((s,a)=>s+num(a.amount),0),[whales]);

  const uniqueWallets = useMemo(()=>new Set([...whales.map(a=>a.from),...whales.map(a=>a.to)]).size,[whales]);
  const avgSize       = whales.length>0 ? totalVol/whales.length : 0;
  const activityRate  = useMemo(()=>{const cutoff=Date.now()-60*60_000;return whales.filter(a=>a.timestamp>cutoff).length;},[whales]);

  // ── Momentum direction: last 30min vs prior 30min ─────────────────────────
  const momentum = useMemo(()=>{
    const now=Date.now(), half=30*60_000;
    const recentVol = whales.filter(a=>now-a.timestamp<half).reduce((s,a)=>s+num(a.amount),0);
    const prevVol   = whales.filter(a=>{const age=now-a.timestamp;return age>=half&&age<half*2;}).reduce((s,a)=>s+num(a.amount),0);
    if(prevVol===0&&recentVol===0) return {label:"➡️ Neutral",color:t.muted,pct:0};
    if(prevVol===0) return {label:"🚀 Bullish",color:"#4ade80",pct:100};
    const pct=((recentVol-prevVol)/prevVol)*100;
    if(pct>10)  return {label:"🚀 Bullish",color:"#4ade80",pct};
    if(pct<-10) return {label:"📉 Bearish",color:"#f87171",pct};
    return {label:"➡️ Neutral",color:t.muted,pct};
  },[whales,t.muted]);

  // ── Concentration: top 5 and top 10 ──────────────────────────────────────
  const concentration = useMemo(()=>{
    const vol:Record<string,number>={};
    whales.forEach(a=>{vol[a.from]=(vol[a.from]||0)+num(a.amount);});
    const sorted=Object.values(vol).sort((a,b)=>b-a);
    const top5  = sorted.slice(0,5).reduce((s,v)=>s+v,0);
    const top10 = sorted.slice(0,10).reduce((s,v)=>s+v,0);
    return {
      top5pct:  totalVol>0?Math.round((top5/totalVol)*100):0,
      top10pct: totalVol>0?Math.round((top10/totalVol)*100):0,
    };
  },[whales,totalVol]);

  // ── Alert intelligence ────────────────────────────────────────────────────
  const alertIntel = useMemo(()=>{
    if(alertEvents.length<2) return null;
    const sorted=[...alertEvents].sort((a,b)=>a.timestamp-b.timestamp);
    const gaps=sorted.slice(1).map((a,i)=>a.timestamp-sorted[i].timestamp);
    const avgGap=gaps.reduce((s,g)=>s+g,0)/gaps.length;
    const WINDOW=30_000;
    const vols=sorted.map(alert=>whales.filter(w=>Math.abs(w.timestamp-alert.timestamp)<WINDOW).reduce((s,a)=>s+num(a.amount),0));
    return {
      count:       alertEvents.length,
      avgGap,
      avgAlertVol: vols.reduce((s,v)=>s+v,0)/vols.length,
      maxAlertVol: Math.max(...vols),
    };
  },[alertEvents,whales]);

  // ── Net flows ──────────────────────────────────────────────────────────────
  const netFlows = useMemo(()=>{
    const inflow:Record<string,number>={};
    const outflow:Record<string,number>={};
    whales.forEach(a=>{inflow[a.to]=(inflow[a.to]||0)+num(a.amount);outflow[a.from]=(outflow[a.from]||0)+num(a.amount);});
    const wallets=new Set([...Object.keys(inflow),...Object.keys(outflow)]);
    return Array.from(wallets).map(w=>({wallet:w,net:(inflow[w]||0)-(outflow[w]||0),inflow:inflow[w]||0,outflow:outflow[w]||0})).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)).slice(0,10);
  },[whales]);

  // ── Volume per minute ──────────────────────────────────────────────────────
  const minuteData = useMemo(()=>{
    const b:Record<string,number>={};
    whales.forEach(a=>{const k=new Date(a.timestamp).toISOString().slice(0,16);b[k]=(b[k]||0)+num(a.amount);});
    return Object.entries(b).slice(-30).map(([time,volume])=>({time:time.slice(11),volume:Math.round(volume)}));
  },[whales]);

  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};
  const secLabel=(text:string,color?:string):React.CSSProperties=>({color:color??t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase" as const,letterSpacing:"0.15em",marginBottom:14});

  return(<div style={{padding:24}}>

    {/* KPI row */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10,marginBottom:28}}>
      <KpiCard t={t} label="Unique Wallets"     value={uniqueWallets}/>
      <KpiCard t={t} label="Avg Transfer Size"  value={Math.round(avgSize).toLocaleString()} sub="tokens"/>
      <KpiCard t={t} label="Activity Rate"      value={activityRate} sub="txns / last hour"/>
      <KpiCard t={t} label="Market Momentum"    value={momentum.label} color={momentum.color} sub={`${momentum.pct>=0?"+":""}${momentum.pct.toFixed(1)}% vs prev 30m`}/>
      <KpiCard t={t} label="Top 5 Concentration" value={`${concentration.top5pct}%`} color={concentration.top5pct>70?"#f97316":t.statVal} sub="of total volume"/>
    </div>

    {/* Concentration bars */}
    <p style={secLabel("Whale Concentration")}>Whale Concentration</p>
    <div style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:10,padding:16,marginBottom:28}}>
      {[
        {label:"Top 5 wallets",  pct:concentration.top5pct,  color:concentration.top5pct>70?"#f97316":t.accent},
        {label:"Top 10 wallets", pct:concentration.top10pct, color:concentration.top10pct>85?"#f97316":t.accent},
      ].map(({label,pct,color})=>(
        <div key={label} style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",fontFamily:"monospace",fontSize:10,color:t.subtext,marginBottom:4}}>
            <span>{label}</span><span style={{color,fontWeight:700}}>{pct}% of volume</span>
          </div>
          <div style={{height:8,background:t.border,borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${color},${color}88)`,borderRadius:4,transition:"width 0.6s ease"}}/>
          </div>
        </div>
      ))}
      <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"8px 0 0"}}>
        {concentration.top5pct>70?"⚠️ High concentration — market may be whale-dominated":"✓ Moderate distribution across wallets"}
      </p>
    </div>

    {/* Momentum chart */}
    <p style={secLabel("")}>Volume Momentum (per minute)</p>
    {!minuteData.length
      ? <div style={{height:130,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12,marginBottom:28}}>No data yet</div>
      : <div style={{marginBottom:28}}>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={minuteData}><defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={4}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#mg)"/></AreaChart>
          </ResponsiveContainer>
        </div>
    }

    {/* Alert Intelligence */}
    {alertIntel&&(<>
      <p style={{...secLabel("","#f97316")}}>🚨 Alert Intelligence</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))",gap:10,marginBottom:28}}>
        {[
          {label:"Total Alerts",       value:alertIntel.count,                              sub:undefined},
          {label:"Avg Gap Between Alerts", value:fmtMs(alertIntel.avgGap),                 sub:"time between alerts"},
          {label:"Avg Vol During Alert",   value:Math.round(alertIntel.avgAlertVol).toLocaleString(), sub:"tokens (±30s window)"},
          {label:"Peak Alert Volume",      value:Math.round(alertIntel.maxAlertVol).toLocaleString(), sub:"tokens"},
        ].map(({label,value,sub})=>(
          <div key={label} style={{background:t.pageBg,border:"1px solid rgba(249,115,22,0.3)",borderRadius:10,padding:"12px 16px"}}>
            <p style={{color:"rgba(249,115,22,0.6)",fontSize:9,fontFamily:"monospace",textTransform:"uppercase",margin:"0 0 4px"}}>{label}</p>
            <p style={{color:"#f97316",fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>
            {sub&&<p style={{color:"rgba(249,115,22,0.5)",fontSize:9,fontFamily:"monospace",margin:"2px 0 0"}}>{sub}</p>}
          </div>
        ))}
      </div>
    </>)}

    {/* Net Flow table */}
    <p style={secLabel("")}>Net Flow per Wallet (inflow − outflow)</p>
    {!netFlows.length
      ? <p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</p>
      : <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{["#","Wallet","Inflow","Outflow","Net Flow","Direction"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
          <tbody>{netFlows.map((row,i)=>{
            const isAccum=row.net>=0;
            return(<tr key={row.wallet} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}>
              <Td t={t}>{i+1}</Td>
              <Td t={t}><ExLink href={addrUrl(row.wallet)} label={short(row.wallet)} t={t}/></Td>
              <Td t={t}>{Math.round(row.inflow).toLocaleString()}</Td>
              <Td t={t}>{Math.round(row.outflow).toLocaleString()}</Td>
              <Td t={t} bold color={isAccum?"#4ade80":"#f87171"}>{(isAccum?"+":"")+Math.round(row.net).toLocaleString()}</Td>
              <Td t={t}><span style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:4,background:isAccum?"rgba(74,222,128,0.15)":"rgba(248,113,113,0.15)",color:isAccum?"#4ade80":"#f87171",border:`1px solid ${isAccum?"rgba(74,222,128,0.3)":"rgba(248,113,113,0.3)"}`}}>{isAccum?"ACCUMULATING":"DISTRIBUTING"}</span></Td>
            </tr>);
          })}</tbody>
        </table>
    }

    {/* Oracle Price Reference Panel */}
    {Object.keys(oraclePrices).length>0&&(<>
      <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",margin:"28px 0 14px"}}>🔮 Live Oracle Prices (Somnia Testnet)</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:10,marginBottom:12}}>
        {Object.values(oraclePrices).map(p=>{
          const color=SYMBOL_COLORS[p.symbol]??t.accent;
          return(
            <div key={p.symbol} style={{background:t.pageBg,border:`1px solid ${p.stale?"rgba(249,115,22,0.3)":color+"33"}`,borderRadius:10,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                <span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color,padding:"1px 6px",borderRadius:3,background:`${color}18`}}>{p.symbol}/USD</span>
                {p.stale&&<span style={{fontSize:8,color:"#f97316",fontFamily:"monospace"}}>STALE</span>}
              </div>
              <p style={{color:p.stale?t.muted:t.text,fontSize:16,fontWeight:700,fontFamily:"monospace",margin:0}}>{formatUsd(p.price)}</p>
              <p style={{color:t.muted,fontSize:8,fontFamily:"monospace",margin:"4px 0 0"}}>{p.source} · {new Date(p.updatedAt).toLocaleTimeString()}</p>
            </div>
          );
        })}
      </div>
      <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",margin:"4px 0 0"}}>
        Powered by Protofire (ETH/BTC/USDC) and DIA (WETH/USDT/SOL/SOMI) oracles deployed on Somnia.
        STT/USD feed not yet available — native STT transfers show token amounts only.
      </p>
    </>)}
  </div>);}

// ── Charts Tab ────────────────────────────────────────────────────────────────
function ChartsTab({alerts,t}:{alerts:WhaleAlert[];t:typeof T.dark}){
  const whaleOnly=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const volData=useMemo(()=>{const b:Record<string,number>={};whaleOnly.forEach(a=>{const k=new Date(a.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});b[k]=(b[k]||0)+num(a.amount);});return Object.entries(b).slice(-20).map(([time,volume])=>({time,volume:Math.round(volume)}));},[whaleOnly]);
  const heatData=useMemo(()=>{const h=Array.from({length:24},(_,i)=>({hour:`${i}h`,count:0}));whaleOnly.forEach(a=>{h[new Date(a.timestamp).getHours()].count++;});return h;},[whaleOnly]);
  const reactionData=useMemo(()=>{const b:Record<string,number>={};alerts.filter(a=>a.type==="reaction").forEach(a=>{const k=new Date(a.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});b[k]=(b[k]||0)+1;});return Object.entries(b).slice(-20).map(([time,count])=>({time,count}));},[alerts]);
  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};
  return(<div style={{padding:24,display:"flex",flexDirection:"column",gap:32}}>
    <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:16}}>Whale Transfer Volume Over Time</p>
      {!volData.length?<div style={{height:160,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</div>:<ResponsiveContainer width="100%" height={200}><AreaChart data={volData}><defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><YAxis tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#vg)"/></AreaChart></ResponsiveContainer>}
    </div>
    <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:16}}>Activity Heatmap by Hour</p>
      <ResponsiveContainer width="100%" height={160}><BarChart data={heatData} barSize={10}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false}/><XAxis dataKey="hour" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={3}/><YAxis tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><Tooltip {...tt}/><Bar dataKey="count" radius={[3,3,0,0]}>{heatData.map((_,i)=><Cell key={i} fill={t.accent}/>)}</Bar></BarChart></ResponsiveContainer>
    </div>
    {reactionData.length>0&&<div><p style={{color:"#a855f7",fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:16}}>⚡ Handler Reactions Over Time</p>
      <ResponsiveContainer width="100%" height={160}><AreaChart data={reactionData}><defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#a855f7" stopOpacity={0.3}/><stop offset="95%" stopColor="#a855f7" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><YAxis tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="count" stroke="#a855f7" strokeWidth={2} fill="url(#rg)"/></AreaChart></ResponsiveContainer>
    </div>}
  </div>);}

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
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:12}}>Top 10 Tokens by Volume</p>
        {!tokenStats.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No data</p>:<table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:11}}><thead><tr>{["#","Token","Volume","Txns","Largest"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{tokenStats.map((row,i)=>(<tr key={row.symbol} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><Badge text={row.symbol} color={TOKEN_COLORS[row.symbol]} t={t}/></Td><Td t={t} bold>{Math.round(row.volume).toLocaleString()}</Td><Td t={t}>{row.count}</Td><Td t={t}>{Math.round(row.largest).toLocaleString()}</Td></tr>))}</tbody></table>}
      </div>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:12}}>Volume by Token</p>
        {!tokenStats.length?<div style={{height:240,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontSize:12,fontFamily:"monospace"}}>No data</div>:<ResponsiveContainer width="100%" height={240}><BarChart data={tokenStats} layout="vertical" barSize={14}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} horizontal={false}/><XAxis type="number" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><YAxis type="category" dataKey="symbol" tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}} width={42}/><Tooltip {...tt} formatter={(v:any)=>[Math.round(v).toLocaleString(),"Volume"]}/><Bar dataKey="volume" radius={[0,4,4,0]}>{tokenStats.map(row=><Cell key={row.symbol} fill={TOKEN_COLORS[row.symbol]??t.accent}/>)}</Bar></BarChart></ResponsiveContainer>}
      </div>
    </div>
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",marginBottom:16}}>Top 10 Address Pair Flows</p>
    {!pairFlows.length?<p style={{color:t.muted,fontFamily:"monospace",fontSize:12}}>No pair data</p>:pairFlows.map((row,i)=>(<div key={row.pair} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{color:t.muted,fontFamily:"monospace",fontSize:10,width:16}}>{i+1}</span><span style={{color:t.subtext,fontFamily:"monospace",fontSize:11,width:150,flexShrink:0}}>{row.pair}</span><div style={{flex:1,height:6,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(row.volume/pairFlows[0].volume)*100}%`,background:`linear-gradient(90deg,${t.accent},#22d3ee)`,borderRadius:4}}/></div><span style={{color:t.text,fontFamily:"monospace",fontSize:11,width:90,textAlign:"right"}}>{row.volume.toLocaleString()}</span></div>))}
  </div>);}

// ── Leaderboard Tab ───────────────────────────────────────────────────────────
function LeaderboardTab({alerts,t,persistedEntries}:{alerts:WhaleAlert[];t:typeof T.dark;persistedEntries:{wallet:string;totalVolume:string;txCount:number;lastSeen:number}[]}){
  const[mode,setMode]=useState<"senders"|"receivers">("senders");
  const[source,setSource]=useState<"live"|"persistent">("live");
  const whaleOnly=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const liveTop=useMemo(()=>{const map:Record<string,{count:number;volume:number;tokens:Set<string>}>={};whaleOnly.forEach(a=>{const k=mode==="senders"?a.from:a.to;if(!map[k])map[k]={count:0,volume:0,tokens:new Set()};map[k].count++;map[k].volume+=num(a.amount);map[k].tokens.add(a.token);});return Object.entries(map).sort((a,b)=>b[1].volume-a[1].volume).slice(0,10);},[whaleOnly,mode]);
  const maxVol=liveTop[0]?.[1].volume||1;
  return(<div style={{padding:24}}>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
      {(["senders","receivers"] as const).map(m=>(<button key={m} onClick={()=>setMode(m)} style={{fontSize:11,fontFamily:"monospace",padding:"6px 16px",borderRadius:8,cursor:"pointer",background:mode===m?t.accentBg:"transparent",color:mode===m?t.accent:t.muted,border:`1px solid ${mode===m?t.accent:"transparent"}`}}>{m}</button>))}
      <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
        <span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>SOURCE:</span>
        {[{key:"live",label:"Live"},{key:"persistent",label:"💾 Streams"}].map(({key,label})=>(<button key={key} onClick={()=>setSource(key as "live"|"persistent")} style={{fontSize:10,fontFamily:"monospace",padding:"4px 10px",borderRadius:6,cursor:"pointer",background:source===key?t.accentBg:"transparent",color:source===key?t.accent:t.muted,border:`1px solid ${source===key?t.accent:"transparent"}`}}>{label}</button>))}
      </div>
    </div>
    {source==="persistent"
      ? persistedEntries.length===0
        ? <div style={{padding:32,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No persistent data yet. Streams leaderboard populates as whale transfers occur.</div>
        : <table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["#","Wallet","Total Volume","Txns","Last Seen"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{persistedEntries.slice(0,10).map(({wallet,totalVolume,txCount,lastSeen},i)=>(<tr key={wallet} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(wallet)} label={short(wallet)} t={t}/></Td><Td t={t} bold accent>{Number(totalVolume).toLocaleString()}</Td><Td t={t}>{txCount}</Td><Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(lastSeen)}</span></Td></tr>))}</tbody></table>
      : !liveTop.length
        ? <p style={{color:t.muted,fontFamily:"monospace",fontSize:13,textAlign:"center",padding:32}}>No data</p>
        : <table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["#","Address","Volume","Txns","Tokens","Share"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead><tbody>{liveTop.map(([addr,{count,volume,tokens}],i)=>(<tr key={addr} style={{background:i%2===0?t.tableRow:t.tableAlt,transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(addr)} label={short(addr)} t={t}/></Td><Td t={t} bold accent>{Math.round(volume).toLocaleString()}</Td><Td t={t}>{count}</Td><Td t={t}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{Array.from(tokens).map(tk=><Badge key={tk} text={tk} color={TOKEN_COLORS[tk]} t={t}/>)}</div></Td><Td t={t}><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:60,height:4,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(volume/maxVol)*100}%`,background:t.accent}}/></div><span style={{color:t.muted,fontSize:10}}>{Math.round((volume/maxVol)*100)}%</span></div></Td></tr>))}</tbody></table>
    }
  </div>);}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function WhaleDashboard(){
  const{alerts,blockTxs,totalBlockTxsSeen,networkLargestSTT,connected,error}=useWhaleAlerts();
  const{address:walletAddr,isConnected}=useAccount();
  const{prices:oraclePrices,loading:pricesLoading,lastFetchedAt}=useOraclePrices(10_000);
  const[simulating,setSimulating]=useState(false);
  const[soundEnabled,setSoundEnabled]=useState(false);
  const[theme,setTheme]=useState<Theme>("dark");
  const[tab,setTab]=useState<"feed"|"analytics"|"charts"|"leaderboard"|"flow"|"howto"|"mywallet">("feed");
  const[search,setSearch]=useState("");
  const[minAmt,setMinAmt]=useState("");
  const[maxAmt,setMaxAmt]=useState("");
  const[tokenFilter,setTokenFilter]=useState("All");
  const[timePreset,setTimePreset]=useState(0);
  const[dateFrom,setDateFrom]=useState("");
  const[dateTo,setDateTo]=useState("");
  const[showTypes,setShowTypes]=useState<string[]>(["whale","reaction","alert","momentum"]);
  const[persistedEntries,setPersistedEntries]=useState<any[]>([]);
  const t=T[theme];

  useEffect(()=>{
    fetch("/api/streams-leaderboard").then(r=>r.json()).then(d=>{if(d.entries?.length)setPersistedEntries(d.entries);}).catch(()=>{});
  },[]);

  const prevLen=useRef(0);
  useEffect(()=>{if(alerts.length>prevLen.current&&soundEnabled&&prevLen.current>0)playPing();prevLen.current=alerts.length;},[alerts.length,soundEnabled]);

  const whales    = useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const reactions = useMemo(()=>alerts.filter(a=>a.type==="reaction"),[alerts]);
  const alertCount = useMemo(()=>alerts.filter(a=>a.type==="alert").length,[alerts]);
  const momentumCount = useMemo(()=>alerts.filter(a=>a.type==="momentum").length,[alerts]);
  const totalVol  = useMemo(()=>whales.reduce((s,a)=>s+num(a.amount),0),[whales]);
  const largestTransfer = useMemo(()=>whales.reduce((max,a)=>Math.max(max,num(a.amount)),0),[whales]);

  // Time-windowed counts for KPI cards — respect selected filter window
  const windowCutoff = useMemo(()=>timePreset>0?Date.now()-timePreset:0,[timePreset]);
  const windowedWhales      = useMemo(()=>whales.filter(a=>!windowCutoff||a.timestamp>=windowCutoff),[whales,windowCutoff]);
  const windowedReactions   = useMemo(()=>reactions.filter(a=>!windowCutoff||a.timestamp>=windowCutoff),[reactions,windowCutoff]);
  const windowedAlertCount  = useMemo(()=>alerts.filter(a=>a.type==="alert"&&(!windowCutoff||a.timestamp>=windowCutoff)).length,[alerts,windowCutoff]);
  const windowedMomentumCount=useMemo(()=>alerts.filter(a=>a.type==="momentum"&&(!windowCutoff||a.timestamp>=windowCutoff)).length,[alerts,windowCutoff]);
  const windowedVol         = useMemo(()=>windowedWhales.reduce((s,a)=>s+num(a.amount),0),[windowedWhales]);
  const windowedLargest     = useMemo(()=>windowedWhales.reduce((max,a)=>Math.max(max,num(a.amount)),0),[windowedWhales]);

  // Time-windowed network txns for KPI — available at top level
  const windowedBlockTxs = useMemo(()=>!windowCutoff?blockTxs:blockTxs.filter(tx=>tx.timestamp>=windowCutoff),[blockTxs,windowCutoff]);

  // Network-wide stats (all block transactions regardless of amount)
  const networkTotalSTT  = useMemo(()=>blockTxs.reduce((s,tx)=>s+tx.amountRaw,0),[blockTxs]);

  // Dynamic token list from actual events — always current, no hardcoding
  const tokenList = useMemo(()=>{
    const seen = new Set<string>();
    whales.forEach(a=>{ if(a.token) seen.add(a.token); });
    return ["All", ...Array.from(seen).sort()];
  },[whales]);

  // USD totals — use windowed whales so KPIs respond to time filter
  const totalVolUSD = useMemo(()=>{
    let sum=0; let partial=false;
    windowedWhales.forEach(a=>{
      const key=TOKEN_PRICE_MAP[a.token];
      if(key&&oraclePrices[key]?.price){sum+=num(a.amount)*oraclePrices[key].price;}
      else partial=true;
    });
    return {sum,partial};
  },[windowedWhales,oraclePrices]);

  const largestUSD = useMemo(()=>{
    if(!windowedWhales.length) return null;
    const top=windowedWhales.reduce((max,a)=>num(a.amount)>num(max.amount)?a:max,windowedWhales[0]);
    const key=TOKEN_PRICE_MAP[top.token];
    if(!key||!oraclePrices[key]?.price) return null;
    return num(top.amount)*oraclePrices[key].price;
  },[windowedWhales,oraclePrices]);

  // ── Burst detection (≥3 whale events in 60s) ─────────────────────────────
  const burst: Burst = useMemo(()=>{
    const WINDOW=60_000, MIN=3;
    const now=Date.now();
    const recent=whales.filter(a=>now-a.timestamp<WINDOW);
    if(recent.length<MIN) return null;
    const vol=recent.reduce((s,a)=>s+num(a.amount),0);
    const oldest=Math.min(...recent.map(a=>a.timestamp));
    const tkCounts:Record<string,number>={};
    recent.forEach(a=>{tkCounts[a.token]=(tkCounts[a.token]||0)+1;});
    const dominantToken=Object.entries(tkCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]??"";
    return {count:recent.length,volume:vol,windowSec:Math.round((now-oldest)/1000),dominantToken,tokenBreakdown:tkCounts};
  },[whales]);

  const filtered=useMemo(()=>{
    const now=Date.now();
    const from=dateFrom?new Date(dateFrom).getTime():timePreset>0?now-timePreset:0;
    const to=dateTo?new Date(dateTo).getTime():now;
    return alerts.filter(a=>{
      if(!showTypes.includes(a.type))return false;
      if(a.timestamp<from||a.timestamp>to)return false;
      if(search&&!a.from.toLowerCase().includes(search.toLowerCase())&&!a.to.toLowerCase().includes(search.toLowerCase()))return false;
      if(tokenFilter!=="All"&&a.token!==tokenFilter&&a.type==="whale")return false;
      if(minAmt&&a.type==="whale"&&num(a.amount)<parseFloat(minAmt))return false;
      if(maxAmt&&a.type==="whale"&&num(a.amount)>parseFloat(maxAmt))return false;
      return true;
    });
  },[alerts,search,minAmt,maxAmt,tokenFilter,timePreset,dateFrom,dateTo,showTypes]);

  async function simulateWhale(){setSimulating(true);try{const res=await fetch("/api/simulate-whale",{method:"POST"});const d=await res.json();if(!d.success)throw new Error(d.error);}catch(e){alert("Simulation failed: "+e);}finally{setSimulating(false);}}

  const allTabs=[
    {key:"feed",        label:"⚡ Live Feed"},
    {key:"analytics",   label:"📈 Analytics"},
    {key:"charts",      label:"📊 Charts"},
    {key:"leaderboard", label:"🏆 Leaderboard"},
    {key:"flow",        label:"🔀 Token Flow"},
    {key:"howto",       label:"ℹ How It Works"},
    ...(isConnected?[{key:"mywallet",label:"💛 My Wallet"}]:[]),
  ] as const;

  const btn:React.CSSProperties={fontSize:11,fontFamily:"monospace",padding:"7px 13px",borderRadius:8,cursor:"pointer",transition:"all 0.15s",fontWeight:600,whiteSpace:"nowrap"};
  const showFilters=tab==="feed"||tab==="flow"||tab==="leaderboard";

  return(<div style={{height:"100vh",display:"flex",flexDirection:"column",background:t.pageBg,color:t.text,overflow:"hidden"}}>
    <style>{`
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
      @keyframes burstPulse{0%,100%{box-shadow:0 0 0 0 rgba(249,115,22,0.15)}50%{box-shadow:0 0 0 10px rgba(249,115,22,0)}}
      input,select{color-scheme:${theme==="dark"?"dark":"light"}}
      ::-webkit-scrollbar{width:5px;height:5px}
      ::-webkit-scrollbar-thumb{background:rgba(6,182,212,0.25);border-radius:3px}
    `}</style>

    {/* Header */}
    <div style={{background:t.headerBg,borderBottom:`1px solid ${t.border}`,backdropFilter:"blur(12px)",flexShrink:0,zIndex:10}}>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"12px 20px"}}>
        <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:26}}>🐋</span>
            <div>
              <h1 style={{fontSize:18,fontWeight:700,color:t.accent,fontFamily:"monospace",letterSpacing:"0.1em",margin:0}}>WHALE TRACKER</h1>
              <p style={{color:t.muted,fontSize:9,letterSpacing:"0.2em",textTransform:"uppercase",margin:0,fontFamily:"monospace"}}>Somnia Reactivity · Phase 1 + 2 + 3</p>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
            <ConnectButton showBalance={false} chainStatus="none" accountStatus="address"/>
            <button onClick={()=>setTheme(v=>v==="dark"?"light":"dark")} style={{...btn,background:t.accentBg,color:t.accent,border:`1px solid ${t.border}`}}>{theme==="dark"?"☀":"🌙"}</button>
            <button onClick={()=>setSoundEnabled(v=>!v)} style={{...btn,background:soundEnabled?t.accentBg:"transparent",color:soundEnabled?t.accent:t.muted,border:`1px solid ${soundEnabled?t.accent:t.border}`}}>{soundEnabled?"🔊":"🔇"}</button>
            <button onClick={()=>downloadCSV(filtered)} disabled={filtered.length===0} style={{...btn,background:"transparent",color:t.muted,border:`1px solid ${t.border}`,opacity:filtered.length===0?0.4:1}}>↓ CSV</button>
            <button onClick={simulateWhale} disabled={simulating} style={{...btn,background:t.accentBg,color:t.accent,border:`1px solid ${t.accent}`,opacity:simulating?0.6:1}}>{simulating?"⏳":"⚡ SIMULATE"}</button>
            <div style={{display:"flex",alignItems:"center",gap:7,padding:"7px 12px",borderRadius:8,background:t.card,border:`1px solid ${t.border}`}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:connected?"#4ade80":"#f87171",animation:connected?"pulse 2s infinite":"none"}}/>
              <span style={{fontSize:10,fontFamily:"monospace",color:t.subtext}}>{connected?"LIVE":"CONNECTING"}</span>
            </div>
          </div>
        </div>

        {/* Global KPI row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:8,marginBottom:12}}>
          <KpiCard t={t} label="Whale Events"     value={windowedWhales.length}/>
          <KpiCard t={t} label="Reactions"         value={windowedReactions.length}   sub="Phase 2"/>
          <KpiCard t={t} label="Alerts"            value={windowedAlertCount}          sub="Phase 2"/>
          <KpiCard t={t} label="🔥 Momentum"       value={windowedMomentumCount}       color="#ef4444" sub="on-chain bursts"/>
          <KpiCard t={t} label="🐋 Whale Volume"
            value={totalVolUSD.sum>0 ? (totalVolUSD.sum>=1e9?`$${(totalVolUSD.sum/1e9).toFixed(2)}B`:totalVolUSD.sum>=1e6?`$${(totalVolUSD.sum/1e6).toFixed(2)}M`:`$${Math.round(totalVolUSD.sum).toLocaleString()}`) : Math.round(windowedVol).toLocaleString()}
            sub={totalVolUSD.sum>0 ? (totalVolUSD.partial?"~USD partial":"~USD est.") : "tokens"}/>
          <KpiCard t={t} label="🐋 Whale Largest"
            value={largestUSD!=null ? (largestUSD>=1e9?`$${(largestUSD/1e9).toFixed(2)}B`:largestUSD>=1e6?`$${(largestUSD/1e6).toFixed(2)}M`:`$${Math.round(largestUSD).toLocaleString()}`) : windowedLargest>0?Math.round(windowedLargest).toLocaleString():"—"}
            sub={largestUSD!=null?"~USD est.":"tokens"}/>
          <KpiCard t={t} label="🌐 Network Txns"    value={windowedBlockTxs.length>0?windowedBlockTxs.length.toLocaleString():"—"} sub={timePreset>0?`last ${TIME_PRESETS.find(p=>p.ms===timePreset)?.label}`:"buffered window"}/>
          <KpiCard t={t} label="🌐 Largest STT Txn" value={networkLargestSTT>0?`${Number(networkLargestSTT).toFixed(4)}`:"—"} sub="STT (native)"/>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:2}}>
          {allTabs.map(tb=>(<button key={tb.key} onClick={()=>setTab(tb.key as any)} style={{...btn,padding:"5px 14px",background:tab===tb.key?t.accentBg:"transparent",color:tab===tb.key?t.accent:t.muted,border:`1px solid ${tab===tb.key?t.accent:"transparent"}`}}>{tb.label}</button>))}
        </div>

        {/* Live Price Ticker */}
        <PriceTicker prices={oraclePrices} loading={pricesLoading} t={t} lastFetchedAt={lastFetchedAt}/>
      </div>
    </div>

    {/* Content */}
    <div style={{flex:1,overflowY:"auto"}}>
      {error&&<div style={{background:t.errBg,border:`1px solid ${t.errBorder}`,margin:"12px 20px 0",borderRadius:10,padding:12,color:t.errText,fontSize:12,fontFamily:"monospace"}}>⚠ {error}</div>}
      <div style={{maxWidth:1400,margin:"0 auto",padding:"16px 20px"}}>
        {showFilters&&<FilterBar t={t} search={search} setSearch={setSearch} minAmt={minAmt} setMinAmt={setMinAmt} maxAmt={maxAmt} setMaxAmt={setMaxAmt} token={tokenFilter} setToken={setTokenFilter} timePreset={timePreset} setTimePreset={setTimePreset} dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} showTypes={showTypes} setShowTypes={setShowTypes} tokenList={tokenList}/>}
        <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,overflow:"hidden"}}>
          {tab==="feed"        && <LiveFeedTab    alerts={filtered} t={t} connectedAddr={walletAddr} burst={burst} oraclePrices={oraclePrices} blockTxs={windowedBlockTxs} totalBlockTxsSeen={totalBlockTxsSeen} timePreset={timePreset}/>}
          {tab==="analytics"   && <AnalyticsTab   alerts={filtered} t={t} oraclePrices={oraclePrices}/>}
          {tab==="charts"      && <ChartsTab      alerts={filtered} t={t}/>}
          {tab==="leaderboard" && <LeaderboardTab alerts={filtered} t={t} persistedEntries={persistedEntries}/>}
          {tab==="flow"        && <TokenFlowTab   alerts={filtered} t={t}/>}
          {tab==="howto"       && (
            <div style={{padding:24}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))",gap:16,marginBottom:20}}>
                {[
                  {icon:"⛓",  color:"#06b6d4",title:"On-Chain Event",    desc:"WhaleTracker.sol emits WhaleTransfer on each reportTransfer() call above threshold."},
                  {icon:"⚡",  color:"#06b6d4",title:"Somnia Reactivity", desc:"Reactivity Engine pushes events natively — zero polling, zero indexers, zero latency."},
                  {icon:"🔍",  color:"#a855f7",title:"Handler Contract",  desc:"WhaleHandler._onEvent() called by precompile 0x0100. Emits ReactedToWhaleTransfer on-chain."},
                  {icon:"💾",  color:"#4ade80",title:"Data Streams",      desc:"Leaderboard persists to Somnia Data Streams on every whale event — survives server restarts."},
                  {icon:"🚨",  color:"#f97316",title:"Burst Detection",   desc:"WhaleHandler emits WhaleMomentumDetected on-chain when ≥3 transfers occur within 10 blocks. Frontend also detects independently via SSE."},
                  {icon:"💛",  color:"#4ade80",title:"Wallet Connect",    desc:"Connect wallet to see your personal transfers, net flow, and YOU badge in Live Feed."},
                ].map((s,i)=>(<div key={i} style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:12,padding:16}}><div style={{fontSize:26,marginBottom:10}}>{s.icon}</div><p style={{color:s.color,fontFamily:"monospace",fontSize:11,fontWeight:700,margin:"0 0 6px"}}>{s.title}</p><p style={{color:t.subtext,fontSize:11,lineHeight:1.7,margin:0}}>{s.desc}</p></div>))}
              </div>
              <div style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:12,padding:16}}>
                <pre style={{color:t.subtext,fontSize:11,fontFamily:"monospace",lineHeight:1.8,margin:0,whiteSpace:"pre-wrap"}}>{`WhaleTracker.sol       → emits WhaleTransfer\nSomnia Reactivity       → pushes to handler (precompile 0x0100)\nWhaleHandler._onEvent() → emits ReactedToWhaleTransfer\n                        → emits AlertThresholdCrossed (every N)\n                        → emits WhaleMomentumDetected (≥3 in 10 blocks)\nFrontend burst detector → ≥3 transfers/60s → 🚨 banner\nData Streams            → persists leaderboard across restarts\nSSE stream              → 🐋 whale  ⚡ reaction  🚨 alert  🔥 momentum`}</pre>
              </div>
            </div>
          )}
          {tab==="mywallet"&&isConnected&&walletAddr&&<MyWalletTab alerts={alerts} connectedAddr={walletAddr} t={t}/>}
          {tab==="mywallet"&&!isConnected&&<div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>Connect your wallet to view your transactions.</div>}
        </div>
        <div style={{marginTop:14,display:"flex",justifyContent:"space-between",color:t.muted,fontSize:10,fontFamily:"monospace"}}>
          <span>Contract: <a href={addrUrl(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS||"")} target="_blank" rel="noreferrer" style={{color:t.accent,textDecoration:"none"}}>{short(process.env.NEXT_PUBLIC_CONTRACT_ADDRESS||"0x0000000000000000000000000000000000000000")}</a></span>
          <span>Somnia Testnet · Chain ID 50312</span>
        </div>
      </div>
    </div>
  </div>);}
