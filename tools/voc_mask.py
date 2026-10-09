#!/usr/bin/env python3
"""VOC local masking (no AI). Input: JSONL of {id, received_at, subject, body}. Output: masked candidate excerpts.
Usage: voc_mask.py IN.jsonl OUT.jsonl [--names names.txt]
names.txt: one person/company name per line (e.g. exported from the mail contact table), masked as [이름]/[조직].
Lines that look like secrets are dropped entirely. Only messages matching incident keywords are kept.
"""
import json, re, sys

KEYWORDS = re.compile(r"장애|먹통|안\s?됩니다|안\s?돼|접속\s?불가|끊김|다운|느려|오류|에러|백업|복구|복원|랜섬|해킹|침해|바이러스|보안|점검|긴급|재부팅|outage|down|backup|restore|ransom|error", re.I)
SECRET_LINE = re.compile(r"(password|passwd|pwd|비밀번호|비번|암호|token|api[_-]?key|secret|private key|BEGIN [A-Z ]*KEY|otp|인증번호)\s*[:=]?", re.I)
RULES = [
    (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "[이메일]"),
    (re.compile(r"https?://\S+"), "[URL]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b"), "[IP]"),
    (re.compile(r"\b0\d{1,2}[-. )]?\d{3,4}[-. ]?\d{4}\b"), "[전화]"),
    (re.compile(r"\b\d{6}-?[1-4]\d{6}\b"), "[주민번호]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{5}\b"), "[사업자번호]"),
    (re.compile(r"\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b"), "[번호]"),
    (re.compile(r"\b[A-Za-z0-9]{24,}\b"), "[긴문자열]"),
    (re.compile(r"(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\S*\s+\S+(시|군|구)\s+\S+(로|길|동)\s*\d*\S*"), "[주소]"),
    (re.compile(r"(계정|아이디|ID|id|user(name)?)\s*[:=]\s*\S+"), r"\1: [계정]"),
    (re.compile(r"\S*@\S+"), "[@주소]"),
    (re.compile(r"\d{7,}"), "[숫자]"),
    (re.compile(r"(\(주\)|㈜|주식회사)\s*\S+|\S+\s*(\(주\)|㈜|주식회사)"), "[조직]"),
    (re.compile(r"[가-힣A-Za-z0-9]{2,}(대학교|대학|학교|병원|의료원|공사|공단|재단|연구원|연구소|진흥원|센터|시청|구청|군청|도청|교육청|은행|증권|보험|캐피탈|그룹|전자|산업|테크|텍|시스템즈?|솔루션|네트웍스|정보통신|컴퍼니|코리아|청)"), "[조직]"),
]
QUOTE_START = re.compile(r"^\s*(-{2,}\s*Original Message|-{2,}\s*원본 메시지|From:|보낸 사람:|발신:|On .+wrote:|20\d\d[.-]\s?\d{1,2}[.-]\s?\d{1,2}.+(작성|wrote))", re.I)

def load_names(path):
    if not path: return []
    names = [n.strip() for n in open(path, encoding="utf-8") if len(n.strip()) >= 2]
    return sorted(set(names), key=len, reverse=True)

def mask(text, names):
    out = []
    for line in (text or "").splitlines():
        if QUOTE_START.search(line):
            out.append("[이전 메일 인용 이하 생략]")
            break
        if line.lstrip().startswith(">"):
            continue
        if SECRET_LINE.search(line):
            out.append("[비밀 의심 줄 삭제]")
            continue
        for rx, rep in RULES:
            line = rx.sub(rep, line)
        for n in names:
            line = line.replace(n, "[이름]")
        line = line.replace("@", "[at]")
        out.append(line)
    return "\n".join(out)

def main():
    a = sys.argv[1:]
    names = load_names(a[a.index("--names")+1]) if "--names" in a else []
    src, dst = a[0], a[1]
    kept = total = 0
    with open(src, encoding="utf-8") as f, open(dst, "w", encoding="utf-8") as g:
        for raw in f:
            total += 1
            m = json.loads(raw)
            if not KEYWORDS.search((m.get("subject") or "") + "\n" + (m.get("body") or "")):
                continue
            kept += 1
            g.write(json.dumps({"id": m["id"], "received_at": (m.get("received_at") or "")[:10],
                                "subject": mask(m.get("subject"), names),
                                "excerpt": mask(m.get("body"), names)[:1500]}, ensure_ascii=False) + "\n")
    print(f"total={total} kept={kept}", file=sys.stderr)

if __name__ == "__main__":
    main()
