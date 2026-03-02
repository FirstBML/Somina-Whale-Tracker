"use client";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWhaleAlerts, WhaleAlert } from "../lib/useWhaleAlerts";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";

type Theme = "dark" | "light";
const T = {
  dark:  { pageBg:"#050d1a",headerBg:"#070f1eee",card:"#0a1628",border:"rgba(6,182,212,0.2)",text:"#e2f8ff",subtext:"#67b8cc",muted:"rgba(103,184,204,0.4)",accent:"#06b6d4",accentBg:"rgba(6,182,212,0.12)",input:"#05111f",chartGrid:"#0e2a3a",chartAxis:"#2a7a90",tooltipBg:"#060e1c",tooltipBorder:"#0e4f5e",rowHover:"rgba(6,182,212,0.06)",errBg:"rgba(127,29,29,0.3)",errBorder:"rgba(185,28,28,0.4)",errText:"#f87171",statVal:"#67e8f9",tableHead:"#071322",tableRow:"#0a1628",tableAlt:"#0c1a30",badgeBg:"rgba(6,182,212,0.15)",badgeText:"#67e8f9",reactionRow:"rgba(168,85,247,0.08)",alertRow:"rgba(251,146,60,0.08)",myTxRow:"rgba(74,222,128,0.08)" },
  light: { pageBg:"#f0f9ff",headerBg:"#dbeafedd",card:"#ffffff",border:"rgba(3,105,161,0.2)",text:"#0a2540",subtext:"#0369a1",muted:"rgba(3,105,161,0.5)",accent:"#0284c7",accentBg:"rgba(2,132,199,0.1)",input:"#e0f2fe",chartGrid:"#bae6fd",chartAxis:"#0369a1",tooltipBg:"#ffffff",tooltipBorder:"#7dd3fc",rowHover:"rgba(2,132,199,0.06)",errBg:"rgba(254,226,226,0.9)",errBorder:"rgba(239,68,68,0.4)",errText:"#b91c1c",statVal:"#0c4a6e",tableHead:"#e0f2fe",tableRow:"#ffffff",tableAlt:"#f0f9ff",badgeBg:"rgba(2,132,199,0.12)",badgeText:"#0369a1",reactionRow:"rgba(168,85,247,0.06)",alertRow:"rgba(234,88,12,0.06)",myTxRow:"rgba(22,163,74,0.06)" },
};
const TOKEN_COLORS:Record<string,string>={STT:"#06b6d4",USDC:"#2775CA",WETH:"#627EEA",WBTC:"#F7931A",USDT:"#26A17B",LINK:"#2A5ADA",UNI:"#FF007A",AAVE:"#B6509E"};
const ALL_TOKENS=["All","STT","USDC","WETH","WBTC","USDT","LINK","UNI","AAVE"];
const TIME_PRESETS=[{label:"30m",ms:30*60_000},{label:"1h",ms:60*60_000},{label:"6h",ms:6*60*60_000},{label:"24h",ms:24*60*60_000},{label:"All",ms:0}];
const short=(a:string)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"—";
const shortHash=(h:string)=>h?`${h.slice(0,10)}…${h.slice(-6)}`:"—";
const addrUrl=(a:string)=>`https://shannon-explorer.somnia.network/address/${a}`;
const txUrl=(h:string)=>`https://shannon-explorer.somnia.network/tx/${h}`;
const num=(s:string)=>parseFloat((s??"0").replace(/,/g,""))||0;
function timeAgo(ts:number){const d=Math.floor((Date.now()-ts)/1000);if(d<60)return`${d}s ago`;if(d<3600)return`${Math.floor(d/60)}m ago`;return`${Math.floor(d/3600)}h ago`;}
function fmtTime(ts:number){return new Date(ts).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function playPing(){try{const ctx=new((window as any).AudioContext||(window as any).webkitAudioContext)();const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.setValueAtTime(880,ctx.currentTime);o.frequency.exponentialRampToValueAtTime(440,ctx.currentTime+0.3);g.gain.setValueAtTime(0.3,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4);o.start();o.stop(ctx.currentTime+0.4);}catch{}}
function downloadCSV(alerts:WhaleAlert[]){const rows=["type,timestamp,from,to,amount_tokens,token,tx_hash,block_number,reaction_count",...alerts.map(a=>`${a.type},${new Date(a.timestamp).toISOString()},${a.from},${a.to},${a.amount},${a.token},${a.txHash},${a.blockNumber},${a.reactionCount??""}`)];const blob=new Blob([rows.join("\n")],{type:"text/csv"});const url=URL.createObjectURL(blob);const el=document.createElement("a");el.href=url;el.download="whale_alerts.csv";el.click();URL.revokeObjectURL(url);}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Badge({text,color,t}:{text:string;color?:string;t:typeof T.dark}){return<span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:color?`${color}22`:t.badgeBg,color:color??t.badgeText,border:`1px solid ${color?`${color}44`:t.border}`}}>{text}</span>;}
function TypeBadge({type,t}:{type:string;t:typeof T.dark}){const map:Record<string,{label:string;color:string}>={whale:{label:"🐋 WHALE",color:"#06b6d4"},reaction:{label:"⚡ REACTION",color:"#a855f7"},alert:{label:"🚨 ALERT",color:"#f97316"}};const m=map[type]??map.whale;return<span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:`${m.color}22`,color:m.color,border:`1px solid ${m.color}44`,whiteSpace:"nowrap"}}>{m.label}</span>;}
function Th({children,t}:{children:string;t:typeof T.dark}){return<th style={{padding:"9px 12px",textAlign:"left",color:t.muted,fontSize:9,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"monospace",borderBottom:`1px solid ${t.border}`,background:t.tableHead,whiteSpace:"nowrap"}}>{children}</th>;}
function Td({children,t,bold,accent,color}:{children:React.ReactNode;t:typeof T.dark;bold?:boolean;accent?:boolean;color?:string}){return<td style={{padding:"10px 12px",color:color??(accent?t.accent:t.text),fontFamily:"monospace",fontSize:11,fontWeight:bold?700:400,borderBottom:`1px solid ${t.border}`,whiteSpace:"nowrap"}}>{children}</td>;}
function ExLink({href,label,t}:{href:string;label:string;t:typeof T.dark}){if(!href)return<span style={{color:t.muted,fontFamily:"monospace",fontSize:11}}>—</span>;return(<a href={href} target="_blank" rel="noreferrer" style={{color:t.subtext,textDecoration:"none",fontFamily:"monospace",fontSize:11,display:"inline-flex",alignItems:"center",gap:3}} onMouseEnter={e=>(e.currentTarget.style.color=t.accent)} onMouseLeave={e=>(e.currentTarget.style.color=t.subtext)}>{label}<span style={{fontSize:9,opacity:0.6}}>↗</span></a>);}
function KpiCard({label,value,sub,color,t}:{label:string;value:string|number;sub?:string;color?:string;t:typeof T.dark}){return(<div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 16px"}}><p style={{color:t.muted,fontSize:9,textTransform:"uppercase",letterSpacing:"0.15em",fontFamily:"monospace",margin:"0 0 4px"}}>{label}</p><p style={{color:color??t.statVal,fontSize:18,fontWeight:700,fontFamily:"monospace",margin:0}}>{value}</p>{sub&&<p style={{color:t.muted,fontSize:9,margin:"2px 0 0",fontFamily:"monospace"}}>{sub}</p>}</div>);}

// ── Filter Bar ────────────────────────────────────────────────────────────────
function FilterBar({t,search,setSearch,minAmt,setMinAmt,maxAmt,setMaxAmt,token,setToken,timePreset,setTimePreset,dateFrom,setDateFrom,dateTo,setDateTo,showTypes,setShowTypes}:{t:typeof T.dark;search:string;setSearch:(v:string)=>void;minAmt:string;setMinAmt:(v:string)=>void;maxAmt:string;setMaxAmt:(v:string)=>void;token:string;setToken:(v:string)=>void;timePreset:number;setTimePreset:(v:number)=>void;dateFrom:string;setDateFrom:(v:string)=>void;dateTo:string;setDateTo:(v:string)=>void;showTypes:string[];setShowTypes:(v:string[])=>void}){
  const inp:React.CSSProperties={background:t.input,border:`1px solid ${t.border}`,borderRadius:7,padding:"7px 10px",fontSize:11,fontFamily:"monospace",color:t.text,outline:"none",width:"100%",boxSizing:"border-box"};
  const lbl:React.CSSProperties={color:t.subtext,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.1em",display:"block",marginBottom:4};
  const toggleType=(type:string)=>setShowTypes(showTypes.includes(type)?showTypes.filter(x=>x!==type):[...showTypes,type]);
  return(<div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:16,marginBottom:14}}>
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",margin:"0 0 12px"}}>Filters</p>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10}}>
      <div><label style={lbl}>Wallet</label><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="0x..." style={inp}/></div>
      <div><label style={lbl}>Token</label><select value={token} onChange={e=>setToken(e.target.value)} style={{...inp,cursor:"pointer"}}>{ALL_TOKENS.map(tk=><option key={tk}>{tk}</option>)}</select></div>
      <div><label style={lbl}>Min Amount</label><input type="number" value={minAmt} onChange={e=>setMinAmt(e.target.value)} placeholder="0" style={inp}/></div>
      <div><label style={lbl}>Max Amount</label><input type="number" value={maxAmt} onChange={e=>setMaxAmt(e.target.value)} placeholder="∞" style={inp}/></div>
      <div><label style={lbl}>Date From</label><input type="datetime-local" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={inp}/></div>
      <div><label style={lbl}>Date To</label><input type="datetime-local" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={inp}/></div>
    </div>
    <div style={{display:"flex",gap:6,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{color:t.muted,fontSize:9,fontFamily:"monospace"}}>TYPE:</span>
      {[{key:"whale",label:"🐋 Whale",color:"#06b6d4"},{key:"reaction",label:"⚡ Reaction",color:"#a855f7"},{key:"alert",label:"🚨 Alert",color:"#f97316"}].map(({key,label,color})=>(
        <button key={key} onClick={()=>toggleType(key)} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",background:showTypes.includes(key)?`${color}22`:"transparent",color:showTypes.includes(key)?color:t.muted,border:`1px solid ${showTypes.includes(key)?`${color}66`:"transparent"}`}}>{label}</button>
      ))}
      <span style={{color:t.muted,fontSize:9,fontFamily:"monospace",marginLeft:8}}>QUICK:</span>
      {TIME_PRESETS.map(p=>(<button key={p.label} onClick={()=>{setTimePreset(p.ms);setDateFrom("");setDateTo("");}} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",background:timePreset===p.ms?t.accentBg:"transparent",color:timePreset===p.ms?t.accent:t.muted,border:`1px solid ${timePreset===p.ms?t.accent:"transparent"}`}}>{p.label}</button>))}
      <button onClick={()=>{setSearch("");setMinAmt("");setMaxAmt("");setToken("All");setTimePreset(0);setDateFrom("");setDateTo("");setShowTypes(["whale","reaction","alert"]);}} style={{fontSize:10,fontFamily:"monospace",padding:"3px 10px",borderRadius:6,cursor:"pointer",color:t.errText,background:"transparent",border:"1px solid transparent",marginLeft:"auto"}}>✕ Clear</button>
    </div>
  </div>);}

// ── Live Feed Tab ─────────────────────────────────────────────────────────────
function LiveFeedTab({alerts,t,connectedAddr}:{alerts:WhaleAlert[];t:typeof T.dark;connectedAddr?:string}){
  const[expanded,setExpanded]=useState<string|null>(null);
  if(!alerts.length)return<div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>Waiting for activity...</div>;
  function rowBg(a:WhaleAlert,i:number){
    const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());
    if(isMyTx)return t.myTxRow;
    if(a.type==="reaction")return i%2===0?t.reactionRow:`${t.reactionRow}cc`;
    if(a.type==="alert")return i%2===0?t.alertRow:`${t.alertRow}cc`;
    return i%2===0?t.tableRow:t.tableAlt;
  }
  return(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
    <thead><tr>{["Type","Token","Amount","From","To","TX Hash","Block","Time",""].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
    <tbody>{alerts.map((a,i)=>{
      const isMyTx=connectedAddr&&(a.from.toLowerCase()===connectedAddr.toLowerCase()||a.to.toLowerCase()===connectedAddr.toLowerCase());
      return(<>
        <tr key={a.id} style={{background:rowBg(a,i),cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=rowBg(a,i))}>
          <Td t={t}><div style={{display:"flex",gap:4,alignItems:"center"}}><TypeBadge type={a.type} t={t}/>{isMyTx&&<span style={{fontSize:8,background:"rgba(74,222,128,0.2)",color:"#4ade80",border:"1px solid rgba(74,222,128,0.4)",borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>YOU</span>}</div></Td>
          <Td t={t}>{a.token?<Badge text={a.token} color={TOKEN_COLORS[a.token]} t={t}/>:<span style={{color:t.muted,fontSize:11}}>—</span>}</Td>
          <Td t={t} accent bold>{a.type==="whale"?num(a.amount).toLocaleString():<span style={{color:t.muted}}>—</span>}</Td>
          <Td t={t}><ExLink href={a.from?addrUrl(a.from):""} label={a.from?short(a.from):"—"} t={t}/></Td>
          <Td t={t}><ExLink href={a.to?addrUrl(a.to):""} label={a.to?short(a.to):"—"} t={t}/></Td>
          <Td t={t}><ExLink href={a.txHash?txUrl(a.txHash):""} label={shortHash(a.txHash)} t={t}/></Td>
          <Td t={t}><span style={{color:t.subtext,fontSize:11}}>{a.blockNumber||"—"}</span></Td>
          <Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(a.timestamp)}</span></Td>
          <td style={{padding:"10px 12px",borderBottom:`1px solid ${t.border}`}}><button onClick={()=>setExpanded(expanded===a.id?null:a.id)} style={{fontSize:9,fontFamily:"monospace",padding:"2px 8px",borderRadius:4,cursor:"pointer",background:t.accentBg,color:t.accent,border:`1px solid ${t.border}`}}>{expanded===a.id?"▲":"▼"}</button></td>
        </tr>
        {expanded===a.id&&(<tr key={`${a.id}-exp`} style={{background:t.accentBg}}><td colSpan={9} style={{padding:"12px 16px",borderBottom:`1px solid ${t.border}`}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))",gap:12,fontFamily:"monospace",fontSize:11}}>
            <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Full TX Hash</span><div style={{marginTop:4}}><ExLink href={txUrl(a.txHash)} label={a.txHash||"—"} t={t}/></div></div>
            {a.type==="whale"&&<><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>From</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.from)} label={a.from} t={t}/></div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>To</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.to)} label={a.to} t={t}/></div></div><div><span style={{color:t.accent,fontWeight:700,marginTop:4,fontSize:9,textTransform:"uppercase"}}>Amount</span><div style={{color:t.accent,fontWeight:700,marginTop:4}}>{num(a.amount).toLocaleString()} <span style={{color:t.muted}}>{a.token}</span></div></div></>}
            {a.type==="reaction"&&<><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Reaction #</span><div style={{color:"#a855f7",fontWeight:700,marginTop:4}}>{a.reactionCount}</div></div><div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Handler Emitter</span><div style={{marginTop:4}}><ExLink href={addrUrl(a.handlerEmitter??"")} label={short(a.handlerEmitter??"")} t={t}/></div></div></>}
            {a.type==="alert"&&<div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Alert At Reaction</span><div style={{color:"#f97316",fontWeight:700,marginTop:4}}>#{a.reactionCount}</div></div>}
            <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Block</span><div style={{color:t.text,marginTop:4}}>{a.blockNumber||"—"}</div></div>
            <div><span style={{color:t.muted,fontSize:9,textTransform:"uppercase"}}>Timestamp</span><div style={{color:t.text,marginTop:4}}>{fmtTime(a.timestamp)}</div></div>
          </div>
        </td></tr>)}
      </>);
    })}</tbody>
  </table></div>);}

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
      <span style={{fontSize:20}}>👛</span>
      <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",margin:0}}>Connected Wallet</p><p style={{color:t.accent,fontFamily:"monospace",fontSize:12,fontWeight:700,margin:0}}>{connectedAddr}</p></div>
      <a href={addrUrl(connectedAddr)} target="_blank" rel="noreferrer" style={{marginLeft:"auto",fontSize:10,color:t.accent,fontFamily:"monospace",textDecoration:"none"}}>View on Explorer ↗</a>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:10,marginBottom:24}}>
      <KpiCard t={t} label="My Transfers" value={myTxns.length}/>
      <KpiCard t={t} label="My Volume" value={Math.round(myVolume).toLocaleString()} sub="tokens"/>
      <KpiCard t={t} label="Net Flow" value={(netFlow>=0?"+":"")+Math.round(netFlow).toLocaleString()} color={netFlow>=0?"#4ade80":"#f87171"} sub={netFlow>=0?"net inflow":"net outflow"}/>
      <KpiCard t={t} label="Sent / Received" value={`${mySent.length} / ${myReceived.length}`} sub="transactions"/>
    </div>

    {!myTxns.length
      ? <div style={{padding:48,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:13}}>No whale transactions found for this wallet.</div>
      : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{["Direction","Token","Amount","Counterparty","TX Hash","Block","Time"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
          <tbody>{myTxns.map((a,i)=>{
            const isSender=a.from.toLowerCase()===connectedAddr.toLowerCase();
            const counterparty=isSender?a.to:a.from;
            return(<tr key={a.id} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}>
              <Td t={t}><span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,padding:"2px 8px",borderRadius:4,background:isSender?"rgba(248,113,113,0.15)":"rgba(74,222,128,0.15)",color:isSender?"#f87171":"#4ade80",border:`1px solid ${isSender?"rgba(248,113,113,0.3)":"rgba(74,222,128,0.3)"}`}}>{isSender?"↑ SENT":"↓ RECV"}</span></Td>
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

// ── Analytics Tab (new KPIs not previously built) ─────────────────────────────
function AnalyticsTab({alerts,t}:{alerts:WhaleAlert[];t:typeof T.dark}){
  const whales=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);

  const uniqueWallets=useMemo(()=>new Set([...whales.map(a=>a.from),...whales.map(a=>a.to)]).size,[whales]);
  const totalVol=useMemo(()=>whales.reduce((s,a)=>s+num(a.amount),0),[whales]);
  const avgSize=whales.length>0?totalVol/whales.length:0;

  // Whale activity rate (last 60 min)
  const activityRate=useMemo(()=>{
    const cutoff=Date.now()-60*60_000;
    return whales.filter(a=>a.timestamp>cutoff).length;
  },[whales]);

  // Whale concentration: % volume by top 5 senders
  const concentration=useMemo(()=>{
    const vol:Record<string,number>={};
    whales.forEach(a=>{vol[a.from]=(vol[a.from]||0)+num(a.amount);});
    const sorted=Object.values(vol).sort((a,b)=>b-a);
    const top5=sorted.slice(0,5).reduce((s,v)=>s+v,0);
    return totalVol>0?Math.round((top5/totalVol)*100):0;
  },[whales,totalVol]);

  // Net flow per wallet (top 10 by absolute net)
  const netFlows=useMemo(()=>{
    const inflow:Record<string,number>={};
    const outflow:Record<string,number>={};
    whales.forEach(a=>{
      inflow[a.to]=(inflow[a.to]||0)+num(a.amount);
      outflow[a.from]=(outflow[a.from]||0)+num(a.amount);
    });
    const wallets=new Set([...Object.keys(inflow),...Object.keys(outflow)]);
    return Array.from(wallets).map(w=>({
      wallet:w,
      net:(inflow[w]||0)-(outflow[w]||0),
      inflow:inflow[w]||0,
      outflow:outflow[w]||0,
    })).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)).slice(0,10);
  },[whales]);

  // Volume by minute (momentum)
  const minuteData=useMemo(()=>{
    const b:Record<string,number>={};
    whales.forEach(a=>{const k=new Date(a.timestamp).toISOString().slice(0,16);b[k]=(b[k]||0)+num(a.amount);});
    return Object.entries(b).slice(-30).map(([time,volume])=>({time:time.slice(11),volume:Math.round(volume)}));
  },[whales]);

  const tt={contentStyle:{background:t.tooltipBg,border:`1px solid ${t.tooltipBorder}`,borderRadius:8,fontFamily:"monospace",fontSize:11},labelStyle:{color:t.accent},itemStyle:{color:t.text}};

  return(<div style={{padding:24}}>
    {/* KPI row */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))",gap:10,marginBottom:28}}>
      <KpiCard t={t} label="Unique Wallets" value={uniqueWallets}/>
      <KpiCard t={t} label="Avg Transfer Size" value={Math.round(avgSize).toLocaleString()} sub="tokens"/>
      <KpiCard t={t} label="Activity Rate" value={activityRate} sub="txns / last hour"/>
      <KpiCard t={t} label="Whale Concentration" value={`${concentration}%`} sub="top 5 wallets control" color={concentration>70?"#f97316":t.statVal}/>
    </div>

    {/* Momentum chart */}
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:14}}>Whale Volume Momentum (per minute)</p>
    {!minuteData.length
      ? <div style={{height:140,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12,marginBottom:28}}>No data</div>
      : <div style={{marginBottom:28}}><ResponsiveContainer width="100%" height={140}>
        <AreaChart data={minuteData}><defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={4}/><YAxis tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#mg)"/></AreaChart>
        </ResponsiveContainer></div>
    }

    {/* Net Flow table */}
    <p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:14}}>Net Flow per Wallet (inflow − outflow)</p>
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
      {!volData.length?<div style={{height:160,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No whale data</div>:<ResponsiveContainer width="100%" height={200}><AreaChart data={volData}><defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={t.accent} stopOpacity={0.3}/><stop offset="95%" stopColor={t.accent} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid}/><XAxis dataKey="time" tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><YAxis tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><Tooltip {...tt}/><Area type="monotone" dataKey="volume" stroke={t.accent} strokeWidth={2} fill="url(#vg)"/></AreaChart></ResponsiveContainer>}
    </div>
    <div><p style={{color:t.muted,fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:16}}>Activity Heatmap by Hour</p>
      <ResponsiveContainer width="100%" height={160}><BarChart data={heatData} barSize={10}><CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false}/><XAxis dataKey="hour" tick={{fill:t.chartAxis,fontSize:9,fontFamily:"monospace"}} interval={3}/><YAxis tick={{fill:t.chartAxis,fontSize:10,fontFamily:"monospace"}}/><Tooltip {...tt}/><Bar dataKey="count" radius={[3,3,0,0]}>{heatData.map((_,i)=><Cell key={i} fill={t.accent}/>)}</Bar></BarChart></ResponsiveContainer>
    </div>
    {reactionData.length>0&&<div><p style={{color:"#a855f7",fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.15em",marginBottom:16}}>⚡ Handler Reactions Over Time (Phase 2)</p>
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
        {[{key:"live",label:"Live (session)"},{key:"persistent",label:"💾 Persistent (Streams)"}].map(({key,label})=>(<button key={key} onClick={()=>setSource(key as "live"|"persistent")} style={{fontSize:10,fontFamily:"monospace",padding:"4px 10px",borderRadius:6,cursor:"pointer",background:source===key?t.accentBg:"transparent",color:source===key?t.accent:t.muted,border:`1px solid ${source===key?t.accent:"transparent"}`}}>{label}</button>))}
      </div>
    </div>

    {source==="persistent"
      ? persistedEntries.length===0
        ? <div style={{padding:32,textAlign:"center",color:t.muted,fontFamily:"monospace",fontSize:12}}>No persistent data yet. Data Streams leaderboard populates as whale transfers occur.</div>
        : <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["#","Wallet","Total Volume","Txns","Last Seen"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
            <tbody>{persistedEntries.slice(0,10).map(({wallet,totalVolume,txCount,lastSeen},i)=>(<tr key={wallet} style={{background:i%2===0?t.tableRow:t.tableAlt}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(wallet)} label={short(wallet)} t={t}/></Td><Td t={t} bold accent>{Number(totalVolume).toLocaleString()}</Td><Td t={t}>{txCount}</Td><Td t={t}><span style={{color:t.muted,fontSize:10}}>{timeAgo(lastSeen)}</span></Td></tr>))}</tbody>
          </table>
      : !liveTop.length
        ? <p style={{color:t.muted,fontFamily:"monospace",fontSize:13,textAlign:"center",padding:32}}>No data</p>
        : <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["#","Address","Volume","Txns","Tokens","Share"].map(h=><Th key={h} t={t}>{h}</Th>)}</tr></thead>
            <tbody>{liveTop.map(([addr,{count,volume,tokens}],i)=>(<tr key={addr} style={{background:i%2===0?t.tableRow:t.tableAlt,transition:"background 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.background=t.rowHover)} onMouseLeave={e=>(e.currentTarget.style.background=i%2===0?t.tableRow:t.tableAlt)}><Td t={t}>{i+1}</Td><Td t={t}><ExLink href={addrUrl(addr)} label={short(addr)} t={t}/></Td><Td t={t} bold accent>{Math.round(volume).toLocaleString()}</Td><Td t={t}>{count}</Td><Td t={t}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{Array.from(tokens).map(tk=><Badge key={tk} text={tk} color={TOKEN_COLORS[tk]} t={t}/>)}</div></Td><Td t={t}><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:60,height:4,background:t.border,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(volume/maxVol)*100}%`,background:t.accent}}/></div><span style={{color:t.muted,fontSize:10}}>{Math.round((volume/maxVol)*100)}%</span></div></Td></tr>))}</tbody>
          </table>
    }
  </div>);}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function WhaleDashboard(){
  const{alerts,connected,error}=useWhaleAlerts();
  const{address:walletAddr,isConnected}=useAccount();
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
  const[showTypes,setShowTypes]=useState<string[]>(["whale","reaction","alert"]);
  const[persistedEntries,setPersistedEntries]=useState<any[]>([]);
  const t=T[theme];

  // Load persistent leaderboard from Data Streams
  useEffect(()=>{
    fetch("/api/streams-leaderboard")
      .then(r=>r.json())
      .then(d=>{ if(d.entries?.length) setPersistedEntries(d.entries); })
      .catch(()=>{});
  },[]);

  const prevLen=useRef(0);
  useEffect(()=>{if(alerts.length>prevLen.current&&soundEnabled&&prevLen.current>0)playPing();prevLen.current=alerts.length;},[alerts.length,soundEnabled]);

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

  const whales=useMemo(()=>alerts.filter(a=>a.type==="whale"),[alerts]);
  const reactions=useMemo(()=>alerts.filter(a=>a.type==="reaction"),[alerts]);
  const totalVol=useMemo(()=>whales.reduce((s,a)=>s+num(a.amount),0),[whales]);

  async function simulateWhale(){setSimulating(true);try{const res=await fetch("/api/simulate-whale",{method:"POST"});const d=await res.json();if(!d.success)throw new Error(d.error);}catch(e){alert("Simulation failed: "+e);}finally{setSimulating(false);}}

  const allTabs=[
    {key:"feed",        label:"⚡ Live Feed"},
    {key:"analytics",   label:"📈 Analytics"},
    {key:"charts",      label:"📊 Charts"},
    {key:"leaderboard", label:"🏆 Leaderboard"},
    {key:"flow",        label:"🔀 Token Flow"},
    {key:"howto",       label:"ℹ How It Works"},
    ...(isConnected?[{key:"mywallet",label:"👛 My Wallet"}]:[]),
  ] as const;

  const btn:React.CSSProperties={fontSize:11,fontFamily:"monospace",padding:"7px 13px",borderRadius:8,cursor:"pointer",transition:"all 0.15s",fontWeight:600,whiteSpace:"nowrap"};
  const showFilters=tab==="feed"||tab==="flow"||tab==="leaderboard";

  return(<div style={{height:"100vh",display:"flex",flexDirection:"column",background:t.pageBg,color:t.text,overflow:"hidden"}}>
    <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}input,select{color-scheme:${theme==="dark"?"dark":"light"}}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:rgba(6,182,212,0.25);border-radius:3px}`}</style>

    <div style={{background:t.headerBg,borderBottom:`1px solid ${t.border}`,backdropFilter:"blur(12px)",flexShrink:0,zIndex:10}}>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"12px 20px"}}>
        <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{fontSize:26}}>🐋</span><div><h1 style={{fontSize:18,fontWeight:700,color:t.accent,fontFamily:"monospace",letterSpacing:"0.1em",margin:0}}>WHALE TRACKER</h1><p style={{color:t.muted,fontSize:9,letterSpacing:"0.2em",textTransform:"uppercase",margin:0,fontFamily:"monospace"}}>Somnia Reactivity · Phase 1 + 2 + 3</p></div></div>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
            {/* RainbowKit ConnectButton */}
            <ConnectButton showBalance={false} chainStatus="none" accountStatus="address"/>
            <button onClick={()=>setTheme(v=>v==="dark"?"light":"dark")} style={{...btn,background:t.accentBg,color:t.accent,border:`1px solid ${t.border}`}}>{theme==="dark"?"☀":"🌙"}</button>
            <button onClick={()=>setSoundEnabled(v=>!v)} style={{...btn,background:soundEnabled?t.accentBg:"transparent",color:soundEnabled?t.accent:t.muted,border:`1px solid ${soundEnabled?t.accent:t.border}`}}>{soundEnabled?"🔊":"🔇"}</button>
            <button onClick={()=>downloadCSV(filtered)} disabled={filtered.length===0} style={{...btn,background:"transparent",color:t.muted,border:`1px solid ${t.border}`,opacity:filtered.length===0?0.4:1}}>↓ CSV</button>
            <button onClick={simulateWhale} disabled={simulating} style={{...btn,background:t.accentBg,color:t.accent,border:`1px solid ${t.accent}`,opacity:simulating?0.6:1}}>{simulating?"⏳":"⚡ SIMULATE"}</button>
            <div style={{display:"flex",alignItems:"center",gap:7,padding:"7px 12px",borderRadius:8,background:t.card,border:`1px solid ${t.border}`}}><div style={{width:7,height:7,borderRadius:"50%",background:connected?"#4ade80":"#f87171",animation:connected?"pulse 2s infinite":"none"}}/><span style={{fontSize:10,fontFamily:"monospace",color:t.subtext}}>{connected?"LIVE":"CONNECTING"}</span></div>
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(5, 1fr)",gap:8,marginBottom:12}}>
          <KpiCard t={t} label="Whale Events" value={whales.length}/>
          <KpiCard t={t} label="Handler Reactions" value={reactions.length} sub="Phase 2"/>
          <KpiCard t={t} label="Filtered" value={filtered.length}/>
          <KpiCard t={t} label="Total Volume" value={Math.round(totalVol).toLocaleString()} sub="tokens"/>
          <KpiCard t={t} label="Largest Transfer" value={whales[0]?Math.round(num(whales[0].amount)).toLocaleString():"—"} sub="tokens"/>
        </div>

        <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:2}}>
          {allTabs.map(tb=>(<button key={tb.key} onClick={()=>setTab(tb.key as any)} style={{...btn,padding:"5px 14px",background:tab===tb.key?t.accentBg:"transparent",color:tab===tb.key?t.accent:t.muted,border:`1px solid ${tab===tb.key?t.accent:"transparent"}`}}>{tb.label}</button>))}
        </div>
      </div>
    </div>

    <div style={{flex:1,overflowY:"auto"}}>
      {error&&<div style={{background:t.errBg,border:`1px solid ${t.errBorder}`,margin:"12px 20px 0",borderRadius:10,padding:12,color:t.errText,fontSize:12,fontFamily:"monospace"}}>⚠ {error}</div>}
      <div style={{maxWidth:1400,margin:"0 auto",padding:"16px 20px"}}>
        {showFilters&&<FilterBar t={t} search={search} setSearch={setSearch} minAmt={minAmt} setMinAmt={setMinAmt} maxAmt={maxAmt} setMaxAmt={setMaxAmt} token={tokenFilter} setToken={setTokenFilter} timePreset={timePreset} setTimePreset={setTimePreset} dateFrom={dateFrom} setDateFrom={setDateFrom} dateTo={dateTo} setDateTo={setDateTo} showTypes={showTypes} setShowTypes={setShowTypes}/>}
        <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,overflow:"hidden"}}>
          {tab==="feed"&&<LiveFeedTab alerts={filtered} t={t} connectedAddr={walletAddr}/>}
          {tab==="analytics"&&<AnalyticsTab alerts={filtered} t={t}/>}
          {tab==="charts"&&<ChartsTab alerts={filtered} t={t}/>}
          {tab==="leaderboard"&&<LeaderboardTab alerts={filtered} t={t} persistedEntries={persistedEntries}/>}
          {tab==="flow"&&<TokenFlowTab alerts={filtered} t={t}/>}
          {tab==="howto"&&(
            <div style={{padding:24}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))",gap:16,marginBottom:20}}>
                {[{icon:"⛓",color:"#06b6d4",title:"On-Chain Event",desc:"WhaleTracker.sol emits WhaleTransfer(from,to,amount,timestamp,token) on each whale transfer."},{icon:"⚡",color:"#06b6d4",title:"Somnia Reactivity",desc:"Somnia Reactivity Engine pushes events natively — no polling, no indexers, no bots."},{icon:"🔁",color:"#a855f7",title:"Handler Contract",desc:"WhaleHandler._onEvent() called by precompile 0x0100. Emits ReactedToWhaleTransfer on-chain."},{icon:"💾",color:"#4ade80",title:"Data Streams",desc:"Leaderboard data persists to Somnia Data Streams on every whale event. Survives server restarts."},{icon:"👛",color:"#4ade80",title:"Wallet Connect",desc:"Connect your wallet to see your personal whale transactions, net flow, and sent/received breakdown."}].map((s,i)=>(<div key={i} style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:12,padding:16}}><div style={{fontSize:26,marginBottom:10}}>{s.icon}</div><p style={{color:s.color,fontFamily:"monospace",fontSize:11,fontWeight:700,margin:"0 0 6px"}}>{s.title}</p><p style={{color:t.subtext,fontSize:11,lineHeight:1.7,margin:0}}>{s.desc}</p></div>))}
              </div>
              <div style={{background:t.pageBg,border:`1px solid ${t.border}`,borderRadius:12,padding:16}}><pre style={{color:t.subtext,fontSize:11,fontFamily:"monospace",lineHeight:1.8,margin:0,whiteSpace:"pre-wrap"}}>{`WhaleTracker.sol       → emits WhaleTransfer\nSomnia Reactivity       → pushes to handler (precompile 0x0100)\nWhaleHandler._onEvent() → emits ReactedToWhaleTransfer\nData Streams            → persists leaderboard across restarts\nWallet Connect          → personal transaction view\nSSE stream              → 🐋 whale  ⚡ reaction  🚨 alert`}</pre></div>
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
