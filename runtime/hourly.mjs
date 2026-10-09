import { Database } from 'bun:sqlite';
import {readDevelopmentStatus,buildHourlyText,serializeReport} from './development-report.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Hourly {
 constructor(path){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new Database(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS reports(slot INTEGER PRIMARY KEY, state TEXT NOT NULL, receipt TEXT, payload TEXT);');}
 seed(now){this.db.query("INSERT OR IGNORE INTO reports(slot,state) VALUES(?,'baseline')").run(Math.floor(now/3600000));}
 reserve(now,payload){return this.db.transaction(()=>{const slot=Math.floor(now/3600000);const row=this.db.query('SELECT * FROM reports WHERE slot=?').get(slot); if(row)return false;this.db.query("INSERT INTO reports(slot,state,payload) VALUES(?,'unknown',?)").run(slot,payload);return true;}).immediate();}
 sent(now,receipt){this.db.query("UPDATE reports SET state='sent',receipt=? WHERE slot=?").run(receipt,Math.floor(now/3600000));}
 rejected(now){this.db.query("DELETE FROM reports WHERE slot=? AND state='unknown'").run(Math.floor(now/3600000));}
 rows(){return this.db.query('SELECT * FROM reports ORDER BY slot').all();}
 close(){this.db.close();}
}
export async function report(store,now,text,send){if(!store.reserve(now,text))return {outcome:'skipped'};let result;try{result=await send(text);}catch{return {outcome:'unknown'};}if(result.outcome==='sent')store.sent(now,result.receipt);else if(result.outcome==='not_sent')store.rejected(now);return result;}
if(import.meta.main&&!['--seed','--status','--preview'].some(flag=>process.argv.includes(flag))){
 console.log(JSON.stringify({type:'hourly_report',outcome:'skipped',reason:'periodic_reports_owned_by_gajae;omonyang_goal_report_at_0700'}));
}else if(import.meta.main){
 const now=Date.now();const store=new Hourly(`${process.env.HOME}/.omo/omonyang/durable/hourly.sqlite`);
 try {
 if(process.argv.includes('--seed')){store.seed(now);console.log('HOURLY_BASELINE');}
 else if(process.argv.includes('--status'))console.log(JSON.stringify(store.rows()));
 else {
  let rows=[];let reachable=false;
  try{const p=Bun.spawn(['/home/jm/.local/bin/herdr','workspace','list'],{stdout:'pipe',stderr:'ignore'});const raw=await new Response(p.stdout).text();if(await p.exited===0){rows=JSON.parse(raw).result.workspaces;reachable=true;}}catch{}
  const labels={working:'실행 중',done:'입력 대기',idle:'입력 대기',blocked:'승인/입력 대기',unknown:'상태 미확인'};
  const lines=rows.filter(w=>['오모냥','shipping-harness','jarvis-side-notch','ai-crm-core5','second-brain-app'].includes(w.label)).map(w=>`• ${w.label}: ${labels[w.agent_status]||'상태 미확인'}`);
  const bridge=process.env.SERVICE_RESULT==='success'?'정상':`확인 필요 (${process.env.SERVICE_RESULT||'실행 결과 미확인'})`;
  const text=buildHourlyText({now,bridge,states:reachable?lines.join(' · '):'세션 상태 조회 실패 — 확인 필요',...readDevelopmentStatus()});
  if(process.argv.includes('--preview')) console.log(text);
  else {
   const {SlackBotCredentialManager}=await import('/home/jm/.nvm/versions/node/v24.19.0/lib/node_modules/agent-messenger/dist/src/platforms/slackbot/index.js');
   const token=(await new SlackBotCredentialManager().getCredentials())?.token;
   if(!token)throw new Error('BOT_CREDENTIAL_UNAVAILABLE');
   const result=await report(store,now,text,async(body)=>{
    const response=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:serializeReport(body),redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return {outcome:'unknown'};
    const posted=await response.json();
    if(posted.ok===false)return {outcome:'not_sent'};
    if(posted.ok===true&&posted.ts)return {outcome:'sent',receipt:posted.ts};
    return {outcome:'unknown'};
   });console.log(JSON.stringify({type:'hourly_report',...result}));
  }
 }
 }catch{console.error('HOURLY_REPORT_FAILED');process.exitCode=1;}finally{store.close();}
}
