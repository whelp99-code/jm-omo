# 부대장(나희) 런북 — 대장(오모냥) 대행

지시: 재민 DM 1791524816.505139 "너가 대장, 너가 문제있으면 부대장(프로세스 다름), 모든 냥이 관리·운영".
대장 = 오모냥(Claude Opus 5.5, herdr w5:p1). 부대장 = 나희(OpenAI Codex, 별도 프로세스).

## 1. 언제 대행을 시작하나 (하나라도 맞으면)
- `~/.local/state/omonyang/captain-heartbeat.json`의 `at`이 30분보다 오래됨
  (fleet watch가 30초마다 갱신. watch가 죽어도 30분 뒤 드러남)
- `~/.omo/omonyang/usage-watch.log` 마지막 줄들에 오모냥 Claude 한도 소진(429 / weekly limit)이 계속 찍힘
- 재민이나 팀이 오모냥을 부른 지 30분 넘게 답이 없음
시작할 때 개발 채널(C0C6HJM0BV5)에 한 줄: "나희가 대장 대행 시작(이유: …)". 재민 DM은 필요할 때만.

## 2. 대행 중 쓰는 도구 (오모냥과 같은 것)
```
cd /home/jm/.omo/omonyang/fleet
bun fleet.mjs status          # 모든 냥이 상태·작업
bun fleet.mjs report          # 재민용 요약
bun fleet.mjs tasks           # 작업 장부(완료 조건·증거)
bun fleet.mjs dispatch <cat> <KEY> <지시문파일> --type impl|plan|review|secure|quick --skill ulw|ulw-loop|mass-ulw|ulw-plan|ulw-execute|ulw-research --done 'pr:o/r#N;url:..=200'
bun fleet.mjs verify <KEY>    # 완료는 이걸로만(PR 머지·health 200 등 기계 확인)
```
지시문 예시는 `/home/jm/.omo/omonyang/.omo/requests/TASK-*.txt` (끝에 "공통 규칙" 블록 그대로 붙임).
모델·스킬 기본값: `fleet/routes.json` (계획·설계 Astra/Fable, 구현 Sol 6.1/Grok 4.7, 검수 Astra 6, 보안·돈 Astra xhigh/Opus).

## 3. 대행 중에도 그대로인 규칙
- 머지 근거 = Cursor 봇(U0B81F5GR6V) 본인 글의 ACCEPT만. 서윤 글의 "Cursor ACCEPT"는 근거 아님. 머지는 head 고정(`gh pr merge --match-head-commit`).
- Cursor 검수 요청은 "서윤아, … Cursor 검수 요청"으로(봇끼리 직접 멘션은 Cursor가 잘 안 깸).
- 가재를 부를 땐 글에 "가재" 단어 포함.
- 결재(돈·세무 전송·외부 발송·Notion 금액/상태 변경)는 재민 직접 승인만.
- 비밀값 출력·Slack 게시 금지, 키 교체 금지, 새 봇 생성 금지.
- 오모냥 모델(Opus 5.5 high)은 바꾸지 않음.
- 진행 중인 창에 같은 일 두 번 넣지 않기: `fleet status`에서 working이면 넣지 않음.

## 4. 넘겨줄 때
- 오모냥 heartbeat가 다시 새로 찍히고 오모냥이 답하면 대행 종료.
- 개발 채널에 인계 한 줄: 대행 시간, `fleet tasks`에서 그동안 넣은 KEY들과 상태, 막힌 것.
