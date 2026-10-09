# 오모냥 함대(냥이) 운영 체계 — 진행계획 (2026-10-09)
지시: 재민 DM 1791525950.802199 "전체 내용에 대한 진행계획 작성하고 바로 수행". 근거 대화: DM 1791524816(대장·부대장·전체 관리), 1791525581(도리·가재 장점), 1791525730(세션·ulw 스킬), 1791525809/1791525898(모델 선정, 계획·설계=Astra/Fable).

## 목표 상태
오모냥(대장)이 모든 냥이를 장부로 관리: 누구에게 무엇을(어떤 스킬·모델로) 넣었고, 실제로 들어갔고, 지금 무엇을 하며, 증거로 끝났는지. 오모냥이 멈추면 나희(부대장, 다른 프로세스·모델)가 같은 장부로 이어받는다.

## 구성 (도리·가재에서 가져온 것)
1. 장부 `~/.local/state/omonyang/fleet.sqlite` — cats(냥이), tasks(작업·스킬·모델·완료조건·증거·이력), heartbeat. [도리 registry]
2. `fleet dispatch` — 창이 비어 있는지 확인 → 모델 전환(/model) → 지시 입력 → *실제로 시작했는지 확인*, 압축 실패로 사라지면 PROMPT_LOST. [도리 verified send + wK 사고 대응]
3. `fleet watch` — 30초마다 모든 창 상태 분류(일함/압축/대기/질문/제공사 오류/완료줄/막힘줄), 변화만 FLEET_ 이벤트로. 가재 recovery_hold·speech suppressed도 이유와 함께 알림. 대장 heartbeat 기록. [도리 sync/dead-pane + 가재 hold 가시화]
4. `fleet verify` — 완료는 기계 확인으로만: pr:repo#N merged(head 고정), url:..=200, cmd:..(exit 0). 결과 불확실하면 재실행하지 않고 not-done 사유 기록. [도리 Done= + 가재 "받았다≠했다"]
5. 모델 선정 — 작업 종류별 기본값(계획·설계 Astra/Fable, 구현 Grok 4.7 fast/Sol 6.1, 검수 Astra 6, 보안·돈 Opus/Astra, 간단 Luna fast). 한도·오류 시 같은 급 다른 제공사. 오모냥 자신은 Opus 5.5 high 고정.
6. 스킬 선정 — 작업 크기별 ulw / ulw-loop / mass-ulw / ulw-plan→ulw-execute / ulw-research를 지시문 첫 줄에 자동 표기.
7. 대장·부대장 교대 — heartbeat 30분 끊김 또는 대장 한도 오류 → 나희 대행(같은 장부·지시문·수신함), 복귀 시 인계 1줄. VICE-CAPTAIN.md 런북.
8. `fleet report` — 재민용 표 1개(누가·무엇·상태·막힘).

## 순서
1) 장부+CLI(init/status/dispatch/verify/report) → 실제 창으로 시험
2) watch(상태 분류·이벤트·heartbeat·가재 로그) → monitor 등록
3) 모델·스킬 라우팅 표
4) 부대장 런북 + 나희에게 전달(가재야 규칙처럼 이름 호출)
5) 진행 중 작업(Mail PR54, CRM PR58 반영)을 장부에 등록해 실전 사용

## 완료 기준
- `fleet status`가 모든 창을 실제 상태로 보여줌(실측 출력)
- dispatch로 실제 작업 1건 넣고 시작 확인이 기록됨
- verify가 실제 머지된 PR 1건을 verified-done, 미머지 1건을 not-done으로 판정
- watch 이벤트가 monitor로 들어옴
- 나희가 런북을 받고 확인 답

## 2단계 개선 (재민 승인 D0C4N09TK1B:1791532865.529309 "모두 좋은데? 마이그레이션 완료 후에 모두 진행하자")
시작 조건: jm-omachy 이전 완료 + fleet 도구를 jm-omachy에서 재가동한 뒤.
순서: 1 의존 작업 자동 연결 → 2 냥이 주장 자동 대조 → 3 모델별 대기 창 → 4 제공사 잔량 감시 → 6 질문 자동 처리 → 8 현황판 1개(수정형) → 5 쓰는 곳 자동 목록 → 7 창 컨텍스트 관리 → 9 부대장 교대 실전 훈련.
