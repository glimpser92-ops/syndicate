/* NEON SYNDICATE — 20인 협력·배신 라운드제 게임 서버 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ---------- 게임 상수 ---------- */
const MAX_PLAYERS = 20;
const MIN_PLAYERS = 4;
const ROUNDS = 7;
const MAX_LINKS = 3;
const START_CREDITS = 100;

const MINE_BASE = 30;
const ALLY_MINE_BONUS = 15;   // 동맹이 함께 채굴할 때, 동맹 1명당
const WALL_BASE = 10;
const COUNTER = 30;           // 방화벽이 해커에게서 뺏는 양
const STEAL = 40;             // 채굴자 해킹 탈취량
const BETRAY_STEAL = 60;      // 동맹 배신 탈취량
const HACK_VS_HACK = 20;      // 해킹 중인 대상 해킹 탈취량
const BOUNTY_BASE = 20;       // 선두 해킹 현상금
const TRAITOR_MULT = 1.5;     // 배신자 낙인 대상 해킹 배율

const PHASE_MS = { event: 6000, signal: 22000, action: 18000, resolve: 12000 };
const DEFAULT_SETTINGS = {
  maxLinks: MAX_LINKS,
  rounds: ROUNDS,
  winnersPercent: 20,
  mineBase: MINE_BASE,
  allyMineBonus: ALLY_MINE_BONUS,
  wallBase: WALL_BASE,
  counter: COUNTER,
  steal: STEAL,
  betraySteal: BETRAY_STEAL,
  hackVsHack: HACK_VS_HACK,
  bountyBase: BOUNTY_BASE,
  signalSeconds: PHASE_MS.signal / 1000,
  actionSeconds: PHASE_MS.action / 1000,
  resolveSeconds: PHASE_MS.resolve / 1000,
};
const SETTING_LIMITS = {
  maxLinks: [1, 5],
  rounds: [3, 12],
  winnersPercent: [10, 50],
  mineBase: [10, 80],
  allyMineBonus: [0, 50],
  wallBase: [0, 60],
  counter: [0, 80],
  steal: [10, 100],
  betraySteal: [20, 140],
  hackVsHack: [0, 80],
  bountyBase: [0, 80],
  signalSeconds: [8, 60],
  actionSeconds: [8, 60],
  resolveSeconds: [5, 45],
};

const EVENTS = [
  { id: 'datarush', name: '데이터 러시', desc: '채굴 수익 2배', mine: 2 },
  { id: 'zeroday',  name: '제로데이',   desc: '해킹 탈취량 2배', hack: 2 },
  { id: 'patch',    name: '보안 패치',  desc: '방화벽 기본 +25 · 반격 2배', wallBase: 25, counter: 2 },
  { id: 'bounty',   name: '현상금 폭등', desc: '선두 해킹 보너스 +60', bountyBonus: 60 },
  { id: 'dividend', name: '동맹 배당',  desc: '유지 중인 동맹 1개당 +20 지급', dividend: 20 },
  { id: 'purge',    name: '대숙청',     desc: '배신 탈취 2배 · 배신자 낙인 없음', betray: 2, noMark: true },
  { id: 'emp',      name: 'EMP 폭풍',   desc: '모든 수익 절반', global: 0.5 },
  { id: 'blackout', name: '블랙아웃',   desc: '방화벽 마비 — 반격 불가 · 수비 수익 0', blackout: true },
  { id: 'jackpot',  name: '잭팟',       desc: '무작위 1명에게 +100C 입금 — 모두가 노린다', jackpot: 100 },
];
const EVENT_STANDARD = { id: 'standard', name: '표준 프로토콜', desc: '기본 규칙으로 진행' };
const EVENT_FINAL = { id: 'final', name: '파이널 퍼지', desc: '마지막 라운드! 해킹 1.5배 · 현상금 2배', hack: 1.5, bountyMul: 2 };

const BOT_NAMES = ['고스트', '넥서스', '바이퍼', '사이퍼', '프록시', '이클립스', '레이븐', '옥타브',
  '징크스', '노이즈', '벡터', '팬텀', '큐비트', '스파이크', '글리치', '오라클', '리퍼', '제로', '카오스', '에코'];

/* ---------- 정적 파일 서버 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

/* ---------- 방 관리 ---------- */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
const uid = () => crypto.randomBytes(6).toString('hex');
const token = () => crypto.randomBytes(12).toString('hex');
const linkKey = (a, b) => [a, b].sort().join('|');
const cleanName = (name) => String(name || '').trim().slice(0, 10) || '익명';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // id -> player
    this.links = new Set();     // "idA|idB"
    this.state = 'lobby';
    this.round = 0;
    this.phase = 'lobby';
    this.event = EVENT_STANDARD;
    this.eventPool = [];
    this.bountyTarget = null;
    this.proposals = new Map(); // "from|to" -> true
    this.timer = null;
    this.host = null;
    this.hostId = null;
    this.phaseEnds = 0;
    this.phaseDuration = 0;
    this.settings = { ...DEFAULT_SETTINGS };
    this.lastWinners = [];
    this.linkAges = new Map();   // linkKey -> 유지된 라운드 수 (신뢰 스택)
    this.bountyPot = 0;          // 누적 현상금 팟
    this.bountyClaimed = false;
    this.jackpotTo = null;
    this.warns = new Map();      // targetId -> 이번 라운드 받은 경고 수
  }

  setHost(name, ws) {
    this.host = {
      id: uid(), token: token(), name: cleanName(name) || '방장',
      ws, connected: true,
    };
    this.hostId = this.host.id;
    return this.host;
  }

  reconnectHost(hostToken, ws) {
    if (!this.host || this.host.token !== hostToken) return null;
    this.host.ws = ws;
    this.host.connected = true;
    return this.host;
  }

  addPlayer(name, ws) {
    const p = {
      id: uid(), token: token(), name: cleanName(name), ws, bot: false,
      credits: START_CREDITS, action: null, target: null,
      traitorUntil: 0, connected: true,
    };
    this.players.set(p.id, p);
    return p;
  }

  reconnectPlayer(msg, ws) {
    const playerToken = String(msg.token || '');
    let p = playerToken ? [...this.players.values()].find(x => !x.bot && x.token === playerToken) : null;
    if (!p && this.state !== 'lobby') {
      const name = cleanName(msg.name);
      p = [...this.players.values()].find(x => !x.bot && !x.connected && x.name === name);
    }
    if (!p) return null;
    p.ws = ws;
    p.connected = true;
    return p;
  }

  addBot() {
    const used = new Set([...this.players.values()].map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || ('봇' + this.players.size);
    const p = {
      id: uid(), name, ws: null, bot: true,
      credits: START_CREDITS, action: null, target: null,
      traitorUntil: 0, connected: true,
      persona: { greed: Math.random(), loyal: Math.random(), caution: Math.random() },
    };
    this.players.set(p.id, p);
    return p;
  }

  linkedIds(id) {
    const out = [];
    for (const k of this.links) {
      const [a, b] = k.split('|');
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }

  snapshot() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, bot: p.bot, connected: p.connected,
      credits: p.credits, traitor: p.traitorUntil >= this.round,
      links: this.linkedIds(p.id),
    }));
  }

  send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
  broadcast(msg) {
    if (this.host) this.send(this.host, msg);
    for (const p of this.players.values()) this.send(p, msg);
  }

  publicSettings() { return { ...this.settings }; }

  phaseMs(phase) {
    if (phase === 'signal') return this.settings.signalSeconds * 1000;
    if (phase === 'action') return this.settings.actionSeconds * 1000;
    if (phase === 'resolve') return this.settings.resolveSeconds * 1000;
    return PHASE_MS[phase] || 1000;
  }

  broadcastRoom() {
    this.broadcast({
      t: 'room', code: this.code, state: this.state, hostId: this.hostId,
      hostName: this.host ? this.host.name : '', hostConnected: !!(this.host && this.host.connected),
      players: this.snapshot(), max: MAX_PLAYERS, min: MIN_PLAYERS,
      settings: this.publicSettings(), winnersN: this.winnersCount(),
    });
  }

  sendState(to) {
    this.send(to, {
      t: 'room', code: this.code, state: this.state, hostId: this.hostId,
      hostName: this.host ? this.host.name : '', hostConnected: !!(this.host && this.host.connected),
      players: this.snapshot(), max: MAX_PLAYERS, min: MIN_PLAYERS,
      settings: this.publicSettings(), winnersN: this.winnersCount(),
    });
    if (this.state === 'playing') {
      this.send(to, {
        t: 'phase', phase: this.phase, round: this.round, rounds: this.settings.rounds,
        event: this.event, ends: this.phaseEnds, duration: this.phaseDuration,
        players: this.snapshot(), bounty: this.bountyTarget,
        winnersN: this.winnersCount(), settings: this.publicSettings(),
        bountyPot: this.bountyPot, jackpotTo: this.jackpotTo, linkAges: Object.fromEntries(this.linkAges),
      });
    }
    if (this.state === 'over') this.send(to, { t: 'over', winners: this.lastWinners, players: this.snapshot() });
  }

  /* ----- 게임 진행 ----- */
  startGame() {
    if (this.state !== 'lobby' || this.players.size < MIN_PLAYERS) return;
    this.state = 'playing';
    this.round = 0;
    this.links.clear();
    this.linkAges.clear();
    this.bountyPot = this.settings.bountyBase;
    this.bountyClaimed = false;
    this.jackpotTo = null;
    this.eventPool = [...EVENTS].sort(() => Math.random() - 0.5);
    for (const p of this.players.values()) {
      p.credits = START_CREDITS; p.action = null; p.target = null; p.traitorUntil = 0;
    }
    this.nextRound();
  }

  nextRound() {
    this.round++;
    if (this.round === 1) this.event = EVENT_STANDARD;
    else if (this.round === this.settings.rounds) this.event = EVENT_FINAL;
    else this.event = this.eventPool[(this.round - 2) % this.eventPool.length];
    // 동맹 신뢰 누적: 한 라운드 버틴 동맹은 신뢰가 쌓인다
    if (this.round > 1) for (const k of this.links) this.linkAges.set(k, (this.linkAges.get(k) || 0) + 1);
    // 현상금 팟: 잡히면 리셋, 선두가 버티면 매 라운드 +10 누적
    if (this.round > 1) {
      if (this.bountyClaimed) this.bountyPot = this.settings.bountyBase;
      else this.bountyPot += 10;
      this.bountyClaimed = false;
    }
    // 잭팟 이벤트: 무작위 1명에게 즉시 입금 (왕관이 옮겨갈 수 있음)
    this.jackpotTo = null;
    if (this.event.jackpot) {
      const ps = [...this.players.values()];
      const lucky = ps[Math.floor(Math.random() * ps.length)];
      lucky.credits += this.event.jackpot;
      this.jackpotTo = lucky.id;
    }
    // 선두 = 현상금 타깃
    let leader = null;
    for (const p of this.players.values()) if (!leader || p.credits > leader.credits) leader = p;
    this.bountyTarget = leader ? leader.id : null;
    this.setPhase('event');
  }

  setPhase(phase) {
    clearTimeout(this.timer);
    this.phase = phase;
    const dur = this.phaseMs(phase);
    this.phaseDuration = dur;
    this.phaseEnds = Date.now() + dur;
    this.proposalsClearedIfNeeded(phase);
    this.broadcast({
      t: 'phase', phase, round: this.round, rounds: this.settings.rounds,
      event: this.event, ends: this.phaseEnds, duration: dur,
      players: this.snapshot(), bounty: this.bountyTarget,
      winnersN: this.winnersCount(), settings: this.publicSettings(),
      bountyPot: this.bountyPot, jackpotTo: this.jackpotTo, linkAges: Object.fromEntries(this.linkAges),
    });
    if (phase === 'signal') { this.warns.clear(); this.botsSignal(); }
    if (phase === 'action') { for (const p of this.players.values()) { p.action = null; p.target = null; } this.botsAct(); }
    this.timer = setTimeout(() => this.advance(), dur);
  }

  proposalsClearedIfNeeded(phase) { if (phase !== 'signal') this.proposals.clear(); }

  advance() {
    if (this.state !== 'playing') return;
    if (this.phase === 'event') this.setPhase('signal');
    else if (this.phase === 'signal') this.setPhase('action');
    else if (this.phase === 'action') this.resolve();
    else if (this.phase === 'resolve') {
      if (this.round >= this.settings.rounds) this.gameOver();
      else this.nextRound();
    }
  }

  winnersCount() {
    return Math.max(1, Math.round(this.players.size * (this.settings.winnersPercent / 100)));
  }

  /* ----- 신호 처리 ----- */
  handleSignal(p, msg) {
    if (this.phase !== 'signal') return;
    const target = msg.target ? this.players.get(msg.target) : null;
    if (msg.kind === 'emoji') {
      const ok = ['🤝', '😈', '🛡️', '💰', '❓', '🔥'];
      if (ok.includes(msg.emoji)) this.broadcast({ t: 'sig', kind: 'emoji', from: p.id, emoji: msg.emoji });
      return;
    }
    if (!target || target.id === p.id) return;
    if (msg.kind === 'propose') {
      const maxLinks = this.settings.maxLinks;
      if (this.links.has(linkKey(p.id, target.id))) return;
      if (this.linkedIds(p.id).length >= maxLinks) { this.send(p, { t: 'toast', msg: `동맹은 최대 ${maxLinks}개까지입니다.` }); return; }
      this.proposals.set(p.id + '|' + target.id, true);
      this.send(target, { t: 'proposal', from: p.id, name: p.name });
      this.send(p, { t: 'toast', msg: target.name + '에게 동맹을 제안했습니다.' });
      if (target.bot) this.botRespond(target, p);
    } else if (msg.kind === 'break') {
      const k = linkKey(p.id, target.id);
      if (this.links.delete(k)) { this.linkAges.delete(k); this.broadcast({ t: 'linkBroken', a: p.id, b: target.id, betrayal: false }); }
    } else if (msg.kind === 'warn') {
      this.warns.set(target.id, (this.warns.get(target.id) || 0) + 1);
      this.broadcast({ t: 'sig', kind: 'warn', from: p.id, to: target.id });
    }
  }

  handleRespond(p, msg) {
    if (this.phase !== 'signal') return;
    const from = this.players.get(msg.from);
    if (!from || !this.proposals.delete(from.id + '|' + p.id)) return;
    if (!msg.accept) { this.send(from, { t: 'toast', msg: p.name + '이(가) 동맹을 거절했습니다.' }); return; }
    const maxLinks = this.settings.maxLinks;
    if (this.linkedIds(p.id).length >= maxLinks || this.linkedIds(from.id).length >= maxLinks) return;
    this.links.add(linkKey(p.id, from.id));
    this.linkAges.set(linkKey(p.id, from.id), 0);
    this.broadcast({ t: 'linkFormed', a: from.id, b: p.id });
  }

  handleAction(p, msg) {
    if (this.phase !== 'action') return;
    if (!['mine', 'hack', 'wall'].includes(msg.act)) return;
    if (msg.act === 'hack') {
      const t = this.players.get(msg.target);
      if (!t || t.id === p.id) return;
      p.target = t.id;
    } else p.target = null;
    p.action = msg.act;
    this.send(p, { t: 'actionOk', act: msg.act, target: p.target });
  }

  /* ----- 라운드 정산 ----- */
  resolve() {
    const ev = this.event;
    const s = this.settings;
    const mul = (x) => Math.round(x * (ev.global || 1));
    const logs = [];
    const players = [...this.players.values()];

    for (const p of players) {
      if (!p.action) { p.action = 'wall'; p.target = null; } // 미입력은 방화벽
    }

    // 1) 해킹 정산
    for (const h of players.filter(x => x.action === 'hack')) {
      const t = this.players.get(h.target);
      if (!t) continue;
      const allied = this.links.has(linkKey(h.id, t.id));
      if (t.action === 'wall' && !ev.blackout) {
        const amt = Math.min(h.credits, mul(s.counter * (ev.counter || 1)));
        h.credits -= amt; t.credits += amt;
        logs.push({ type: 'blocked', from: h.id, to: t.id, amount: amt });
      } else {
        let base = t.action === 'mine' ? s.steal : s.hackVsHack;
        let betrayal = false;
        let trust = 0;
        if (allied) {
          trust = Math.min(this.linkAges.get(linkKey(h.id, t.id)) || 0, 4);
          base = (s.betraySteal + trust * 10) * (ev.betray || 1); // 오래된 동맹일수록 배신 수익↑
          betrayal = true;
        }
        base *= (ev.hack || 1);
        if (t.traitorUntil >= this.round) base *= TRAITOR_MULT;
        let amt = Math.min(t.credits, mul(Math.round(base)));
        t.credits -= amt; h.credits += amt;
        let bounty = 0;
        if (t.id === this.bountyTarget) {
          const pot = this.bountyClaimed ? s.bountyBase : this.bountyPot;
          bounty = mul((pot + (ev.bountyBonus || 0)) * (ev.bountyMul || 1));
          h.credits += bounty;
          this.bountyClaimed = true;
        }
        if (betrayal) {
          const bk = linkKey(h.id, t.id);
          this.links.delete(bk);
          this.linkAges.delete(bk);
          if (!ev.noMark) h.traitorUntil = this.round + 1;
          this.broadcast({ t: 'linkBroken', a: h.id, b: t.id, betrayal: true });
        }
        logs.push({ type: 'hack', from: h.id, to: t.id, amount: amt, bounty, betrayal, trust });
      }
    }

    // 2) 채굴 정산 (동맹 합동 보너스 — 오래 유지한 동맹일수록 +5/라운드, 최대 +20)
    for (const p of players.filter(x => x.action === 'mine')) {
      let bonus = 0, allies = 0;
      for (const id of this.linkedIds(p.id)) {
        const a = this.players.get(id);
        if (a && a.action === 'mine') {
          allies++;
          bonus += s.allyMineBonus + Math.min((this.linkAges.get(linkKey(p.id, id)) || 0) * 5, 20);
        }
      }
      const amt = mul(Math.round((s.mineBase + bonus) * (ev.mine || 1)));
      p.credits += amt;
      logs.push({ type: 'mine', from: p.id, amount: amt, allies });
    }

    // 3) 방화벽 기본 수익 (블랙아웃이면 0)
    for (const p of players.filter(x => x.action === 'wall')) {
      const amt = ev.blackout ? 0 : mul(s.wallBase + (ev.wallBase || 0));
      p.credits += amt;
      logs.push({ type: 'wall', from: p.id, amount: amt });
    }

    // 4) 동맹 배당 이벤트
    if (ev.dividend) {
      for (const p of players) {
        const n = this.linkedIds(p.id).length;
        if (n > 0) { const amt = mul(n * ev.dividend); p.credits += amt; logs.push({ type: 'dividend', from: p.id, amount: amt }); }
      }
    }

    for (const p of players) p.credits = Math.max(0, p.credits);

    this.phase = 'resolve';
    const dur = this.phaseMs('resolve');
    this.phaseDuration = dur;
    this.phaseEnds = Date.now() + dur;
    this.broadcast({
      t: 'resolve', logs, players: this.snapshot(), round: this.round, rounds: this.settings.rounds,
      ends: this.phaseEnds, duration: dur, bounty: this.bountyTarget,
      winnersN: this.winnersCount(), settings: this.publicSettings(),
      bountyPot: this.bountyPot, linkAges: Object.fromEntries(this.linkAges),
    });
    this.timer = setTimeout(() => this.advance(), dur);
  }

  gameOver() {
    this.state = 'over';
    this.phase = 'over';
    const ranked = [...this.players.values()].sort((a, b) => b.credits - a.credits);
    const winners = ranked.slice(0, this.winnersCount()).map(p => p.id);
    this.lastWinners = winners;
    this.broadcast({ t: 'over', winners, players: this.snapshot() });
    // 로비로 복귀 준비
    setTimeout(() => { if (this.state === 'over') { this.state = 'lobby'; this.broadcastRoom(); } }, 12000);
  }

  /* ----- 봇 AI ----- */
  botsSignal() {
    const bots = [...this.players.values()].filter(p => p.bot);
    for (const b of bots) {
      setTimeout(() => {
        if (this.phase !== 'signal' || this.state !== 'playing') return;
        const maxLinks = this.settings.maxLinks;
        const myLinks = this.linkedIds(b.id);
        if (myLinks.length < maxLinks && Math.random() < 0.6 + b.persona.loyal * 0.3) {
          const ranked = [...this.players.values()].sort((x, y) => y.credits - x.credits);
          const candidates = ranked.filter(p => p.id !== b.id && !myLinks.includes(p.id)
            && p.traitorUntil < this.round && this.linkedIds(p.id).length < maxLinks);
          // 중위권 선호
          const pick = candidates[Math.min(candidates.length - 1, Math.floor(Math.random() * Math.max(1, candidates.length * 0.7)) + Math.floor(candidates.length * 0.15))];
          if (pick) {
            this.proposals.set(b.id + '|' + pick.id, true);
            if (pick.bot) this.botRespond(pick, b);
            else this.send(pick, { t: 'proposal', from: b.id, name: b.name });
          }
        }
        if (Math.random() < 0.25) {
          const ok = ['🤝', '😈', '🛡️', '💰', '❓', '🔥'];
          this.broadcast({ t: 'sig', kind: 'emoji', from: b.id, emoji: ok[Math.floor(Math.random() * ok.length)] });
        }
        // 경고 신호: 현상금 타깃·배신자·상위권을 공개 지목해 판을 흔든다
        if (Math.random() < 0.18) {
          const ranked2 = [...this.players.values()].sort((x, y) => y.credits - x.credits);
          let wt = null;
          if (this.bountyTarget && this.bountyTarget !== b.id && Math.random() < 0.6) wt = this.players.get(this.bountyTarget);
          else wt = ranked2.find(p => p.id !== b.id && p.traitorUntil >= this.round)
            || ranked2[Math.floor(Math.random() * Math.max(1, Math.ceil(ranked2.length / 2)))];
          if (wt && wt.id !== b.id) {
            this.warns.set(wt.id, (this.warns.get(wt.id) || 0) + 1);
            this.broadcast({ t: 'sig', kind: 'warn', from: b.id, to: wt.id });
          }
        }
      }, 1200 + Math.random() * Math.max(2000, this.phaseMs('signal') - 5000));
    }
  }

  botRespond(bot, from) {
    setTimeout(() => {
      if (this.phase !== 'signal' || !this.proposals.delete(from.id + '|' + bot.id)) return;
      const accept = Math.random() < 0.45 + bot.persona.loyal * 0.4 - (from.traitorUntil >= this.round ? 0.5 : 0);
      const maxLinks = this.settings.maxLinks;
      if (accept && this.linkedIds(bot.id).length < maxLinks && this.linkedIds(from.id).length < maxLinks) {
        this.links.add(linkKey(bot.id, from.id));
        this.broadcast({ t: 'linkFormed', a: from.id, b: bot.id });
      } else if (!from.bot) {
        this.send(from, { t: 'toast', msg: bot.name + '이(가) 동맹을 거절했습니다.' });
      }
    }, 1000 + Math.random() * 6000);
  }

  botsAct() {
    const bots = [...this.players.values()].filter(p => p.bot);
    const ranked = [...this.players.values()].sort((a, b) => b.credits - a.credits);
    const cutoff = this.winnersCount();
    for (const b of bots) {
      setTimeout(() => {
        if (this.phase !== 'action' || this.state !== 'playing') return;
        const ev = this.event;
        const myRank = ranked.findIndex(p => p.id === b.id);
        const lastRounds = this.round >= this.settings.rounds - 1;
        let wMine = 0.55, wHack = 0.25, wWall = 0.20;
        if (ev.mine) wMine += 0.25;
        if (ev.hack || ev.betray) wHack += 0.25;
        if (ev.counter || ev.wallBase) wWall += 0.2;
        if (ev.blackout) { wWall = Math.max(0.05, wWall - 0.15); wHack += 0.2; } // 방화벽 마비 → 공세
        wHack += b.persona.greed * 0.2;
        wWall += b.persona.caution * 0.15;
        wWall += (this.warns.get(b.id) || 0) * 0.25; // 경고를 받으면 움츠린다
        if (this.linkedIds(b.id).length > 0) wMine += 0.15;
        // 막판: 커트라인 바로 아래면 공격적으로
        let forcedTarget = null;
        if (lastRounds && myRank >= cutoff && myRank < cutoff + 4) {
          wHack += 0.5;
          forcedTarget = ranked[cutoff - 1] && ranked[cutoff - 1].id !== b.id ? ranked[cutoff - 1] : null;
        }
        const total = wMine + wHack + wWall;
        const r = Math.random() * total;
        if (r < wHack) {
          let target = forcedTarget;
          if (!target) {
            const traitors = ranked.filter(p => p.id !== b.id && p.traitorUntil >= this.round);
            if (this.jackpotTo && this.jackpotTo !== b.id && Math.random() < 0.45) target = this.players.get(this.jackpotTo);
            else if (this.bountyTarget && this.bountyTarget !== b.id && Math.random() < 0.5) target = this.players.get(this.bountyTarget);
            else if (traitors.length && Math.random() < 0.5) target = traitors[0];
            else {
              const rich = ranked.slice(0, Math.ceil(ranked.length / 2)).filter(p => p.id !== b.id);
              target = rich[Math.floor(Math.random() * rich.length)];
            }
          }
          // 배신 판단: 충성도 낮고 막판·대숙청·신뢰가 무르익은 동맹이면 턴다
          const allies = this.linkedIds(b.id);
          const ripe = allies.some(id => (this.linkAges.get(linkKey(b.id, id)) || 0) >= 3);
          if (allies.length && (lastRounds || ev.betray || ripe) && b.persona.loyal < 0.35 && Math.random() < 0.5) {
            const allyTargets = allies.map(id => this.players.get(id)).filter(Boolean)
              .sort((x, y) => (y.credits + (this.linkAges.get(linkKey(b.id, y.id)) || 0) * 30)
                            - (x.credits + (this.linkAges.get(linkKey(b.id, x.id)) || 0) * 30));
            if (allyTargets[0] && allyTargets[0].credits > b.credits * 0.6) target = allyTargets[0];
          }
          if (target && target.id !== b.id) { b.action = 'hack'; b.target = target.id; return; }
        }
        if (r < wHack + wWall) { b.action = 'wall'; b.target = null; }
        else { b.action = 'mine'; b.target = null; }
      }, 800 + Math.random() * Math.max(2000, this.phaseMs('action') - 4000));
    }
  }

  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(SETTING_LIMITS, key)) continue;
      const [min, max] = SETTING_LIMITS[key];
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      next[key] = Math.round(clamp(value, min, max));
    }
    if (!Object.keys(next).length) return;
    Object.assign(this.settings, next);
    if (this.state === 'playing' && this.settings.rounds < this.round) this.settings.rounds = this.round;
    this.broadcast({
      t: 'settings', settings: this.publicSettings(), players: this.snapshot(),
      winnersN: this.winnersCount(), round: this.round, rounds: this.settings.rounds,
    });
    this.broadcastRoom();
  }

  removeHost() {
    if (!this.host) return;
    this.host.connected = false;
    this.host.ws = null;
    this.broadcastRoom();
    if (this.players.size === 0) rooms.delete(this.code);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.state === 'lobby') {
      this.players.delete(id);
      for (const k of [...this.links]) if (k.includes(id)) { this.links.delete(k); this.linkAges.delete(k); }
      this.broadcastRoom();
      if (this.players.size === 0 && (!this.host || !this.host.connected)) rooms.delete(this.code);
    } else {
      p.connected = false; p.ws = null; // 게임 중엔 자리 유지 (미입력 = 방화벽, 재접속 가능)
      this.broadcastRoom();
      // 방장이 살아 있으면 방 유지 — 학생 전원이 잠깐 끊겨도(새로고침 등) 게임은 계속된다
      if ([...this.players.values()].every(x => x.bot || !x.connected) && (!this.host || !this.host.connected)) {
        clearTimeout(this.timer);
        rooms.delete(this.code);
      }
    }
  }
}

/* ---------- WebSocket ---------- */
wss.on('connection', (ws) => {
  let room = null, me = null, role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'create') {
      const code = makeCode();
      room = new Room(code);
      rooms.set(code, room);
      me = room.setHost(msg.name, ws);
      role = 'host';
      ws.send(JSON.stringify({ t: 'joined', code, you: me.id, role, hostToken: me.token }));
      room.broadcastRoom();
      return;
    }
    if (msg.t === 'rejoinHost') {
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) { ws.send(JSON.stringify({ t: 'error', msg: '존재하지 않는 방 코드입니다.' })); return; }
      const host = r.reconnectHost(String(msg.hostToken || ''), ws);
      if (!host) { ws.send(JSON.stringify({ t: 'error', msg: '방장 세션을 찾을 수 없습니다.' })); return; }
      room = r;
      me = host;
      role = 'host';
      ws.send(JSON.stringify({ t: 'joined', code: room.code, you: me.id, role, hostToken: me.token, rejoined: true }));
      room.sendState(me);
      room.broadcastRoom();
      return;
    }
    if (msg.t === 'join') {
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) { ws.send(JSON.stringify({ t: 'error', msg: '존재하지 않는 방 코드입니다.' })); return; }
      room = r;
      role = 'player';
      me = room.reconnectPlayer(msg, ws);
      if (me) {
        ws.send(JSON.stringify({ t: 'joined', code: room.code, you: me.id, role, token: me.token, rejoined: true }));
        room.sendState(me);
        room.broadcastRoom();
        return;
      }
      if (r.state !== 'lobby') {
        ws.send(JSON.stringify({ t: 'error', msg: '게임 중에는 새 참가자가 들어올 수 없습니다. 기존 참가자는 같은 이름/기기로 다시 접속하세요.' }));
        return;
      }
      if (r.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'error', msg: '방이 가득 찼습니다 (학생 최대 20명).' })); return; }
      me = room.addPlayer(msg.name, ws);
      ws.send(JSON.stringify({ t: 'joined', code: room.code, you: me.id, role, token: me.token }));
      room.broadcastRoom();
      return;
    }
    if (!room || !me) return;

    switch (msg.t) {
      case 'addBot':
        if (role === 'host' && room.state === 'lobby' && room.players.size < MAX_PLAYERS) { room.addBot(); room.broadcastRoom(); }
        break;
      case 'removeBot':
        if (role === 'host' && room.state === 'lobby') {
          const bot = [...room.players.values()].reverse().find(p => p.bot);
          if (bot) { room.players.delete(bot.id); room.broadcastRoom(); }
        }
        break;
      case 'start':
        if (role === 'host') room.startGame();
        break;
      case 'settings':
        if (role === 'host') room.updateSettings(msg.patch);
        break;
      case 'signal': if (role === 'player') room.handleSignal(me, msg); break;
      case 'respond': if (role === 'player') room.handleRespond(me, msg); break;
      case 'action': if (role === 'player') room.handleAction(me, msg); break;
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    if (role === 'host') room.removeHost();
    else room.removePlayer(me.id);
  });
});

server.listen(PORT, () => {
  console.log('NEON SYNDICATE 서버 가동 → http://localhost:' + PORT);
});
