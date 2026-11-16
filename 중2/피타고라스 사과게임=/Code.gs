/**
 * 피타고라스 사과게임 - 서버(Apps Script) 코드
 * 구글 스프레드시트 > 확장 프로그램 > Apps Script 에 붙여 넣으세요.
 */

const RECORD_SHEET = '기록';
const RANK_LIMIT = 30;           // 랭킹 표시 인원
const MAX_SCORE = 30000;         // 비정상 점수 차단용 상한
const DIFF_KEYS = ['easy', 'normal', 'hard'];
const CACHE_REBUILD_MS = 60 * 1000; // 1분마다 시트에서 랭킹을 새로 계산 (선생님이 시트를 직접 고친 내용 반영)

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('피타고라스 사과게임')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(RECORD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECORD_SHEET);
    sh.appendRow(['시각', '난이도', '학번', '이름', '점수', '찾은 개수', '최대 콤보', '모드']);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sh;
}

function clean_(v, len) {
  return String(v == null ? '' : v).replace(/[<>=+\-@'"]/g, '').trim().slice(0, len);
}

/** 점수 저장 후 해당 난이도 랭킹(30위까지) 반환 */
function submitScore(rec) {
  const diff = DIFF_KEYS.indexOf(rec.diff) >= 0 ? rec.diff : 'easy';
  const id = clean_(rec.id, 10);
  const name = clean_(rec.name, 10);
  const score = Math.max(0, Math.min(MAX_SCORE, Math.floor(Number(rec.score) || 0)));
  const found = Math.max(0, Math.min(500, Math.floor(Number(rec.found) || 0)));
  const maxCombo = Math.max(0, Math.min(500, Math.floor(Number(rec.maxCombo) || 0)));
  const mode = rec.mode === 'battle' ? '대결' : '개인';
  if (!name) throw new Error('이름이 비어 있어요.');

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const now = new Date();
    getSheet_().appendRow([now, diff, id, name, score, found, maxCombo, mode]);
    // 시트를 다시 읽지 않고, 캐시된 랭킹에 이번 기록만 끼워 넣는다 (동시 접속 대비)
    if (mode === '개인') {
      const cache = CacheService.getScriptCache();
      const hit = cache.get('rank_' + diff);
      if (hit) {
        const box = JSON.parse(hit);
        if (Date.now() - box.built < CACHE_REBUILD_MS) {
          const list = box.list;
          const me = { id: id, name: name, score: score, found: found, maxCombo: maxCombo,
                       t: now.getTime(), date: Utilities.formatDate(now, 'Asia/Seoul', 'MM/dd HH:mm') };
          const i = list.findIndex(function (x) { return x.id === id && x.name === name; });
          if (i < 0) list.push(me); else if (score > list[i].score) list[i] = me;
          list.sort(function (a, b) { return b.score - a.score || a.t - b.t; });
          box.list = list.slice(0, RANK_LIMIT);
          cache.put('rank_' + diff, JSON.stringify(box), 600);
          return box.list;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  return getRanking(diff);
}

/** 난이도별 랭킹: 학번+이름 기준 최고 기록 1개씩, 상위 30명 (개인 모드 기록만) */
function getRanking(diff) {
  if (DIFF_KEYS.indexOf(diff) < 0) diff = 'easy';
  const cache = CacheService.getScriptCache();
  const hit = cache.get('rank_' + diff);
  if (hit) {
    const box = JSON.parse(hit);
    if (box && box.list && Date.now() - box.built < CACHE_REBUILD_MS) return box.list;
  }

  const sh = getSheet_();
  const last = sh.getLastRow();
  let rows = [];
  if (last >= 2) rows = sh.getRange(2, 1, last - 1, 8).getValues();

  const best = {};
  rows.forEach(function (r) {
    if (r[1] !== diff || r[7] !== '개인') return;
    const key = r[2] + '|' + r[3];
    const t = r[0] instanceof Date ? r[0].getTime() : 0;
    const cur = best[key];
    if (!cur || r[4] > cur.score || (r[4] === cur.score && t < cur.t)) {
      best[key] = { id: String(r[2]), name: String(r[3]), score: Number(r[4]),
                    found: Number(r[5]), maxCombo: Number(r[6]), t: t };
    }
  });

  const list = Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return b.score - a.score || a.t - b.t; })
    .slice(0, RANK_LIMIT)
    .map(function (x) {
      x.date = x.t ? Utilities.formatDate(new Date(x.t), 'Asia/Seoul', 'MM/dd HH:mm') : '';
      return x;
    });

  cache.put('rank_' + diff, JSON.stringify({ built: Date.now(), list: list }), 600);
  return list;
}

/* =========================================================
 * 1:1 대결 — 이 서버(Apps Script)가 두 학생 사이를 중계
 * (학교 와이파이에서 막히는 기기 간 직접 연결을 쓰지 않음)
 * 방 정보와 점수는 캐시에만 잠깐 저장되고 1시간 뒤 자동 삭제
 * ========================================================= */
const ROOM_TTL = 3600;          // 방 유지 시간(초)
const START_DELAY_MS = 4500;    // '대결 시작'을 누른 뒤 실제 시작까지 (두 기기가 동시에 시작하도록)

function room_(code) {
  const v = CacheService.getScriptCache().get('room_' + code);
  return v ? JSON.parse(v) : null;
}
function saveRoom_(r) {
  CacheService.getScriptCache().put('room_' + r.code, JSON.stringify(r), ROOM_TTL);
}
function code_(c) { return String(c == null ? '' : c).replace(/\D/g, '').slice(0, 5); }

/** 방 만들기 → 5자리 방 번호 */
function battleCreate(p) {
  const name = clean_(p.name, 10) || '친구';
  const diff = DIFF_KEYS.indexOf(p.diff) >= 0 ? p.diff : 'easy';
  const cache = CacheService.getScriptCache();
  for (let k = 0; k < 30; k++) {
    const code = String(10000 + Math.floor(Math.random() * 90000));
    if (cache.get('room_' + code)) continue;
    const r = { code: code, diff: diff, host: name, guest: '', round: 0, seed: 0, startAt: 0, hostLeft: false };
    saveRoom_(r);
    return { room: r, now: Date.now() };
  }
  throw new Error('방을 만들지 못했어요. 다시 눌러 주세요.');
}

/** 방 번호로 참가 */
function battleJoin(p) {
  const code = code_(p.code), name = clean_(p.name, 10) || '친구';
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = room_(code);
    if (!r) throw new Error('방을 찾을 수 없어요. 번호를 확인하세요.');
    if (r.hostLeft) throw new Error('방장이 나간 방이에요. 새 방을 만들어 주세요.');
    if (r.guest && r.guest !== name) throw new Error('이미 두 명이 들어간 방이에요.');
    r.guest = name;
    saveRoom_(r);
    return { room: r, now: Date.now() };
  } finally {
    lock.releaseLock();
  }
}

/** 대기실에서 방 상태 확인 (상대 입장·시작 여부) */
function battlePoll(p) {
  const r = room_(code_(p.code));
  if (!r) throw new Error('방이 사라졌어요. 새 방을 만들어 주세요.');
  return { room: r, now: Date.now() };
}

/** 방장이 '대결 시작' → 같은 판(seed)과 같은 시작 시각을 정함 */
function battleStart(p) {
  const r = room_(code_(p.code));
  if (!r) throw new Error('방이 사라졌어요. 새 방을 만들어 주세요.');
  if (!r.guest) throw new Error('아직 상대가 들어오지 않았어요.');
  r.round += 1;
  r.seed = Math.floor(Math.random() * 4294967295);
  if (DIFF_KEYS.indexOf(p.diff) >= 0) r.diff = p.diff;
  r.startAt = Date.now() + START_DELAY_MS;
  saveRoom_(r);
  return { room: r, now: Date.now() };
}

/** 게임 중: 내 점수를 올리고 상대 점수를 받아 옴 */
function battleSync(p) {
  const code = code_(p.code), round = Math.floor(Number(p.round) || 0);
  const role = p.role === 'host' ? 'host' : 'guest', other = role === 'host' ? 'guest' : 'host';
  const n = function (v, max) { return Math.max(0, Math.min(max, Math.floor(Number(v) || 0))); };
  const me = { s: n(p.s, MAX_SCORE), k: n(p.k, 1000), f: n(p.f, 5000), m: n(p.m, 1000), done: !!p.done, t: Date.now() };
  const cache = CacheService.getScriptCache();
  cache.put('st_' + code + '_' + round + '_' + role, JSON.stringify(me), ROOM_TTL);
  const o = cache.get('st_' + code + '_' + round + '_' + other);
  const r = room_(code);
  return { opp: o ? JSON.parse(o) : null, room: r, now: Date.now() };
}

/** 대결 나가기 */
function battleLeave(p) {
  const code = code_(p.code);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = room_(code);
    if (!r) return true;
    if (p.role === 'host') r.hostLeft = true; else r.guest = '';
    saveRoom_(r);
  } finally {
    lock.releaseLock();
  }
  return true;
}
