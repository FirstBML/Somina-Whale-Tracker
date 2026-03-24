// scripts/debug-cutoff.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'whales.db'));

const BLOCK_TX_WINDOW_MS = 24 * 60 * 60 * 1000; // 86400000
const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;

console.log(`\n🔍 Cutoff analysis (24h window):`);
console.log(`   Current time: ${new Date(Date.now()).toISOString()}`);
console.log(`   Cutoff time: ${new Date(cutoff).toISOString()}`);
console.log(`   Cutoff timestamp (ms): ${cutoff}\n`);

// Check all events
const allEvents = db.prepare(`
  SELECT type, timestamp, block_timestamp, 
         COALESCE(block_timestamp, timestamp) as display_ts
  FROM whale_events 
  ORDER BY COALESCE(block_timestamp, timestamp) DESC
`).all();

console.log(`📊 Total events in DB: ${allEvents.length}`);

// Check events within cutoff
const withinCutoff = allEvents.filter(e => {
  let ts = e.display_ts;
  return ts >= cutoff;
});

console.log(`📊 Events within 24h window: ${withinCutoff.length}`);

// Show oldest and newest events
const newest = allEvents[0];
const oldest = allEvents[allEvents.length - 1];

console.log(`\n📅 Newest event:`);
console.log(`   type: ${newest.type}`);
console.log(`   timestamp: ${newest.timestamp} (${new Date(newest.timestamp).toISOString()})`);
console.log(`   block_timestamp: ${newest.block_timestamp} (${newest.block_timestamp ? new Date(newest.block_timestamp).toISOString() : 'null'})`);

console.log(`\n📅 Oldest event:`);
console.log(`   type: ${oldest.type}`);
console.log(`   timestamp: ${oldest.timestamp} (${new Date(oldest.timestamp).toISOString()})`);
console.log(`   block_timestamp: ${oldest.block_timestamp} (${oldest.block_timestamp ? new Date(oldest.block_timestamp).toISOString() : 'null'})`);

// Check the actual cutoff comparison
console.log(`\n🔬 Cutoff comparison sample (first 20 events):`);
allEvents.slice(0, 20).forEach((e, i) => {
  let ts = e.display_ts;
  const isWithin = ts >= cutoff;
  console.log(`${i+1}. type=${e.type}, ts=${ts} (${new Date(ts).toISOString()}), within=${isWithin ? '✓' : '✗'}`);
});

db.close();