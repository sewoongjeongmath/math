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
