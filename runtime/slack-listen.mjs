import { readFileSync, writeSync } from 'node:fs';
import { Inbox, accept, processIdentity, guardParent } from './inbox.mjs';
import { SlackBotClient, SlackBotCredentialManager, SlackBotListener } from '/home/jm/.nvm/versions/node/v24.19.0/lib/node_modules/agent-messenger/dist/src/platforms/slackbot/index.js';
const inbox = new Inbox(`${process.env.HOME}/.omo/omonyang/durable/inbox.sqlite`);
const identity=processIdentity(process.pid);
const parent=processIdentity(process.ppid);
if(!identity || !parent || process.ppid===1) throw new Error('NO_LIVE_PARENT');
inbox.acquire(identity);
let listener, timer, stopped=false;
function stop(code=0){ if(stopped)return; stopped=true; clearInterval(timer); listener?.stop(); inbox.release(identity); inbox.close(); process.exit(code); }
process.once('SIGTERM',()=>stop()); process.once('SIGINT',()=>stop());
process.stdout.on('error',()=>stop(1));
timer=guardParent(()=>stop(1));
const emit=(row,replay)=>{
 const e=JSON.parse(row.payload);
 const text=(e.text||'').replace(/\s+/g,' ').slice(0,300);
 const files=(e.files||[]).map(f=>f.name).join(',');
 writeSync(1,`SLACK_MESSAGE ${e.channel} ${e.ts} ${e.thread_ts||'-'} ${e.user||'?'} ${files?'[files:'+files+'] ':''}${text} [inbox=${row.id} state=${row.state} replay=${replay}]\n`);
};
try {
 const creds=await new SlackBotCredentialManager().getCredentials();
 const appToken=readFileSync(`${process.env.HOME}/.config/omonyang/slack-app-token`,'utf8').trim();
 if(!creds?.token || !appToken)throw new Error('SLACK_NO_TOKEN');
 const client=await new SlackBotClient().login({token:creds.token});
 listener=new SlackBotListener(client,{appToken});
 listener.on('connected',()=>console.log('SLACK_UP durable-inbox'));
 const receive=async(args)=>{
   try {
    const e=args.event;
    if(e.bot_id==='B0C5MDKH4AU'||e.user==='U0C4SUMDD98'||['message_changed','message_deleted'].includes(e.subtype)){await args.ack();return;}
    const fresh=await accept(inbox,args,emit);
    if(fresh)client.addReaction(e.channel,e.ts,'eyes').catch(()=>{});
   } catch { console.error('SLACK_PERSIST_OR_DELIVERY_ERROR no_completion_assumed'); stop(1); }
 };
 listener.on('message',receive); listener.on('app_mention',receive);
 listener.on('error',()=>console.log('SLACK_ERROR transport_error'));
 for(const row of inbox.pending()){inbox.delivered(row.id);emit(row,true);}
 await listener.start();
} catch { console.error('SLACK_START_FAILED'); stop(1); }
