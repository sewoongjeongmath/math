#!/usr/bin/env python3
"""저장소의 폴더/파일을 훑어 files.json(사이트 목록)을 만듭니다.

- 폴더 = 사이트의 폴더
- .html 파일 = HTML 자료 (새 창에서 열림)
- .url 파일 = 링크 자료 (파일 안에 주소 한 줄, 또는 윈도우 바로가기 형식 URL=...)
- 그 밖의 파일(pdf, 이미지 등) = 파일 자료
- 이름이 . 또는 _ 로 시작하는 파일/폴더는 숨김
"""
import json, os, re, subprocess, sys, unicodedata

nfc = lambda s: unicodedata.normalize("NFC", s)

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
SKIP_TOP = {"scripts", "index.html", "site.json", "files.json", "README.md"}


def git_times(root):
    """경로 → 마지막으로 추가·수정된 시각(유닉스 초). 기록을 못 읽으면 빈 dict."""
    def git(*a):
        return subprocess.run(["git", "-c", "core.quotepath=off", *a], cwd=root,
                              capture_output=True, text=True, check=True).stdout
    try:
        if git("rev-parse", "--is-shallow-repository").strip() == "true":
            git("fetch", "--unshallow", "--quiet")
        out = git("log", "--format=%x00%ct", "--name-only", "--no-renames", "--diff-filter=AM")
    except (OSError, subprocess.CalledProcessError) as e:
        print("git 기록을 읽지 못함:", e, file=sys.stderr)
        return {}
    times, ts = {}, None
    for line in out.splitlines():
        if line.startswith("\x00"):
            ts = int(line[1:])
        elif line and ts is not None:
            times.setdefault(nfc(line), ts)
    return times


TIMES = {}


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def read_url(path):
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    m = re.search(r"^\s*URL\s*=\s*(\S+)", text, re.M | re.I)
    if m:
        return m.group(1)
    m = re.search(r"https?://\S+", text)
    return m.group(0) if m else None


def scan(rel):
    abs_dir = os.path.join(ROOT, rel)
    node = {"name": nfc(os.path.basename(rel)), "path": rel, "folders": [], "items": []}
    for name in sorted(os.listdir(abs_dir), key=natural_key):
        if name.startswith((".", "_")):
            continue
        if not rel and name in SKIP_TOP:
            continue
        p_rel = f"{rel}/{name}" if rel else name
        p_abs = os.path.join(ROOT, p_rel)
        if os.path.isdir(p_abs):
            node["folders"].append(scan(p_rel))
            continue
        if not rel:
            continue  # 맨 바깥에 놓인 파일은 목록에 넣지 않음
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        if ext == ".url":
            url = read_url(p_abs)
            if url and re.match(r"https?://", url, re.I):
                node["items"].append({"type": "link", "title": nfc(stem), "url": url, "added": TIMES.get(nfc(p_rel))})
        elif ext in (".html", ".htm"):
            node["items"].append({"type": "html", "title": nfc(stem), "path": p_rel, "added": TIMES.get(nfc(p_rel))})
        else:
            node["items"].append({"type": "file", "title": nfc(stem), "ext": ext.lstrip("."),
                                  "path": p_rel, "size": os.path.getsize(p_abs), "added": TIMES.get(nfc(p_rel))})
    return node


TIMES = git_times(ROOT)
tree = scan("")
cfg = {}
try:
    with open(os.path.join(ROOT, "site.json"), encoding="utf-8-sig") as f:
        cfg = json.load(f)
except (OSError, ValueError):
    pass

order = cfg.get("order") or []
rank = {n: i for i, n in enumerate(order)}
tree["folders"].sort(key=lambda f: (rank.get(nfc(f["name"]), len(order)), natural_key(f["name"])))

out = {"title": cfg.get("title", "정세웅의 수학세상"),
       "subtitle": cfg.get("subtitle", ""),
       "folders": tree["folders"]}
with open(os.path.join(ROOT, "files.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print("files.json:", sum(1 for _ in os.walk(ROOT)), "dirs scanned")
