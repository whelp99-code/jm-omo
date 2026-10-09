import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function processIdentity(pid) {
  try { const s=readFileSync(`/proc/${pid}/stat`,'utf8'); const fields=s.slice(s.lastIndexOf(')')+2).split(' '); return fields[0]==='Z' ? null : `${pid}:${fields[19]}`; } catch { return null; }
}
export function guardParent(onGone, intervalMs=1000) {
 const parent=processIdentity(process.ppid);
 if(!parent || process.ppid===1) throw new Error('NO_LIVE_PARENT');
 return setInterval(()=>{if(processIdentity(Number(parent.split(':')[0]))!==parent)onGone();},intervalMs);
}
export class Inbox {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new Database(path); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', received INTEGER NOT NULL, delivered INTEGER, completed INTEGER, evidence TEXT); CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), identity TEXT NOT NULL);`);
  }
  acquire(identity) { return this.db.transaction(()=>{ const row=this.db.query('SELECT identity FROM owner WHERE slot=1').get(); if(row && processIdentity(Number(row.identity.split(':')[0]))===row.identity) throw new Error('LISTENER_ALREADY_RUNNING'); this.db.query('INSERT OR REPLACE INTO owner VALUES(1,?)').run(identity); }).immediate(); }
  release(identity) {this.db.query('DELETE FROM owner WHERE identity=?').run(identity);}
  receive(event) { if(!event.channel || !event.ts) throw new Error('INVALID_EVENT'); const id=`${event.channel}:${event.ts}`; this.db.query('INSERT OR IGNORE INTO events(id,payload,received) VALUES(?,?,?)').run(id,JSON.stringify(event),Date.now()); return this.get(id); }
  get(id) { return this.db.query('SELECT * FROM events WHERE id=?').get(id); }
  pending() { return this.db.query("SELECT * FROM events WHERE state != 'completed' ORDER BY received").all(); }
  delivered(id) {this.db.query('UPDATE events SET delivered=? WHERE id=?').run(Date.now(),id);}
  claim(id) { return this.db.transaction(()=>{ const row=this.get(id); if(!row) throw new Error('UNKNOWN_EVENT'); if(row.state!=='pending') return {execute:false,state:row.state,reconcile:row.state==='processing'}; this.db.query("UPDATE events SET state='processing' WHERE id=?").run(id); return {execute:true,state:'processing'}; }).immediate(); }
  complete(id,evidence) {if(!evidence?.trim()) throw new Error('COMPLETION_EVIDENCE_REQUIRED'); const row=this.get(id); if(!row) throw new Error('UNKNOWN_EVENT'); if(row.state==='completed') return; this.db.query("UPDATE events SET state='completed',completed=?,evidence=? WHERE id=?").run(Date.now(),evidence,id);}
  close(){this.db.close();}
}
export async function accept(inbox,args,emit) {
  const row=inbox.receive(args.event); // FULL durable commit BEFORE Slack ACK
  await args.ack();
  if(row.state==='completed' || row.delivered) return false;
  inbox.delivered(row.id); // crash now is replay/reconcile, never inferred completion
  emit(row,false);
  return true;
}
if(import.meta.main) {
 const inbox=new Inbox(process.env.OMO_INBOX_PATH || `${process.env.HOME}/.omo/omonyang/durable/inbox.sqlite`);
 const [cmd,id,...rest]=process.argv.slice(2);
 try {let result; if(cmd==='list') result=inbox.pending().map(({payload,...row})=>row); else if(cmd==='get') result=inbox.get(id); else if(cmd==='claim') result=inbox.claim(id); else if(cmd==='complete'){inbox.complete(id,rest.join(' '));result={id,state:'completed'};} else throw new Error('Usage: inbox.mjs list|get ID|claim ID|complete ID EVIDENCE'); console.log(JSON.stringify(result));} finally {inbox.close();}
}
