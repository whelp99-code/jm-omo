# 공통 규칙 (모든 냥이 지시문 끝에 붙임)
(재민 2026-10-08/09):
- 검증은 꼭 필요한 것만: 관련 테스트 파일 통과 + Cursor ACCEPT + 운영 반영 시 health 200. 전체 재검증 반복·증거 문서 확대 금지.
- 지금부터 개발분은 jm-omachy 이전 대상: 새 release·DB role·0600 비밀 파일·unit·타이머·포트가 생기면 PR/Issue에 '이전 메모' 한 줄(경로·unit·포트·DB 객체). 새 설정에 jm-acloud 고유 IP·호스트명 금지(127.0.0.1·상대경로).
- 비밀값은 화면·로그·Issue·Slack에 출력 금지. 키 교체 금지.
- 끝나면 마지막 줄: <TASK>_DONE 또는 <TASK>_BLOCKED reason=<한 줄>.
