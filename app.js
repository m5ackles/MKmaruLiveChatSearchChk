/* 유튜브 채팅 찾기 - 안드로이드  by 멸콩마루
 * PC 버전(yt_chat_finder_gui.py)과 같은 방식으로 채팅을 수집합니다.
 * 유튜브 접속은 앱(Android 브리지)이 대신 해서 CORS 제한이 없습니다.
 */
"use strict";

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
};
const CHECK_SEC = 60;          // 채널 라이브 확인 간격
const RETRY_SEC = 15;          // 오류 시 재시도 간격
const LIVE_RANGE = "bytes=0-524287"; // 라이브 확인은 앞부분(약 512KB)만 받아 데이터 절약(방송 많아도 안 멈춤)
const STAGGER_MS = 400;        // 방송이 많을 때 한꺼번에 요청하지 않도록 채널마다 시차
const JS_VER = "2026-11-07-range"; // 화면(app.js) 버전 — 진단에 찍혀서 어떤 app.js가 로딩됐는지 확인용
const MAX_LOG = 1500;
const API = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false";
const A = window.Android || null;
const $ = (id) => document.getElementById(id);

/* ---------------- 앱 ↔ 네이티브 통신 ---------------- */
const pending = {};
let reqSeq = 0;
window.__resp = (id, status, text) => {
  const p = pending[id];
  if (!p) return;
  delete pending[id];
  clearTimeout(p.timer);
  if (status < 0) p.rej(new Error(text || "네트워크 오류"));
  else p.res({ status, text });
};

function http(method, url, headers, body) {
  if (!A) return Promise.reject(new Error("앱에서만 동작합니다 (브라우저에서는 유튜브 접속 불가)"));
  return new Promise((res, rej) => {
    const id = ++reqSeq;
    const timer = setTimeout(() => {
      if (pending[id]) { delete pending[id]; rej(new Error("응답 시간 초과")); }
    }, 40000);
    pending[id] = { res, rej, timer };
    A.request(id, method, url, JSON.stringify(headers || {}), body || "");
  });
}

async function getText(url, extra) {
  const r = await http("GET", url, extra ? Object.assign({}, UA, extra) : UA);
  if (r.status >= 400) throw new Error("HTTP " + r.status);
  return r.text;
}

/* 페이지 전체(1~2MB) 대신 필요한 부분만 앱(Java)이 잘라서 넘겨줌 → 폰에서 멈추지 않게.
 * pats: 정규식 문자열(첫 괄호 값) 또는 "json:키"(그 뒤 { } 객체). 결과는 같은 순서의 배열(없으면 null) */
const P = {
  CANON: '<link rel="canonical" href="https://www\\.youtube\\.com/watch\\?v=([\\w-]{11})"',
  LIVE: '"isLiveNow":true',
  UPCOMING: '"isUpcoming":true',
  HLS: 'hlsManifestUrl',
  TITLE: '"videoDetails":\\{[\\s\\S]*?"title":"((?:[^"\\\\]|\\\\.)*)"',
  AUTHOR: '"videoDetails":\\{[\\s\\S]*?"author":"((?:[^"\\\\]|\\\\.)*)"',
  VCHID: '"videoDetails":\\{[\\s\\S]*?"channelId":"(UC[\\w-]{22})"',
  OWNER: '"ownerProfileUrl":"https?://www\\.youtube\\.com/(@[^"]+)"',
  OG: '<meta property="og:title" content="([^"]*)"',
  CHMETA: '"channelMetadataRenderer":\\{"title":"((?:[^"\\\\]|\\\\.)*)"',
  EXT1: '"externalId":"(UC[\\w-]{22})"',
  EXT2: '<meta itemprop="identifier" content="(UC[\\w-]{22})"',
  EXT3: '<link rel="canonical" href="https://www\\.youtube\\.com/channel/(UC[\\w-]{22})"',
  EXT4: '"channelId":"(UC[\\w-]{22})"',
  VANITY: '"vanityChannelUrl":"https?://www\\.youtube\\.com/(@[^"]+)"',
  CBU: '"canonicalBaseUrl":"/(@[^"]+)"',
  VER: '"INNERTUBE_CLIENT_VERSION":"([^"]+)"',
};
function extractLocal(text, pats) {   // 예전 앱(추출 기능 없음)용 대비
  return pats.map((p) => {
    if (p.startsWith("json:")) { try { return JSON.stringify(extractJsonAfter(text, p.slice(5))); } catch (e) { return null; } }
    const m = text.match(new RegExp(p));
    return m ? (m.length > 1 ? m[1] : m[0]) : null;
  });
}
async function getParts(url, pats, extra) {
  if (A && A.requestX) {
    const hdrs = extra ? Object.assign({}, UA, extra) : UA;
    const r = await new Promise((res, rej) => {
      const id = ++reqSeq;
      const timer = setTimeout(() => { if (pending[id]) { delete pending[id]; rej(new Error("응답 시간 초과")); } }, 40000);
      pending[id] = { res, rej, timer };
      A.requestX(id, "GET", url, JSON.stringify(hdrs), "", JSON.stringify(pats));
    });
    if (r.status >= 400) throw new Error("HTTP " + r.status);
    const o = JSON.parse(r.text);
    lastPageLen = o.len;
    return o.m;
  }
  const text = await getText(url, extra);
  lastPageLen = text.length;
  return extractLocal(text, pats);
}
let lastPageLen = 0;
const unq = (x) => { if (x == null) return ""; try { return JSON.parse('"' + x + '"'); } catch (e) { return x; } };

/* ---------------- 검색(매칭) ---------------- */
function norm(s) {
  return String(s || "").normalize("NFC").toLowerCase().replace(/\s+/g, "").replace(/^@+/, "");
}
function isChannelId(s) { s = String(s || "").trim(); return s.startsWith("UC") && s.length === 24; }

function matchUser(name, cid, targets) {
  const n = norm(name);
  for (const t of targets) {
    if (isChannelId(t)) { if (cid === t.trim()) return t; }
    else if (norm(t) && n.includes(norm(t))) return t;
  }
  return null;
}
function matchAny(name, cid, text, targets, searchText) {
  const hit = matchUser(name, cid, targets);
  if (hit) return [hit, "닉네임"];
  if (searchText) {
    const body = norm(text);
    for (const t of targets) {
      if (isChannelId(t)) continue;
      if (norm(t) && body.includes(norm(t))) return [t, "내용"];
    }
  }
  return [null, null];
}

/* 줄 하나(item)와 채팅 비교 → "닉네임" | "채널ID" | "내용" | null
 * item: {text, scope: both|name|text, exact, cid} */
function phraseIn(t, text) {
  const words = String(t).normalize("NFC").toLowerCase().replace(/^@+/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?<![\\p{L}\\p{N}_])" + words.map(esc).join("\\s+") + "(?![\\p{L}\\p{N}_])", "u");
  return re.test(String(text || "").normalize("NFC").toLowerCase());
}
function matchItem(name, cid, text, item, searchText) {
  const t = item.text.trim();
  if (isChannelId(t)) return cid === t ? "채널ID" : null;
  if (item.cid && cid && cid === item.cid) return "채널ID";
  const scope = item.scope || "both", exact = !!item.exact;
  if (scope === "both" || scope === "name") {
    const n = norm(name), nt = norm(t);
    if (nt && (exact ? n === nt : n.includes(nt))) return "닉네임";
  }
  if (searchText && (scope === "both" || scope === "text")) {
    if (exact ? phraseIn(t, text) : (norm(t) && norm(text).includes(norm(t)))) return "내용";
  }
  return null;
}

/* ---------------- 주소 처리 ---------------- */
/* 방송 주소 칸에 함께 표시할 이름: 채널이면 채널 이름, 방송 주소면 '채널 - 제목' */
/* 채널이면 {label: 채널 이름, cid: 채널ID, handle: 현재 @핸들}. cid를 알면 핸들이 바뀌어도 채널 ID로 찾아감 */
function firstMatch(html, res) { for (const re of res) { const m = html.match(re); if (m) return m[1]; } return ""; }
function normHandle(h) {
  let x = String(h || "").trim();
  try { x = decodeURIComponent(x); } catch (e) { /* 그대로 */ }
  x = x.toLowerCase();
  return x.startsWith("@") ? x : "";
}
function handleOf(text) {
  let t = String(text || "");
  try { t = decodeURIComponent(t); } catch (e) { /* 그대로 */ }
  const m = t.match(/(@[^\/?\s]+)/);
  return m ? m[1] : "";
}
async function sourceLabel(src, cid) {
  if (isChannel(src) || cid) {
    const [og, meta, e1, e2, e3, e4, van, cbu] = await getParts(safeUrl(channelBase(cid || src)),
      [P.OG, P.CHMETA, P.EXT1, P.EXT2, P.EXT3, P.EXT4, P.VANITY, P.CBU]);
    let name = "";
    if (og) { const t = document.createElement("textarea"); t.innerHTML = og; name = t.value.trim(); }
    else name = unq(meta).trim();
    const ch = e1 || e2 || e3 || e4 || "";
    let handle = van || cbu || "";
    try { handle = decodeURIComponent(handle); } catch (e) { /* 그대로 */ }
    return { label: name, cid: ch || cid || "", handle };
  }
  const info = await videoInfo(src);
  return { label: info.owner && info.title ? `${info.owner} - ${info.title.slice(0, 30)}` : (info.owner || info.title || ""),
           cid: "", handle: "" };
}
const labelTried = new Set();
/* 이름·채널ID·현재 핸들 갱신. 핸들이 바뀌었으면 진행 상황에 알림 */
function setLabel(text, label, cid, handle) {
  const it = items.urls.find((x) => x.text.trim() === text);
  if (!it) return;
  let changed = false;
  if (label && it.label !== label) { it.label = label; changed = true; }
  if (cid && !it.cid) { it.cid = cid; changed = true; }
  if (handle) {
    const old = it.handle || handleOf(text);
    if (normHandle(old) && normHandle(old) !== normHandle(handle))
      write(`🔄 방송 채널 핸들 변경 감지: ${old} → ${handle} (채널 ID로 계속 추적합니다)`, "ok");
    if (it.handle !== handle) { it.handle = handle; changed = true; }
  }
  if (changed) { render("urls"); saveSoon(); }
}
function fetchLabels() {
  if (!A) return;
  for (const it of items.urls) {
    const t = it.text.trim();
    // 이름이 없거나, 채널이면 열 때마다 한 번 최신 이름·핸들 확인 (채널 ID로 → 핸들이 바뀌어도 찾음)
    if (!t || (it.label && !isChannel(t)) || labelTried.has(t)) continue;
    labelTried.add(t);
    sourceLabel(t, it.cid).then((r) => setLabel(t, r.label, r.cid, r.handle)).catch(() => {});
  }
}
function isChannel(s) {
  s = s.trim();
  if (s.startsWith("@") || isChannelId(s)) return true;
  return ["/@", "/channel/", "/c/", "/user/"].some((k) => s.includes(k));
}
function channelBase(s) {
  s = s.trim().split("?")[0].replace(/\/+$/, "");
  if (s.startsWith("@")) return "https://www.youtube.com/" + s;
  if (isChannelId(s)) return "https://www.youtube.com/channel/" + s;
  const m = s.match(/(https?:\/\/)?(www\.|m\.)?youtube\.com\/(@[^\/]+|channel\/[^\/]+|c\/[^\/]+|user\/[^\/]+)/);
  return m ? "https://www.youtube.com/" + m[3] : s;
}
function safeUrl(u) {
  let d = u;
  try { d = decodeURI(u); } catch (e) { /* 그대로 */ }
  return encodeURI(d);
}
function videoId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}
const watchUrl = (vid) => "https://www.youtube.com/watch?v=" + vid;
const chatUrl = (vid) => "https://www.youtube.com/live_chat?is_popout=1&v=" + vid;

function jstr(html, re) {
  const m = html.match(re);
  if (!m) return "";
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
}

async function findLive(base) {
  // /live 페이지가 영상(watch?v=)으로 연결되면 라이브(또는 예정)로 본다.
  // '예정만'(아직 시작 안 함)인 경우만 제외. isLiveNow 표시에만 의존하지 않음.
  const [vid, live, upcoming] = await getParts(safeUrl(base + "/live"), [P.CANON, P.LIVE, P.UPCOMING], { "Range": LIVE_RANGE });
  if (!vid) return null;
  if (upcoming && !live) return null;
  return vid;
}

async function videoInfo(url) {
  const vid = videoId(url);
  const page = vid ? watchUrl(vid) : url;
  const [title, owner, chid, own] = await getParts(safeUrl(page), [P.TITLE, P.AUTHOR, P.VCHID, P.OWNER]);
  let handle = unq(own);
  try { handle = decodeURIComponent(handle); } catch (e) { /* 그대로 */ }
  return { url: page, vid, title: unq(title), owner: unq(owner), channel_id: chid || "", handle };
}

/* ---------------- 채팅 수집 ---------------- */
function extractJsonAfter(html, key) {
  let i = html.indexOf(key);
  if (i < 0) throw new Error("채팅 페이지를 읽지 못했습니다");
  i = html.indexOf("{", i);
  if (i < 0) throw new Error("채팅 페이지를 읽지 못했습니다");
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return JSON.parse(html.slice(i, j + 1)); }
  }
  throw new Error("채팅 데이터 해석 실패");
}

function nextCont(conts) {
  for (const c of conts || []) {
    for (const k of ["invalidationContinuationData", "timedContinuationData",
                     "reloadContinuationData", "liveChatReplayContinuationData"]) {
      if (c[k]) return [c[k].continuation, parseInt(c[k].timeoutMs || 3000, 10)];
    }
  }
  return [null, 0];
}

function runsText(m) {
  const out = [];
  for (const r of (m && m.runs) || []) {
    if ("text" in r) out.push(r.text);
    else if (r.emoji) out.push(((r.emoji.shortcuts || [""])[0]) || "");
  }
  return out.join("");
}

function* parseActions(actions) {
  for (const a of actions || []) {
    const item = ((a.addChatItemAction || {}).item) || {};
    for (const key of ["liveChatTextMessageRenderer", "liveChatPaidMessageRenderer",
                       "liveChatPaidStickerRenderer", "liveChatMembershipItemRenderer"]) {
      const r = item[key];
      if (!r) continue;
      const money = (r.purchaseAmountText || {}).simpleText;
      const text = runsText(r.message) || runsText(r.headerSubtext);
      yield {
        id: r.id,
        name: (r.authorName || {}).simpleText || "",
        cid: r.authorExternalChannelId || "",
        text: money ? `[${money}] ${text}` : text,
        ts: Number(r.timestampUsec || 0) / 1000,   // 사용자가 실제로 채팅을 입력한 시각(ms)
      };
    }
  }
}

/* 세션: 시작~중지 한 번의 감시 */
let S = null;
function wait(sess, ms) {
  return new Promise((res) => {
    if (sess.stopped) return res();
    const done = () => { clearTimeout(t); sess.waiters.delete(done); res(); };
    const t = setTimeout(done, ms);
    sess.waiters.add(done);
  });
}

async function ownChat(sess, idx, url) {
  const vid = videoId(url);
  if (!vid) throw new Error("방송 주소에서 영상 ID를 찾지 못했습니다");
  const [idata, vm] = await getParts(chatUrl(vid), ["json:ytInitialData", P.VER]);
  if (!idata) throw new Error("채팅 페이지를 읽지 못했습니다 (페이지 " + lastPageLen + "자)");
  const ver = vm || "2.20261001.00.00";
  const lcr = (JSON.parse(idata).contents || {}).liveChatRenderer;
  if (!lcr) throw new Error("채팅이 꺼져 있거나 라이브가 아닙니다");

  // '실시간 채팅'(전체) 선택 — 기본값 '인기 채팅'은 일부 채팅이 빠짐
  let cont = null;
  try {
    const items = lcr.header.liveChatHeaderRenderer.viewSelector.sortFilterSubMenuRenderer.subMenuItems;
    cont = items[items.length - 1].continuation.reloadContinuationData.continuation;
  } catch (e) { /* 없음 */ }
  if (!cont) cont = nextCont(lcr.continuations)[0];

  const seen = new Set(), order = [];
  const emit = (actions) => {
    for (const m of parseActions(actions)) {
      if (m.id) {
        if (seen.has(m.id)) continue;
        seen.add(m.id); order.push(m.id);
        if (order.length > 5000) seen.delete(order.shift());
      }
      onMsg(sess, idx, m);
    }
  };

  status(sess, idx, `#${idx} 채팅 연결됨 (실시간 채팅 전체, 최근 채팅부터 확인)`);
  emit(lcr.actions);
  let fails = 0;
  while (cont && !sess.stopped) {
    let j;
    try {
      const r = await http("POST", API, Object.assign({ "Content-Type": "application/json" }, UA),
        JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver, hl: "ko", gl: "KR" } },
                         continuation: cont }));
      if (r.status >= 400) throw new Error("HTTP " + r.status);
      j = JSON.parse(r.text);
      fails = 0;
    } catch (e) {
      if (++fails >= 5) throw e;
      await wait(sess, 3000);
      continue;
    }
    const lcc = (j.continuationContents || {}).liveChatContinuation;
    if (!lcc) break;
    emit(lcc.actions);
    const [c, t] = nextCont(lcc.continuations);
    cont = c;
    await wait(sess, Math.min(Math.max(t / 1000, 1), 5) * 1000);
  }
  if (!sess.stopped) status(sess, idx, `#${idx} 채팅 종료(방송 끝남?)`);
}

async function chatWorker(sess, idx, url) {
  while (!sess.stopped) {
    try { await ownChat(sess, idx, url); return; }
    catch (e) {
      status(sess, idx, `#${idx} 채팅 연결 오류: ${e.message} → ${RETRY_SEC}초 후 재시도`);
      await wait(sess, RETRY_SEC * 1000);
    }
  }
}

async function roomWorker(sess, idx, url) {
  try { onInfo(sess, idx, await videoInfo(url)); }
  catch (e) {
    onInfo(sess, idx, { url, vid: videoId(url), title: "", owner: "", channel_id: "", handle: "" });
    status(sess, idx, `#${idx} 방 정보 읽기 실패: ${e.message}`);
  }
  await chatWorker(sess, idx, url);
}

async function channelWatcher(sess, idx, src, shown) {
  const base = channelBase(src);
  status(sess, idx, `#${idx} 채널 대기 중: ${shown || src} (라이브가 켜지면 자동 연결)`);
  if (idx > 1) await wait(sess, Math.min(idx - 1, 20) * STAGGER_MS); // 방송 많을 때 동시 요청 분산
  if (sess.stopped) return;
  let lastErr = null;
  while (!sess.stopped) {
    let vid = null;
    try { vid = await findLive(base); lastErr = null; }
    catch (e) {
      if (e.message !== lastErr) {
        lastErr = e.message;
        status(sess, idx, `#${idx} 채널 확인 오류: ${e.message} (계속 재시도)`);
      }
    }
    if (sess.stopped) return;
    if (vid) {
      status(sess, idx, `#${idx} 라이브 감지! https://youtu.be/${vid}`, "ok");
      await roomWorker(sess, idx, watchUrl(vid));
      if (sess.stopped) return;
      status(sess, idx, `#${idx} 방송 종료 → 다시 채널 대기`);
      await wait(sess, 120000);
    } else {
      // 방송 상태 탭에 '마지막 확인 시각' 표시 → 멈춘 건지 기다리는 중인지 구분
      const st = sess.streams[idx];
      if (st && sess === S) { st.checked = Date.now(); if (!lastErr) { st.state = "대기 (라이브 아님)"; st.cls = "wait"; } }
      await wait(sess, CHECK_SEC * 1000);
    }
  }
}

/* ---------------- 화면 ---------------- */
const logEl = $("log");
function write(text, cls, onClick) {
  const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text instanceof Node) d.appendChild(text); else d.textContent = text;
  if (onClick) d.addEventListener("click", onClick);
  logEl.appendChild(d);
  while (logEl.childNodes.length > MAX_LOG) logEl.removeChild(logEl.firstChild);
  if (near) logEl.scrollTop = logEl.scrollHeight;
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}
const now = () => new Date().toTimeString().slice(0, 8);
/* 사용자가 실제로 입력한 시각 (없으면 받은 시각) */
const chatTime = (m) => (m && m.ts > 1e12 ? new Date(m.ts) : new Date()).toTimeString().slice(0, 8);
/* ---------------- 체크박스 목록 ---------------- */
const items = { urls: [], targets: [] };
const running = () => !!(S && !S.stopped);

const SCOPES = [["both", "둘 다"], ["name", "닉네임만"], ["text", "내용만"]];
function newItem(text, on, meta) {
  meta = meta || {};
  return { text, on: on !== false, memo: String(meta.memo || ""), scope: meta.scope || "both",
           exact: !!meta.exact, auto_off: !!meta.auto_off, cid: String(meta.cid || ""),
           label: String(meta.label || ""), handle: String(meta.handle || ""), open: false };
}
/* 체크된 줄만 (빈 줄·중복 제외) */
function active(kind) {
  const out = [];
  for (const it of items[kind]) { const t = it.text.trim(); if (it.on && t && !out.includes(t)) out.push(t); }
  return out;
}
function activeItems() {
  const out = [], seen = new Set();
  for (const it of items.targets) {
    const t = it.text.trim();
    if (it.on && t && !seen.has(t)) { seen.add(t); out.push(it); }
  }
  return out;
}
function metaOf() {
  const out = {};
  for (const it of items.targets) {
    const m = {};
    if (it.memo.trim()) m.memo = it.memo.trim();
    if (it.scope !== "both") m.scope = it.scope;
    if (it.exact) m.exact = true;
    if (it.auto_off) m.auto_off = true;
    if (it.cid) m.cid = it.cid;
    if (Object.keys(m).length && it.text.trim()) out[it.text.trim()] = m;
  }
  return out;
}
function addLines(kind, text) {
  if (kind === "urls" && running()) { toast("감시 중에는 방송 주소를 바꿀 수 없습니다"); return 0; }
  let n = 0;
  for (let l of String(text || "").split(/\r?\n/)) {
    l = l.trim();
    if (l && !items[kind].some((it) => it.text === l)) { items[kind].push(newItem(l, true)); n++; }
  }
  if (n) { render(kind); changed(kind); if (kind === "urls") fetchLabels(); }
  return n;
}
function changed(kind) {
  saveSoon();
  if (kind === "targets" && running()) S.targets = activeItems();  // 감시 중에도 바로 반영
}
function render(kind) {
  const list = $(kind + "List");
  list.innerHTML = "";
  items[kind].forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "item" + (it.on ? "" : " off");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = it.on;
    cb.onchange = () => {
      if (kind === "urls" && running()) { cb.checked = it.on; toast("감시 중에는 방송 주소를 바꿀 수 없습니다"); return; }
      it.on = cb.checked; row.classList.toggle("off", !it.on); count(kind); changed(kind);
    };
    const tx = document.createElement("input");
    tx.type = "text"; tx.value = it.text; tx.spellcheck = false; tx.autocapitalize = "off";
    tx.onchange = () => {
      const v = tx.value.trim();
      if (!v) { items[kind].splice(i, 1); render(kind); } else it.text = v;
      changed(kind);
    };
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { items[kind].splice(i, 1); render(kind); changed(kind); };
    if (kind !== "targets") {
      // 방송 주소 옆에 채널 이름 표시 (예: @GOMoo [고무장갑 - 간호사의 폭로])
      row.classList.add("t");
      const lab = document.createElement("div"); lab.className = "sum lab";
      let lt = it.label;
      const h0 = handleOf(it.text);
      if (lt && it.handle && h0 && normHandle(h0) !== normHandle(it.handle)) lt += ` · 🔄 지금 ${it.handle}`;
      if (lt && it.cid && isChannel(it.text)) lt += " · ID✔";
      lab.textContent = lt ? `[${lt}]` : "";
      lab.style.display = it.label ? "" : "none";
      row.append(cb, tx, del, lab); list.appendChild(row); return;
    }

    // 찾을 대상: ⚙ 로 메모 · 검색 범위 · 정확히 · 찾으면 끄기 · 저장된 채널 ID
    row.classList.add("t");
    if (it.open) row.classList.add("open");
    const gear = document.createElement("button");
    gear.className = "gear"; gear.textContent = "⚙";
    gear.onclick = () => { it.open = !it.open; row.classList.toggle("open", it.open); };
    const sum = document.createElement("div"); sum.className = "sum";
    const fillSum = () => {
      const parts = [];
      if (it.memo.trim()) parts.push("📝 " + it.memo.trim());
      if (it.scope !== "both") parts.push(SCOPES.find((x) => x[0] === it.scope)[1]);
      if (it.exact) parts.push("정확히");
      if (it.auto_off) parts.push("찾으면 끄기");
      sum.textContent = parts.join(" · ");
      if (it.cid) { const b = document.createElement("b"); b.textContent = (parts.length ? " · " : "") + "ID✔"; sum.appendChild(b); }
      sum.style.display = sum.textContent ? "" : "none";
    };
    const opt = document.createElement("div"); opt.className = "opt";
    const memo = document.createElement("input");
    memo.type = "text"; memo.placeholder = "메모 (예: 단골, 이벤트 당첨자)"; memo.value = it.memo;
    memo.onchange = () => { it.memo = memo.value; fillSum(); changed(kind); };
    const sel = document.createElement("select");
    for (const [k, l] of SCOPES) { const o = document.createElement("option"); o.value = k; o.textContent = l; sel.appendChild(o); }
    sel.value = it.scope;
    sel.onchange = () => { it.scope = sel.value; fillSum(); changed(kind); };
    const mk = (label, key) => {
      const lb = document.createElement("label"), c = document.createElement("input");
      c.type = "checkbox"; c.checked = it[key];
      c.onchange = () => { it[key] = c.checked; fillSum(); changed(kind); };
      lb.append(c, label); return lb;
    };
    opt.append(memo, sel, mk("정확히", "exact"), mk("찾으면 끄기", "auto_off"));
    if (it.cid) {
      const idb = document.createElement("button");
      idb.className = "idbtn"; idb.textContent = "저장된 ID 지우기";
      idb.onclick = () => ask(`'${it.text}'에 저장된 채널 ID를 지울까요?\n${it.cid}`, () => {
        it.cid = ""; render(kind); changed(kind);
      });
      opt.append(idb);
    }
    fillSum();
    row.append(cb, tx, gear, del, sum, opt);
    list.appendChild(row);
  });
  count(kind);
}
function count(kind) {
  $(kind + "Cnt").textContent = `${items[kind].length}개 중 ${items[kind].filter((x) => x.on).length}개 사용`;
}
function setAll(kind, on) {
  if (kind === "urls" && running()) { toast("감시 중에는 방송 주소를 바꿀 수 없습니다"); return; }
  items[kind].forEach((it) => { it.on = on; });
  render(kind); changed(kind);
}
function copyAll(kind) {
  const text = items[kind].map((it) => it.text).join("\n");
  if (!text) { toast("복사할 내용이 없습니다"); return; }
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { /* 무시 */ }
    ta.remove();
    toast(ok ? "전체 복사했습니다" : "복사하지 못했습니다");
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast("전체 복사했습니다"), fallback);
  } else fallback();
}
function setItems(kind, all, off, meta) {
  const offSet = new Set((off || []).map(String));
  meta = meta && typeof meta === "object" ? meta : {};
  items[kind] = [];
  for (let t of all || []) {
    t = String(t).trim();
    if (t && !items[kind].some((it) => it.text === t)) items[kind].push(newItem(t, !offSet.has(t), meta[t]));
  }
  render(kind);
}

/* 확인 창 (지우기 / 아니요) */
function ask(text, onYes, opts) {
  opts = opts || {};
  const inp = $("modalInput");
  $("modalText").textContent = text;
  $("modalYes").textContent = opts.yes || "지우기";
  inp.style.display = opts.input !== undefined ? "block" : "none";
  inp.value = opts.input || "";
  $("modal").classList.add("show");
  if (opts.input !== undefined) setTimeout(() => inp.focus(), 50);
  $("modalYes").onclick = () => { $("modal").classList.remove("show"); onYes(inp.value); };
  $("modalNo").onclick = () => { $("modal").classList.remove("show"); if (opts.onNo) opts.onNo(); };
}

function status(sess, idx, text, cls) {
  if (sess !== S || sess.stopped) return;
  write(text, cls || (text.includes("연결됨") ? "ok" : "status"));
  const st = sess.streams[idx];
  if (!st) return;
  if (text.includes("채널 대기 중") || text.includes("다시 채널 대기")) Object.assign(st, { state: "대기 (라이브 아님)", cls: "wait", url: "" });
  else if (text.includes("라이브 감지")) Object.assign(st, { state: "라이브 감지", cls: "live" });
  else if (text.includes("연결됨")) Object.assign(st, { state: "채팅 연결됨", cls: "live" });
  else if (text.includes("채팅 종료")) Object.assign(st, { state: "방송 종료", cls: "wait" });
  else if (text.includes("오류") || text.includes("실패") || text.includes("중단")) Object.assign(st, { state: "오류 · 재시도 중", cls: "err" });
  renderBoard();
}
function roomText(info) {
  info = info || {};
  return `채널: ${info.owner || "?"} ${info.handle || ""} | 제목: ${(info.title || "").slice(0, 40)}`;
}
function onInfo(sess, idx, info) {
  if (sess !== S || sess.stopped) return;
  sess.infos[idx] = info;
  write(`#${idx} 방 정보: ${roomText(info)}`, "ok");
  const src = (sess.streams[idx] || {}).src;
  if (src && info.owner) {
    const ch = isChannel(src);
    setLabel(src, ch ? info.owner : `${info.owner} - ${(info.title || "").slice(0, 30)}`,
             ch ? info.channel_id : "", ch ? info.handle : "");
  }
  const st = sess.streams[idx];
  if (st) { st.channel = `${info.owner || ""} ${info.handle || ""}`.trim(); st.title = info.title || ""; st.url = info.vid ? watchUrl(info.vid) : (info.url || ""); renderBoard(); }
}
function updateStats() {
  $("stats").textContent = `찾은 채팅 ${S ? S.found.length : 0}건 · 받은 채팅 ${S ? S.recv : 0}개`;
}

function openStream(url) {
  if (!url) return;
  if (A) A.openUrl(url); else window.open(url, "_blank");
}

function onMsg(sess, idx, m) {
  if (sess !== S || sess.stopped) return;
  sess.recv++;
  flow.add(idx, m.text);
  const st = sess.streams[idx];
  if (st) { st.recv = (st.recv || 0) + 1; st.last = Date.now(); if (st.state !== "수신 중") { st.state = "수신 중"; st.cls = "live"; renderBoard(); } }
  if (!sess.receiving.has(idx)) { sess.receiving.add(idx); write(`#${idx} 채팅 수신 중 ✔`, "ok"); }
  let item = null, where = null;
  for (const it of sess.targets) { where = matchItem(m.name, m.cid, m.text, it, sess.searchText); if (where) { item = it; break; } }
  const hit = item ? item.text.trim() : null;
  if (item) {
    const info = sess.infos[idx] || {};
    const url = info.vid ? watchUrl(info.vid) : (info.url || "");
    const t = chatTime(m), memo = item.memo.trim(), memoTxt = memo ? ` [${memo}]` : "";
    sess.found.push([t, idx, info.title || "", m.name, m.cid, m.text, hit,
                     info.owner || "", info.handle || "", url, where, memo]);

    // 닉네임으로 찾으면 채널 ID 기억 → 닉네임을 바꿔도 계속 찾음
    if (where === "닉네임" && m.cid && !isChannelId(hit) && item.cid !== m.cid) {
      item.cid = m.cid; render("targets"); saveSoon();
      write(`    🆔 '${hit}' 채널 ID 저장: ${m.cid}`, "status");
    }

    // 같은 사람·같은 방은 처음 한 번만 알림
    const akey = `${info.vid || idx}|${m.cid || m.name}|${hit}`;
    const first = !sess.alerted.has(akey);
    sess.alerted.add(akey);
    if (!first && sess.alertOnce) {
      write(`  · [${t}] 방송${idx} ${m.name}${memoTxt}: ${m.text}`, "status", () => openStream(url));
    } else {
      const box = document.createElement("span");
      box.append(`★ [${t}] 방송${idx} (${where} 일치: ${hit})${memoTxt} — ${roomText(info)}`);
      const msg = document.createElement("span"); msg.className = "msg"; msg.textContent = `${m.name}: ${m.text}`;
      const tap = document.createElement("span"); tap.className = "tap"; tap.textContent = "눌러서 방송 열기";
      box.append(msg, tap);
      write(box, "found", () => openStream(url));
      if (A) A.notifyFound(`★ ${m.name}${memoTxt} (${where} 일치)`, `${info.owner || ""} ${info.handle || ""} · ${info.title || ""}\n${m.name}: ${m.text}`, url);
    }

    // 찾은 기록 (같은 사람·같은 방은 한 번만)
    if (first) addHistory({ time: stampFull(m.ts), target: hit, memo, where, name: m.name, cid: m.cid, text: m.text,
                            owner: info.owner || "", handle: info.handle || "", title: info.title || "", url });

    // 찾으면 끄기
    if (item.auto_off && item.on) {
      item.on = false; render("targets"); sess.targets = activeItems(); saveSoon();
      write(`    ⏹ '${hit}' 찾아서 체크를 껐습니다`, "status");
    }

    const key = info.vid || url;
    if (first && sess.openStream && url && !sess.opened.has(key)) {
      sess.opened.add(key);
      write(`    → 유튜브로 방송 열기: ${url}`, "ok");
      openStream(url);
    }
  } else if (sess.showAll) {
    write(`[${chatTime(m)}] #${idx} ${m.name}: ${m.text}`);
  }
  if (sess.recv % 10 === 0 || hit) updateStats();
}

/* ---------------- 설정 ---------------- */
function data() {
  return {
    app: "유튜브채팅찾기", version: 1,
    urls: items.urls.map((it) => it.text), targets: items.targets.map((it) => it.text),
    urls_off: items.urls.filter((it) => !it.on).map((it) => it.text),
    targets_off: items.targets.filter((it) => !it.on).map((it) => it.text),
    targets_meta: metaOf(),
    urls_meta: Object.fromEntries(items.urls.filter((it) => (it.label || it.cid) && it.text.trim()).map((it) => {
      const m = {}; if (it.label) m.label = it.label; if (it.cid) m.cid = it.cid; if (it.handle) m.handle = it.handle;
      return [it.text.trim(), m];
    })), alert_once: $("optOnce").checked, surge_alert: $("optSurge").checked, presets,
    auto_start: $("optAuto").checked, open_chrome: $("optOpen").checked,
    search_text: $("optText").checked, show_all: $("optAll").checked,
  };
}
function apply(d) {
  setItems("urls", d.urls, d.urls_off, d.urls_meta);
  setTimeout(fetchLabels, 300);
  setItems("targets", d.targets, d.targets_off, d.targets_meta);
  if ("alert_once" in d) $("optOnce").checked = !!d.alert_once;
  if ("surge_alert" in d) $("optSurge").checked = !!d.surge_alert;
  if (d.presets && typeof d.presets === "object") { presets = d.presets; renderPresets(); }
  $("optAuto").checked = !!d.auto_start;
  $("optOpen").checked = d.open_chrome !== false;
  $("optText").checked = d.search_text !== false;
  $("optAll").checked = !!d.show_all;
}
function save() {
  const s = JSON.stringify(data());
  try { if (A) A.saveSettings(s); else localStorage.setItem("settings", s); } catch (e) { /* 무시 */ }
}
function load() {
  let s = null;
  try { s = A ? A.loadSettings() : localStorage.getItem("settings"); } catch (e) { /* 무시 */ }
  if (!s) return null;
  try { const d = JSON.parse(s); apply(d); return d; } catch (e) { return null; }
}
let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

/* ---------------- 시작/중지 ---------------- */
function setRunning(on) {
  $("startBtn").disabled = on; $("stopBtn").disabled = !on;
  $("urlsList").parentElement.classList.toggle("locked", on);
  $("state").textContent = on ? "감시 중" : "대기";
}

function start() {
  if (S && !S.stopped) return;
  if (!licenseOff()) {
    if (licensed === false) { licenseBlock(lic.msg); return; }
    if (licensed === null) { toast("확인 중입니다. 잠시 후 다시 눌러 주세요"); return; }
  }
  addLines("urls", $("urlsAdd").value); $("urlsAdd").value = "";
  addLines("targets", $("targetsAdd").value); $("targetsAdd").value = "";
  const urls = active("urls"), targets = activeItems();
  if (!urls.length) { toast("체크된 방송 주소나 채널 주소가 없습니다"); return; }
  if (!targets.length) { toast("체크된 찾을 사용자나 검색어가 없습니다"); return; }
  save();
  S = {
    stopped: false, waiters: new Set(), infos: {}, opened: new Set(), receiving: new Set(),
    found: [], recv: 0, targets, alerted: new Set(), streams: {},
    searchText: $("optText").checked, openStream: $("optOpen").checked, showAll: $("optAll").checked,
    alertOnce: $("optOnce").checked,
  };
  urls.forEach((u, i) => { S.streams[i + 1] = { src: u, state: "시작 중", cls: "wait", recv: 0, last: 0 }; });
  renderBoard();
  resetFlow();
  const sess = S;
  setRunning(true); updateStats();
  write(`=== 감시 시작: 방송 ${urls.length}개, 찾을 대상 ${targets.length}개 ===`, "ok");
  if (A) A.startWatch(urls.length);
  urls.forEach((u, i) => {
    const idx = i + 1;
    // 저장된 채널 ID가 있으면 그걸로 라이브 확인 → 주인장이 핸들을 바꿔도 계속 찾음
    const it = items.urls.find((x) => x.text.trim() === u);
    (isChannel(u) ? channelWatcher(sess, idx, (it && it.cid) || u, u) : roomWorker(sess, idx, u))
      .catch((e) => status(sess, idx, `#${idx} 중단됨: ${e.message}`));
  });
}

function stop() {
  if (!S || S.stopped) return;
  write(`=== 중지됨: 찾은 채팅 ${S.found.length}건, 받은 채팅 ${S.recv}개 ===`, "ok");
  S.stopped = true;
  for (const w of [...S.waiters]) w();
  if (A) A.stopWatch();
  for (const st of Object.values(S.streams)) Object.assign(st, { state: "중지됨", cls: "wait" });
  renderBoard();
  setRunning(false); updateStats();
}

/* ---------------- 파일 ---------------- */
window.__fileSaved = (ok) => toast(ok ? "저장했습니다" : "저장을 취소했습니다");
window.__fileOpened = (text) => {
  if (text == null) return;
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || !Array.isArray(d.urls || []) || !Array.isArray(d.targets || []))
      throw new Error("이 프로그램의 설정 파일이 아닙니다");
    apply(d); save();
    write(`📥 설정을 불러왔습니다: 주소 ${items.urls.length}개, 찾을 대상 ${items.targets.length}개`, "ok");
  } catch (e) { toast("불러오지 못했습니다: " + e.message); }
};
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function saveFile(name, mime, content) {
  if (A) { A.saveFile(name, mime, content); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name; a.click();
}
function exportJson() {
  const d = data(); delete d.show_all;
  saveFile(`채팅찾기설정_${stamp()}.json`, "application/json", JSON.stringify(d, null, 2));
}
function importJson() {
  if (S && !S.stopped) { toast("감시를 중지한 뒤 불러와 주세요"); return; }
  if (A) { A.openFile(); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = () => { const f = inp.files[0]; if (f) f.text().then(window.__fileOpened); };
  inp.click();
}
function exportCsv() {
  if (!S || !S.found.length) { toast("아직 찾은 채팅이 없습니다"); return; }
  const head = ["시각", "방송번호", "방송제목", "닉네임", "채널ID", "메시지", "일치대상", "채널이름", "채널핸들", "방송주소", "일치위치", "메모"];
  const esc = (v) => { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = "﻿" + [head, ...S.found].map((r) => r.map(esc).join(",")).join("\r\n");
  saveFile(`채팅찾기결과_${stamp()}.csv`, "text/csv", csv);
}

/* ---------------- 연결 ---------------- */
$("startBtn").onclick = start;
$("stopBtn").onclick = stop;
$("exportBtn").onclick = exportJson;
$("importBtn").onclick = importJson;
$("csvBtn").onclick = exportCsv;
$("clearBtn").onclick = () => {
  if (running()) { toast("감시 중에는 지울 수 없습니다"); return; }
  if (!items.urls.length && !items.targets.length) { toast("지울 내용이 없습니다"); return; }
  ask(`방송 주소 ${items.urls.length}개와 찾을 대상 ${items.targets.length}개를 모두 지울까요?`, () => {
    setItems("urls", []); setItems("targets", []); save(); toast("모두 지웠습니다");
  });
};
$("batteryBtn").onclick = () => { if (A) A.batteryOpt(); else toast("앱에서만 사용할 수 있습니다"); };

/* ---------------- 오류 표시 · 진단 ---------------- */
window.addEventListener("error", (e) => write(`⚠ 앱 오류: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`, "status"));
window.addEventListener("unhandledrejection", (e) => write(`⚠ 앱 오류: ${(e.reason && e.reason.message) || e.reason}`, "status"));

async function diagnose() {
  const out = [];
  const add = (k, v) => { out.push(`${k}: ${v}`); write(`🩺 ${k}: ${v}`, "status"); };
  write("🩺 진단 시작…", "ok");
  try { const d = A && A.diagInfo ? JSON.parse(A.diagInfo()) : {};
    add("기기", `${d.model || "?"} / Android ${d.android || "?"} / 앱 ${d.app || "?"}`);
    add("화면(JS) 버전", JS_VER + " ← 이게 안 보이면 옛날 app.js가 로딩된 것");
    add("배터리 제한 없음", d.batteryUnrestricted ? "예" : "아니요 ← [배터리 최적화 해제] 필요");
    add("알림 허용", d.notifications ? "예" : "아니요 ← 설정에서 알림 허용 필요");
  } catch (e) { add("기기 정보", "읽기 실패 " + e.message); }
  const cv = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "?";
  add("WebView 버전", cv + (parseInt(cv, 10) < 90 ? " ← 너무 오래됨: Play 스토어에서 Android System WebView 업데이트" : ""));
  add("빠른 추출 기능", A && A.requestX ? "있음" : "없음 (예전 앱)");
  if (!licenseOff()) { add("사용 상태", licensed === true ? "정상" : licensed === false ? "사용 중지됨" : "확인 중"); add("기기번호", lic.code || "-"); }
  const t0 = Date.now();
  try { const [v] = await getParts("https://www.youtube.com/", [P.VER]);
    add("유튜브 접속", `성공 (${Date.now() - t0}ms, 페이지 ${lastPageLen}자, 버전 ${v || "?"})`);
  } catch (e) { add("유튜브 접속", "실패 — " + e.message); }
  const chans = items.urls.filter((it) => it.on && it.text.trim()).slice(0, 3);
  for (const it of chans) {
    const u = it.text.trim();
    try {
      if (isChannel(u)) {
        const base = channelBase(it.cid || u);
        const [cv, lv, up, hls] = await getParts(safeUrl(base + "/live"), [P.CANON, P.LIVE, P.UPCOMING, P.HLS]);
        add(`라이브 확인 ${u}`, `watch=${cv || "없음"} isLiveNow=${lv ? "O" : "X"} 예정=${up ? "O" : "X"} HLS=${hls ? "O" : "X"} (페이지 ${lastPageLen}자)`);
        const vid = (cv && !(up && !lv)) ? cv : null;
        if (vid) await diagChat(vid, add); else add(`  판정 ${u}`, "라이브 아님으로 처리");
      } else {
        const vid = videoId(u);
        add(`방송 주소 ${u}`, vid ? `영상 ID ${vid}` : "영상 ID를 못 찾음");
        if (vid) await diagChat(vid, add);
      }
    } catch (e) { add(`확인 ${u}`, "실패 — " + e.message); }
  }
  if (S && !S.stopped) add("감시 상태", `받은 채팅 ${S.recv}개 · 방송 ${Object.keys(S.streams).length}개`);
  write("🩺 진단 끝 — 아래 [진단 결과 복사]를 눌러 보내 주세요", "ok");
  const text = "[유튜브채팅찾기 진단]\n" + out.join("\n");
  write(Object.assign(document.createElement("span"), { textContent: "📋 진단 결과 복사 (눌러서 복사)" }), "found", () => copyText(text));
}
async function diagChat(vid, add) {
  try {
    const [idata] = await getParts(chatUrl(vid), ["json:ytInitialData"]);
    if (!idata) { add("  채팅 페이지", `데이터 없음 (페이지 ${lastPageLen}자)`); return; }
    const lcr = (JSON.parse(idata).contents || {}).liveChatRenderer;
    add("  채팅 페이지", lcr ? `정상 (채팅 ${(lcr.actions || []).length}개 미리보기)` : "채팅이 꺼져 있거나 라이브 아님");
  } catch (e) { add("  채팅 페이지", "실패 — " + e.message); }
}
function copyText(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { /* 무시 */ }
  ta.remove();
  toast(ok ? "진단 결과를 복사했습니다. 카톡 등에 붙여넣어 보내 주세요" : "복사하지 못했습니다. 화면을 캡처해 주세요");
}
$("diagBtn").onclick = () => diagnose().catch((e) => write("🩺 진단 오류: " + e.message, "status"));
$("deviceBtn").onclick = () => {
  if (licenseOff()) { toast("원격 사용 관리가 꺼져 있습니다"); return; }
  if (!lic.code) lic.code = genDeviceId(), licSave();
  copyText(lic.code);
  write(`📋 기기번호: ${lic.code}`, "status");
};
for (const kind of ["urls", "targets"]) {
  const box = $(kind + "Add");
  // 붙여넣으면 바로 목록에 추가
  box.addEventListener("paste", () => setTimeout(() => {
    if (addLines(kind, box.value) || !box.value.trim()) box.value = "";
  }, 0));
  render(kind);
}
document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
  const k = b.dataset.add, box = $(k + "Add");
  if (!box.value.trim()) { toast("추가할 내용을 입력하세요"); return; }
  addLines(k, box.value); box.value = "";
});
document.querySelectorAll("[data-all]").forEach((b) => b.onclick = () => setAll(b.dataset.all, true));
document.querySelectorAll("[data-none]").forEach((b) => b.onclick = () => setAll(b.dataset.none, false));
document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => copyAll(b.dataset.copy));
for (const id of ["optText", "optOpen", "optAuto", "optAll", "optOnce", "optSurge"]) $(id).addEventListener("change", () => {
  save();
  if (S && !S.stopped) {
    S.searchText = $("optText").checked; S.openStream = $("optOpen").checked; S.showAll = $("optAll").checked;
    S.alertOnce = $("optOnce").checked;
  }
});

/* ---------------- 탭 ---------------- */
document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.id === "pane-" + b.dataset.tab));
  if (b.dataset.tab === "board") renderBoard();
  if (b.dataset.tab === "flow") flowUpdate();
  if (b.dataset.tab === "hist") renderHistory();
});

/* ---------------- 방송 상태판 ---------------- */
function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`;
}
function renderBoard() {
  const el = $("board");
  if (!$("pane-board").classList.contains("on")) return;
  el.innerHTML = "";
  if (!S) { el.textContent = "감시를 시작하면 방송별 상태가 여기에 표시됩니다."; return; }
  for (const [idx, st] of Object.entries(S.streams)) {
    const d = document.createElement("div"); d.className = "st " + (st.cls || "");
    const top = document.createElement("div"); top.className = "top";
    const a = document.createElement("span"); a.className = "state"; a.textContent = `#${idx} ${st.state || ""}`;
    const b = document.createElement("span");
    b.textContent = st.recv ? `채팅 ${st.recv} · ${ago(st.last)}` : (st.checked ? `확인 ${new Date(st.checked).toTimeString().slice(0, 8)}` : "-");
    top.append(a, b);
    const sub = document.createElement("div"); sub.className = "sub";
    sub.textContent = [st.channel, st.title, st.src].filter(Boolean).join(" · ");
    d.append(top, sub);
    const url = st.url || (st.src.startsWith("http") ? st.src : channelBase(st.src));
    d.onclick = () => openStream(url);
    el.appendChild(d);
  }
}
setInterval(() => { if (S && !S.stopped) renderBoard(); }, 1000);

/* ---------------- 채팅 흐름 (급증·많이 나온 말 감지) ---------------- */
const FLOW_BIN = 5, FLOW_BINS = 60, SURGE_RATIO = 2.5, SURGE_MIN_PER_MIN = 12, WORD_MIN = 4;
const FLOW_STOP = new Set(["그리고", "근데", "이거", "저거", "그거", "진짜", "너무", "있어", "없어", "하는", "에서", "으로",
  "the", "and", "you", "for", "this", "that", "lol"]);
function flowWords(text) {
  const t = String(text || "").normalize("NFC").toLowerCase().replace(/:[\w-]+:/g, " ");
  const out = new Set();
  for (let w of t.match(/[\p{L}\p{N}_]{2,}/gu) || []) {
    w = w.replace(/(.)\1{2,}/gu, "$1$1");
    if (w.length >= 2 && !FLOW_STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}
function makeFlow(clock) {
  clock = clock || (() => Date.now() / 1000);
  const s = {};
  const st = (idx) => s[idx] || (s[idx] = { bins: new Array(FLOW_BINS).fill(0), cur: 0, t0: clock(), nb: 0,
    wbins: [], wcur: new Map(), wlong: new Map(), lbins: 0, surge: false, lastAlert: -1e9 });
  const roll = (x) => {
    const steps = Math.floor((clock() - x.t0) / FLOW_BIN);
    if (steps <= 0) return;
    for (let k = 0; k < Math.min(steps, FLOW_BINS + 1); k++) {
      x.bins.push(x.cur); x.bins.shift();
      x.wbins.push(x.wcur); if (x.wbins.length > 6) x.wbins.shift();
      for (const [w, c] of x.wcur) x.wlong.set(w, (x.wlong.get(w) || 0) + c);
      x.lbins += 1; x.cur = 0; x.wcur = new Map(); x.nb += 1;
      if (x.nb % 12 === 0) {
        for (const [w, c] of x.wlong) { const v = c * 0.8; if (v < 0.5) x.wlong.delete(w); else x.wlong.set(w, v); }
        x.lbins *= 0.8;
      }
    }
    x.t0 += steps * FLOW_BIN;
  };
  return {
    reset() { for (const k of Object.keys(s)) delete s[k]; },
    add(idx, text) {
      const x = st(idx); roll(x); x.cur++;
      for (const w of flowWords(text)) x.wcur.set(w, (x.wcur.get(w) || 0) + 1);
    },
    stats(idx) {
      const x = st(idx); roll(x);
      const bins = x.bins.slice(), n = Math.min(x.nb, FLOW_BINS);
      const hist = n > 2 ? bins.slice(FLOW_BINS - n, FLOW_BINS - 2) : [];
      const base = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
      const cur = n >= 2 ? (bins[FLOW_BINS - 1] + bins[FLOW_BINS - 2]) / 2 : bins[FLOW_BINS - 1];
      const perMin = cur * (60 / FLOW_BIN);
      const ratio = n >= 8 ? cur / Math.max(base, 0.5) : 0;
      const surge = n >= 8 && ratio >= SURGE_RATIO && perMin >= SURGE_MIN_PER_MIN;
      const c30 = new Map();
      for (const m of x.wbins) for (const [w, c] of m) c30.set(w, (c30.get(w) || 0) + c);
      const sorted = [...c30.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
      const hot = [], top = [];
      for (const [w, c] of sorted) {
        if (c < WORD_MIN) break;
        const exp = (x.wlong.get(w) || 0) / Math.max(x.lbins, 1) * 6;
        if (x.lbins >= 12 && c >= 3 * Math.max(exp, 1)) hot.push([w, c]);
        else if (top.length < 3) top.push([w, c]);
      }
      const recent = bins.slice(-6).reduce((a, b) => a + b, 0) * 2;   // 최근 30초 기준 분당 (정렬용)
      return { bins, base, cur, perMin, ratio, surge, hot: hot.slice(0, 3), top, n, recent };
    },
    check(idx, cooldown = 60) {
      const x = st(idx), info = this.stats(idx);
      const isNew = info.surge && !x.surge && clock() - x.lastAlert >= cooldown;
      x.surge = info.surge;
      if (isNew) x.lastAlert = clock();
      return [info, isNew];
    },
  };
}
let flow = makeFlow();
const flowEls = {};
function flowUrl(st) { return st.url || (st.src.startsWith("http") ? st.src : channelBase(st.src)); }
function flowUpdate() {
  if (!S || S.stopped) return;
  const visible = $("pane-flow").classList.contains("on");
  const rates = {};
  for (const [idx, st] of Object.entries(S.streams)) {
    const [info, isNew] = flow.check(idx);
    if (isNew && $("optSurge").checked) {
      const words = (info.hot.length ? info.hot : info.top).map(([w, c]) => `${w}(${c})`).join(", ");
      const url = flowUrl(st), room = roomText(S.infos[idx]);
      write(`🔥 [${now()}] 방송${idx} 채팅 급증 ×${info.ratio.toFixed(1)} (분당 ${Math.round(info.perMin)}, 평소 ${Math.round(info.base * 12)}) — ${room}` +
            (words ? `\n많이 나온 말: ${words}` : ""), "found", () => openStream(url));
      if (A) A.notifyFound(`🔥 방송${idx} 채팅 급증 ×${info.ratio.toFixed(1)}`,
                           `${st.channel || st.src}\n${words ? "많이 나온 말: " + words : ""}`, url);
    }
    if (visible) { drawFlow(idx, st, info); rates[idx] = info.recent; }
  }
  // 트래픽 많은 방송이 맨 위로
  if (visible) {
    const box = $("flow");
    Object.keys(rates).sort((a, b) => rates[b] - rates[a] || a - b).forEach((idx) => {
      const e = flowEls[idx];
      if (e && box.lastChild !== e.root) box.appendChild(e.root);
    });
  }
}
function drawFlow(idx, st, info) {
  const box = $("flow");
  let e = flowEls[idx];
  if (!e || !box.contains(e.root)) {
    const root = document.createElement("div"); root.className = "fl";
    const top = document.createElement("div"); top.className = "top";
    const name = document.createElement("b"), rate = document.createElement("span");
    top.append(name, rate);
    const cv = document.createElement("canvas");
    const words = document.createElement("div"); words.className = "words";
    root.append(top, cv, words);
    box.appendChild(root);
    e = flowEls[idx] = { root, name, rate, cv, words };
    root.onclick = () => openStream(flowUrl(S.streams[idx] || st));
  }
  e.root.classList.toggle("surge", info.surge);
  e.name.textContent = (info.surge ? "🔥 " : "") + `#${idx} ${st.channel || st.src}`;
  e.rate.textContent = `분당 ${Math.round(info.perMin)} · 평소 ${Math.round(info.base * 12)}` +
                       (info.n >= 8 && info.base > 0 ? ` · ×${info.ratio.toFixed(1)}` : "");
  const ws = info.hot.length ? info.hot : info.top;
  e.words.textContent = ws.map(([w, c]) => `${w} ${c}`).join("  ") || " ";
  e.words.classList.toggle("hot", info.hot.length > 0);
  const cv = e.cv, dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 300, H = 40;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const scale = Math.max(Math.max(...info.bins), info.base * 3, 4), bw = W / FLOW_BINS;
  info.bins.forEach((v, i) => {
    if (!v) return;
    const h = Math.max(2, v / scale * (H - 2));
    const rr = info.n >= 8 && v >= 3 ? v / Math.max(info.base, 1) : 1;
    g.fillStyle = rr >= 3 ? "#e0574f" : rr >= 2 ? "#f2a07b" : "#5b8fd0";
    g.fillRect(i * bw, H - h, Math.max(bw - 1, 1), h);
  });
  if (info.base > 0) {
    const yb = H - Math.min(info.base / scale, 1) * (H - 2);
    g.strokeStyle = "#8b929c"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, yb); g.lineTo(W, yb); g.stroke(); g.setLineDash([]);
  }
}
function resetFlow() {
  flow.reset();
  for (const k of Object.keys(flowEls)) delete flowEls[k];
  $("flow").innerHTML = "";
}
setInterval(flowUpdate, 1000);


/* ---------------- 찾은 기록 (껐다 켜도 남음) ---------------- */
const MAX_HISTORY = 3000;
let histList = [];
function stampFull(ts) {
  const d = ts > 1e12 ? new Date(ts) : new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function loadHistory() {
  try {
    const s = A && A.loadKey ? A.loadKey("history") : localStorage.getItem("history");
    histList = s ? JSON.parse(s) : [];
    if (!Array.isArray(histList)) histList = [];
  } catch (e) { histList = []; }
}
function saveHistory() {
  const s = JSON.stringify(histList.slice(-MAX_HISTORY));
  try { if (A && A.saveKey) A.saveKey("history", s); else localStorage.setItem("history", s); } catch (e) { /* 무시 */ }
}
function addHistory(h) {
  histList.push(h);
  if (histList.length > MAX_HISTORY) histList = histList.slice(-MAX_HISTORY);
  saveHistory(); renderHistory();
}
function renderHistory() {
  const el = $("hist");
  const q = norm($("histQ").value);
  el.innerHTML = "";
  let shown = 0;
  for (let i = histList.length - 1; i >= 0 && shown < 500; i--) {
    const h = histList[i];
    const all = [h.time, h.target, h.memo, h.name, h.text, h.owner, h.handle, h.title].join(" ");
    if (q && !norm(all).includes(q)) continue;
    const d = document.createElement("div"); d.className = "h";
    const who = document.createElement("div"); who.className = "who";
    who.textContent = `${h.name}${h.memo ? " [" + h.memo + "]" : ""} — ${h.where} 일치: ${h.target}`;
    const msg = document.createElement("div"); msg.className = "msg"; msg.textContent = h.text;
    const sub = document.createElement("div"); sub.className = "sub";
    sub.textContent = `${h.time} · ${h.owner} ${h.handle} · ${h.title}`;
    d.append(who, msg, sub);
    d.onclick = () => openStream(h.url);
    el.appendChild(d); shown++;
  }
  if (!histList.length) el.textContent = "아직 찾은 기록이 없습니다.";
  $("histCnt").textContent = `${q ? "검색 결과 " + shown + "건 / " : ""}전체 ${histList.length}건 · 눌러서 방송 열기`;
}
$("histQ").addEventListener("input", renderHistory);
$("histClear").onclick = () => {
  if (!histList.length) { toast("지울 기록이 없습니다"); return; }
  ask(`찾은 기록 ${histList.length}건을 모두 지울까요?`, () => { histList = []; saveHistory(); renderHistory(); });
};
$("histCsv").onclick = () => {
  if (!histList.length) { toast("찾은 기록이 없습니다"); return; }
  const keys = ["time", "target", "memo", "where", "name", "cid", "text", "owner", "handle", "title", "url"];
  const head = ["날짜시각", "찾은대상", "메모", "일치위치", "닉네임", "채널ID", "메시지", "채널이름", "채널핸들", "방송제목", "방송주소"];
  const esc = (v) => { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = [head, ...histList.slice().reverse().map((h) => keys.map((k) => h[k]))];
  saveFile(`찾은기록_${stamp()}.csv`, "text/csv", "\ufeff" + rows.map((r) => r.map(esc).join(",")).join("\r\n"));
};

/* ---------------- 프리셋 ---------------- */
let presets = {};
function renderPresets(selected) {
  const sel = $("presetSel"), names = Object.keys(presets).sort();
  sel.innerHTML = "";
  if (!names.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "(저장된 프리셋 없음)"; sel.appendChild(o); return; }
  for (const n of names) { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); }
  if (selected) sel.value = selected;
}
$("presetSave").onclick = () => {
  ask("이 설정의 이름을 입력하세요\n(방송 목록 · 찾을 대상 · 옵션이 함께 저장됩니다)", (name) => {
    name = String(name || "").trim();
    if (!name) { toast("이름을 입력하세요"); return; }
    const d = data(); delete d.presets; delete d.app; delete d.version;
    const doSave = () => { presets[name] = d; renderPresets(name); save(); toast(`프리셋 '${name}' 저장`); };
    if (presets[name]) ask(`'${name}'이(가) 이미 있습니다. 덮어쓸까요?`, doSave, { yes: "덮어쓰기" });
    else doSave();
  }, { yes: "저장", input: $("presetSel").value || "" });
};
$("presetLoad").onclick = () => {
  const name = $("presetSel").value;
  if (!name || !presets[name]) { toast("불러올 프리셋이 없습니다"); return; }
  if (running()) { toast("감시를 중지한 뒤 불러와 주세요"); return; }
  const d = Object.assign({}, presets[name]); delete d.auto_start;
  // 프리셋 저장 뒤에 알게 된 채널 ID는 유지
  const known = {}; for (const it of items.targets) if (it.cid) known[it.text] = it.cid;
  d.targets_meta = JSON.parse(JSON.stringify(d.targets_meta || {}));
  for (const [t, cid] of Object.entries(known)) {
    if ((d.targets || []).includes(t) && !(d.targets_meta[t] || {}).cid) d.targets_meta[t] = Object.assign({}, d.targets_meta[t], { cid });
  }
  apply(d); save();
  write(`📥 프리셋 '${name}' 불러옴: 주소 ${items.urls.length}개, 찾을 대상 ${items.targets.length}개`, "ok");
};
$("presetDel").onclick = () => {
  const name = $("presetSel").value;
  if (!name || !presets[name]) return;
  ask(`프리셋 '${name}'을(를) 삭제할까요?`, () => { delete presets[name]; renderPresets(); save(); }, { yes: "삭제" });
};

write("주소와 찾을 사용자/검색어를 입력하고 [▶ 감시 시작]을 누르세요.", "status");
write("채널 주소(예: @채널핸들)를 넣으면 라이브가 켜질 때 자동으로 연결합니다.", "status");
write("화면을 꺼도 감시가 계속되도록 [배터리 최적화 해제]를 한 번 눌러 주세요.", "status");
if (!A) write("※ 지금은 브라우저에서 열려 있어 유튜브에 접속할 수 없습니다. 앱으로 설치해서 사용하세요.", "status");
/* ---------------- 공지·제목 (켤 때마다 최신) ---------------- */
async function loadNotice() {
  if (!A || NOTICE_URL.includes("<아이디>") || NOTICE_URL.includes("<저장소>")) return;
  let d = {};
  try {
    const r = await http("GET", NOTICE_URL + "?_=" + Date.now(), { "Cache-Control": "no-cache" });
    if (r.status < 400) d = JSON.parse(r.text);
  } catch (e) { /* 공지 못 읽으면 기본값 유지 */ }
  // 제목 버전 숫자: notice.json 에 ver 가 있으면 그걸, 없으면 version.json 의 web 을 그대로 사용
  // → 버전 숫자를 따로 입력할 필요 없이 version.json 의 web 하나만 올리면 제목도 같이 바뀜
  let ver = (d.ver != null) ? d.ver : null;
  if (ver == null) {
    try {
      const vurl = NOTICE_URL.replace(/notice\.json$/, "version.json");
      const r = await http("GET", vurl + "?_=" + Date.now(), { "Cache-Control": "no-cache" });
      if (r.status < 400) { const vj = JSON.parse(r.text); if (vj.web != null) ver = vj.web; }
    } catch (e) { /* version.json 못 읽으면 버전 표시 생략 */ }
  }
  try {
    const h1 = document.querySelector("header h1");
    const sub = document.querySelector("header span");
    if (h1) {
      // 제목 본문(버전 꼬리표 제외). notice.json 에 title 있으면 그걸 본문으로.
      let base = (d.title != null ? String(d.title) : (h1.textContent || "유튜브 채팅 찾기")).trim();
      base = base.replace(/\s*\(?v\d+\)?\s*$/i, "").trim();   // 기존 vNN / (vNN) 꼬리표 제거
      h1.textContent = (ver != null) ? `${base} (v${ver})` : base;
    }
    if (sub && d.subtitle != null) sub.textContent = d.subtitle;
    const nb = document.getElementById("noticeBar") || document.getElementById("testTag");
    if (nb && d.notice != null) {
      nb.textContent = d.notice;
      nb.style.display = d.notice ? "" : "none";
    }
  } catch (e) { /* 무시 */ }
}

/* ---------------- 원격 사용 관리 ---------------- */
// 아래 주소에 올린 JSON으로 누가 쓸 수 있는지 관리. (GitHub raw 또는 Gist raw 주소)
//   {"enabled": true, "allowed": ["코드1","코드2"], "revoked": ["코드3"], "message": "..."}
// 허용목록: allowed 에 있고 revoked 에 없는 코드만 사용 가능. 막으려면 그 코드를 revoked 에 추가.
const LICENSE_URL = "https://raw.githubusercontent.com/<아이디>/<저장소>/main/license.json";
// 공지/제목용. notice.json 의 raw 주소. (켤 때마다 읽어서 제목·공지를 최신으로 바꿈)
const NOTICE_URL = "https://raw.githubusercontent.com/<아이디>/<저장소>/main/notice.json";
const LICENSE_GRACE_DAYS = 3, LICENSE_RECHECK_MS = 3600 * 1000;
const LICENSE_MSG = "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
function licenseOff() { return !A || LICENSE_URL.includes("<아이디>") || LICENSE_URL.includes("<저장소>"); }
let lic = { code: "", okAt: 0, state: "unknown", msg: LICENSE_MSG };
let licensed = null, licChecking = false, licLastNet = 0;
function licLoad() {
  try { const s = A && A.loadKey ? A.loadKey("lic") : localStorage.getItem("lic"); if (s) Object.assign(lic, JSON.parse(s)); } catch (e) { /* 무시 */ }
}
function licSave() {
  const s = JSON.stringify({ code: lic.code, okAt: lic.okAt, state: lic.state, msg: lic.msg });
  try { if (A && A.saveKey) A.saveKey("lic", s); else localStorage.setItem("lic", s); } catch (e) { /* 무시 */ }
}
async function checkLicense() {
  if (licChecking || licenseOff()) return;
  licChecking = true; licLastNet = Date.now();
  let data = null;
  try {
    const r = await http("GET", LICENSE_URL + "?_=" + Date.now(), { "Cache-Control": "no-cache" });
    if (r.status < 400) data = JSON.parse(r.text);
  } catch (e) { /* 네트워크 오류 */ }
  licChecking = false;
  if (!data) { applyLicense({ state: "neterr" }); return; }
  const allowed = new Set((data.allowed || []).map((x) => String(x).trim()));
  const revoked = new Set((data.revoked || []).map((x) => String(x).trim()));
  const code = String(lic.code || "").trim();
  const ok = data.enabled !== false && allowed.has(code) && !revoked.has(code);
  applyLicense({ state: ok ? "ok" : "blocked", msg: String(data.message || LICENSE_MSG) });
}
function applyLicense(res) {
  const now = Date.now();
  if (res.state === "ok") {
    lic.state = "ok"; lic.okAt = now; licensed = true; licSave();
    hideLock();
    $("startBtn").disabled = !!(S && !S.stopped);
    return;
  }
  if (res.state === "blocked") {
    lic.state = "blocked"; lic.msg = res.msg || LICENSE_MSG; licensed = false; licSave(); licenseBlock(lic.msg);
    return;
  }
  // 인터넷 오류: 캐시된 상태와 유예 기간으로 판단
  if (lic.state === "blocked") { licensed = false; licenseBlock(lic.msg); }
  else if (lic.okAt && now - lic.okAt <= LICENSE_GRACE_DAYS * 86400000) { licensed = true; }
  else { licensed = false; licenseBlock(LICENSE_MSG); }
}
/* 화면 전체를 덮어 아무것도 못 누르게 하는 잠금 화면 */
function showLock(innerHtml) {
  let el = document.getElementById("lockScreen");
  if (!el) {
    el = document.createElement("div");
    el.id = "lockScreen";
    el.style.cssText = "position:fixed;inset:0;z-index:999999;background:#15181c;color:#d7dae0;"
      + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
      + "text-align:center;padding:28px;gap:16px;font-size:16px;line-height:1.6;"
      + "font-family:'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;";
    document.body.appendChild(el);
  }
  el.innerHTML = innerHtml;
  el.style.display = "flex";
}
function hideLock() {
  const el = document.getElementById("lockScreen");
  if (el) el.style.display = "none";
}
function licenseBlock(msg) {
  if (S && !S.stopped) stop();
  $("startBtn").disabled = true;
  if (!lic.okAt) {
    // 아직 승인 안 된 기기 → 전체 화면으로 기기번호 안내
    showLock(
      '<div style="font-size:21px;font-weight:700">사용 승인이 필요합니다</div>'
      + '<div>아래 기기번호를 관리자(멸콩마루)에게 보내<br>사용 승인을 받으세요.</div>'
      + '<div style="font-size:23px;font-weight:700;color:#f2a07b;letter-spacing:1px">' + lic.code + '</div>'
      + '<button id="lockCopy" style="font:inherit;font-size:16px;font-weight:700;color:#fff;'
      + 'background:#e0574f;border:0;border-radius:12px;padding:13px 22px">기기번호 복사</button>'
      + '<div style="font-size:13px;color:#8b929c">승인 후 앱을 다시 켜면 됩니다.</div>');
    const c = document.getElementById("lockCopy");
    if (c) c.onclick = () => copyText(lic.code);
  } else {
    // 이미 쓰던 기기 → 전체 화면으로 메시지만 (일부러 막았다는 티 없이)
    showLock('<div style="font-size:19px;font-weight:600;max-width:320px">' + msg + '</div>');
  }
}
function genDeviceId() {
  if (A && A.deviceId) { const d = A.deviceId(); if (d) return d; }
  // 앱이 아닐 때(브라우저) 대비 임시 번호
  const r = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, "0");
  return `${r()}-${r()}-${r()}-${r()}`;
}
function showDeviceNumber() {
  const did = lic.code;
  write(`⛔ 사용 승인이 필요합니다. 이 기기번호를 관리자(멸콩마루)에게 보내세요: ${did}`, "status");
  ask(`사용하려면 아래 기기번호를 관리자(멸콩마루)에게 보내 승인을 받으세요.\n\n${did}`,
      () => copyText(did), { yes: "복사" });
}
function licenseStartup() {
  if (licenseOff()) { licensed = true; return; }
  licLoad();
  if (!lic.code) { lic.code = genDeviceId(); licSave(); }   // 기기번호 자동 생성
  checkLicense();
}
setInterval(() => {
  if (!licenseOff() && !licChecking && Date.now() - licLastNet >= LICENSE_RECHECK_MS) checkLicense();
}, 30000);

/* 자동 업데이트 알림 (앱이 최신 화면을 받으면 / 큰 변경 APK가 있으면) */
window.__updated = (v) => {
  write(`⬆ 새 버전(v${v}) 화면을 받았습니다. 앱을 다시 켜면 적용됩니다.`, "ok");
  toast("업데이트를 받았습니다. 앱을 다시 켜면 적용됩니다");
};
window.__apkUpdate = (url, note) => {
  const el = document.createElement("span");
  el.textContent = `⬆ 새 버전 설치가 있습니다${note ? " (" + note + ")" : ""} — 눌러서 설치`;
  write(el, "found", () => openStream(url));
  toast("새 버전 설치가 있습니다");
};

loadHistory();
renderHistory();
const loaded = load();
licenseStartup();
loadNotice();  // 공지·제목을 켤 때마다 최신으로 (web 숫자 안 올려도 바뀜)
if (loaded && loaded.auto_start && licensed !== false) setTimeout(start, 600);
