import {readFileSync} from 'node:fs';
import {loadFleetConfig} from '../fleet/config.mjs';
export function clean(value,max=220){
 const text=typeof value==='string'?value:Array.isArray(value)?value.map(v=>clean(v,100)).join('; '):value&&typeof value==='object'?Object.entries(value).filter(([k])=>!/token|secret|password|credential|authorization|api.?key/i.test(k)).map(([k,v])=>`${k}: ${clean(v,100)}`).join('; '):value==null?'미확인':String(value);
 const s=text.replace(/\s+/g,' ').trim();if(!s)return '미확인';if(/xox[baprs]-|sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/.test(s))return '민감정보 패턴으로 본문 제외';return s.length>max?s.slice(0,max-1)+'…':s;
}
export function stamp(value){const d=new Date(value);return typeof value==='string'&&Number.isFinite(d.getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)+' KST':'시각 미확인';}
export function freshness(updatedAt,now=Date.now()){
 const at=typeof updatedAt==='string'?Date.parse(updatedAt):NaN;if(!Number.isFinite(at))return '미갱신 — updatedAt 없음/잘못된 시각';
 if(at>now+60000)return '미갱신 — 미래 시각 오류';
 const mins=Math.max(0,Math.floor((now-at)/60000));return `${now-at>3600000?'미갱신 — 60분 초과':'최근 기록'} / ${mins}분 경과`;
}
export const REPORT_LIMIT=3500;
export function brief(value,max){
 const s=clean(value,100000),cost=v=>JSON.stringify(v).length-2;
 if(cost(s)<=max)return s;
 // Preserve leading and ending qualifiers. Budget includes JSON escaping.
 const units=Array.from(s),part=n=>{const head=Math.ceil(n*0.6),tail=n-head;return units.slice(0,head).join('')+'…'+(tail?units.slice(-tail).join(''):'')+'[요약]';};
 let low=0,high=Math.min(units.length,max);
 while(low<high){const mid=Math.ceil((low+high)/2);if(cost(part(mid))<=max)low=mid;else high=mid-1;}
 return part(low);
}
export function formatStatus(data,now=Date.now(),cap=10000){
 if(!data||typeof data!=='object'||!Array.isArray(data.projects))return '개발상황 자료 없음 — producer JSON projects 형식 확인 필요';
 const lines=[`자료: ${freshness(data.updatedAt,now)} · ${stamp(data.updatedAt)}`,`승인: ${brief(data.approvalSource,65)}`];
 if(data.projects.length===0)lines.push('개발상황 자료 없음 — projects가 비어 있습니다.');
 for(const [i,p] of data.projects.slice(0,12).entries()){
  if(!p||typeof p!=='object'){lines.push(`${i+1}. 프로젝트 자료 형식 오류`);continue;}
  const dated=p.updatedAt!==undefined&&p.updatedAt!==data.updatedAt?` · ${freshness(p.updatedAt,now)}`:'';
  lines.push(`${i+1}. ${brief(p.name,40)}${dated}\n단계: ${brief(p.currentStep,cap)}\n검증: ${brief(p.verification,cap)}\n막힘: ${brief(p.blocker,cap*2)}\n다음: ${brief(p.nextAction,cap)}`);
 }
 if(data.projects.length>12)lines.push(`추가 ${data.projects.length-12}개 프로젝트: 길이 제한으로 상세 요약 생략. 해당 항목의 단계·검증·막힘·다음 행동은 원본 확인 필요.`);
 lines.push('근거·전체 조건은 담당 원본에 보존. [요약]은 일부 생략 표시이며 완료·배포 인수를 뜻하지 않습니다.');
 return lines.join('\n\n');
}
export function readDevelopmentStatus(home=process.env.HOME){
 let path;
 try{path=JSON.parse(readFileSync(`${home}/.omo/omonyang/development-report-config.json`,'utf8')).statusPath;}catch{return {error:'개발상황 자료 없음 — producer 경로 설정 미확인'};}
 if(typeof path!=='string'||!path.startsWith('/'))return {error:'개발상황 자료 없음 — producer 절대경로 미확인'};
 try{return {data:JSON.parse(readFileSync(path,'utf8'))};}catch{return {error:'개발상황 자료 없음 — 지정된 producer JSON이 없거나 읽기/파싱 실패'};}
}
export function developmentText(home=process.env.HOME){const r=readDevelopmentStatus(home);return r.error??formatStatus(r.data);}
export function serializeReport(text){return JSON.stringify({channel:loadFleetConfig().slack.reviewChannel,text});}
export function buildHourlyText({now=Date.now(),bridge,states,data,error}){
 const hour=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
 const prefix=`시간별 개발 진행상황 · ${hour} KST\n감시: ${brief(bridge,55)}\n\n`;
 const suffix=`\n\n실행 상태: ${brief(states,190)}`;
 for(const cap of [10000,160,140,120,100,80,64,48,36,28,20,12,8]){
  const text=prefix+(error?brief(error,200):formatStatus(data,now,cap))+suffix;
  if(text.length<=REPORT_LIMIT&&serializeReport(text).length<=REPORT_LIMIT)return text;
 }
 throw new Error('REPORT_LENGTH_LIMIT');
}
