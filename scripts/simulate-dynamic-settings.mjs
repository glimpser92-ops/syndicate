import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_OUT_DIR = '.omo/ulw-loop/dynamic-settings-simulation-20260616/evidence';

const START_CREDITS = 100;
const PLAYER_COUNT = 20;
const ROUNDS = 7;
const WINNERS_PERCENT = 20;
const TRUST_MINE_CAP = 32;
const TRUST_BETRAY_CAP = 60;
const TRAITOR_MULT = 1.8;
const WALL_BASE = 10;
const BREACH_STEAL = 25;
const HACK_VS_HACK = 20;
const BOUNTY_BASE = 20;

const DEFAULT_SETTINGS = {
  maxLinks: 3,
  mineBase: 30,
  allyMineBonus: 20,
  trustMineBonus: 8,
  steal: 40,
  counter: 45,
  betraySteal: 75,
  trustBetrayBonus: 15,
};

const LIMITS = {
  maxLinks: [1, 5],
  mineBase: [10, 80],
  allyMineBonus: [0, 50],
  trustMineBonus: [0, 30],
  steal: [10, 100],
  counter: [0, 80],
  betraySteal: [20, 140],
  trustBetrayBonus: [0, 40],
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const SETTING_STEPS = {
  maxLinks: 1,
  mineBase: 5,
  allyMineBonus: 5,
  trustMineBonus: 1,
  steal: 5,
  counter: 5,
  betraySteal: 5,
  trustBetrayBonus: 1,
};
const TUNED_BASELINE = {
  maxLinks: 3,
  mineBase: 30,
  allyMineBonus: 20,
  trustMineBonus: 9,
  steal: 35,
  counter: 45,
  betraySteal: 70,
  trustBetrayBonus: 11,
};

const EVENTS = [
  { id: 'datarush', name: '데이터 러시', mine: 2 },
  { id: 'zeroday', name: '제로데이', hack: 2 },
  { id: 'patch', name: '보안 패치', wallBase: 25, counter: 2 },
  { id: 'bounty', name: '현상금 폭등', bountyBonus: 60 },
  { id: 'dividend', name: '동맹 배당', dividend: 20 },
  { id: 'purge', name: '대숙청', betray: 2, noMark: true },
  { id: 'emp', name: 'EMP 폭풍', global: 0.5 },
  { id: 'blackout', name: '블랙아웃', blackout: true },
  { id: 'jackpot', name: '잭팟', jackpot: 100 },
];
const EVENT_STANDARD = { id: 'standard', name: '표준 프로토콜' };
const EVENT_FINAL = { id: 'final', name: '파이널 퍼지', hack: 1.5, bountyMul: 2 };

const ARCHETYPES = [
  { id: 'cooperator', label: '협력가', greed: 0.25, loyal: 0.9, caution: 0.45 },
  { id: 'miner', label: '채굴가', greed: 0.2, loyal: 0.62, caution: 0.38 },
  { id: 'aggressor', label: '공격가', greed: 0.88, loyal: 0.2, caution: 0.16 },
  { id: 'defender', label: '수비가', greed: 0.28, loyal: 0.48, caution: 0.9 },
  { id: 'opportunist', label: '기회주의자', greed: 0.68, loyal: 0.38, caution: 0.48 },
  { id: 'trickster', label: '배신가', greed: 0.82, loyal: 0.08, caution: 0.3 },
];

const ACTIONS = ['mine', 'wall', 'hack', 'breach', 'betray'];
const KOREAN_KEYS = {
  maxLinks: '동맹 한도',
  mineBase: '채굴',
  allyMineBonus: '동맹+',
  trustMineBonus: '신뢰+',
  steal: '해킹',
  counter: '반격',
  betraySteal: '배신',
  trustBetrayBonus: '배신신뢰+',
};

function parseArgs(argv) {
  const args = {
    seed: 20260616,
    games: 160,
    candidates: 180,
    outDir: DEFAULT_OUT_DIR,
    top: 12,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (['seed', 'games', 'candidates', 'top'].includes(key)) {
      args[key] = Number(next);
      i++;
    } else if (key === 'out-dir') {
      args.outDir = next;
      i++;
    } else if (key === 'help') {
      args.help = true;
    } else {
      throw new Error(`unknown argument --${key}`);
    }
  }
  for (const key of ['seed', 'games', 'candidates', 'top']) {
    if (!Number.isInteger(args[key]) || args[key] <= 0) throw new Error(`--${key} must be a positive integer`);
  }
  return args;
}

function showHelp() {
  console.log(`Usage: npm run simulate:dynamic -- --seed 20260616 --games 160 --candidates 180

Options:
  --seed <n>        deterministic seed
  --games <n>       games per candidate
  --candidates <n>  number of setting bundles to score
  --out-dir <path>  output evidence directory
  --top <n>         top rows to include in markdown`);
}

function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x += 0x6D2B79F5;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts) {
  let h = 2166136261;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rounded(value, step = 5) {
  return Math.round(value / step) * step;
}

function choose(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function stepSample(rng, key) {
  const [min, max] = LIMITS[key];
  const step = SETTING_STEPS[key];
  const slots = Math.floor((max - min) / step);
  return min + Math.floor(rng() * (slots + 1)) * step;
}

function sampleFullRange(rng) {
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, stepSample(rng, key)]));
}

function sampleFocusedRange(rng) {
  return {
    maxLinks: choose(rng, [2, 2, 3, 3, 3, 4]),
    mineBase: clamp(rounded(22 + rng() * 24), LIMITS.mineBase[0], LIMITS.mineBase[1]),
    allyMineBonus: clamp(rounded(12 + rng() * 22), LIMITS.allyMineBonus[0], LIMITS.allyMineBonus[1]),
    trustMineBonus: clamp(Math.round(4 + rng() * 10), LIMITS.trustMineBonus[0], LIMITS.trustMineBonus[1]),
    steal: clamp(rounded(35 + rng() * 28), LIMITS.steal[0], LIMITS.steal[1]),
    counter: clamp(rounded(30 + rng() * 30), LIMITS.counter[0], LIMITS.counter[1]),
    betraySteal: clamp(rounded(65 + rng() * 40), LIMITS.betraySteal[0], LIMITS.betraySteal[1]),
    trustBetrayBonus: clamp(Math.round(8 + rng() * 16), LIMITS.trustBetrayBonus[0], LIMITS.trustBetrayBonus[1]),
  };
}

function coverageAnchors() {
  const anchors = [];
  for (const key of SETTING_KEYS) {
    for (const edge of LIMITS[key]) anchors.push({ ...TUNED_BASELINE, [key]: edge });
  }
  return anchors;
}

function shuffled(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sampleCandidate(rng, index) {
  const curated = [
    TUNED_BASELINE,
    DEFAULT_SETTINGS,
    { maxLinks: 3, mineBase: 25, allyMineBonus: 15, trustMineBonus: 8, steal: 35, counter: 50, betraySteal: 75, trustBetrayBonus: 10 },
    { maxLinks: 2, mineBase: 30, allyMineBonus: 20, trustMineBonus: 8, steal: 45, counter: 40, betraySteal: 80, trustBetrayBonus: 14 },
    { maxLinks: 3, mineBase: 28, allyMineBonus: 18, trustMineBonus: 7, steal: 48, counter: 42, betraySteal: 82, trustBetrayBonus: 16 },
    { maxLinks: 2, mineBase: 32, allyMineBonus: 22, trustMineBonus: 6, steal: 42, counter: 48, betraySteal: 78, trustBetrayBonus: 13 },
    { maxLinks: 3, mineBase: 26, allyMineBonus: 24, trustMineBonus: 9, steal: 46, counter: 44, betraySteal: 85, trustBetrayBonus: 12 },
    { maxLinks: 2, mineBase: 34, allyMineBonus: 16, trustMineBonus: 8, steal: 50, counter: 45, betraySteal: 75, trustBetrayBonus: 18 },
    { maxLinks: 4, mineBase: 24, allyMineBonus: 16, trustMineBonus: 5, steal: 52, counter: 38, betraySteal: 88, trustBetrayBonus: 11 },
    ...coverageAnchors(),
  ];
  if (index < curated.length) return { ...curated[index] };

  if (index % 3 === 0) return sampleFullRange(rng);
  if (index % 3 === 1) return { ...sampleFocusedRange(rng), maxLinks: stepSample(rng, 'maxLinks') };
  return sampleFocusedRange(rng);
}

function settingKey(settings) {
  return Object.keys(DEFAULT_SETTINGS).map((key) => `${key}:${settings[key]}`).join(',');
}

function linkKey(a, b) {
  return [a, b].sort((x, y) => x - y).join('|');
}

function rankPlayers(players) {
  return [...players].sort((a, b) => b.credits - a.credits || a.id - b.id);
}

function rankOf(players, id) {
  return rankPlayers(players).findIndex((p) => p.id === id) + 1;
}

function linkedIds(links, id) {
  const out = [];
  for (const key of links) {
    const [a, b] = key.split('|').map(Number);
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

function initPlayers(rng) {
  return Array.from({ length: PLAYER_COUNT }, (_, id) => {
    const base = ARCHETYPES[id % ARCHETYPES.length];
    return {
      id,
      name: `P${id + 1}`,
      archetype: base.id,
      label: base.label,
      greed: clamp(base.greed + (rng() - 0.5) * 0.18, 0, 1),
      loyal: clamp(base.loyal + (rng() - 0.5) * 0.18, 0, 1),
      caution: clamp(base.caution + (rng() - 0.5) * 0.18, 0, 1),
      credits: START_CREDITS,
      traitorUntil: 0,
      action: null,
      target: null,
      likelyWall: 0.18,
    };
  });
}

function eventForRound(rng, round, rounds, eventPool) {
  if (round === 1) return EVENT_STANDARD;
  if (round === rounds) return EVENT_FINAL;
  return eventPool[(round - 2) % eventPool.length];
}

function applySignals(rng, players, links, linkAges, settings, round, stats) {
  const ranked = rankPlayers(players);
  for (const p of players) {
    const myLinks = linkedIds(links, p.id);
    const room = settings.maxLinks - myLinks.length;
    if (room <= 0) continue;
    const proposeChance = 0.35 + p.loyal * 0.36 - p.greed * 0.08 + (round <= 3 ? 0.1 : 0);
    if (rng() > proposeChance) continue;
    const candidates = ranked.filter((target) => {
      if (target.id === p.id) return false;
      if (target.traitorUntil >= round) return false;
      if (myLinks.includes(target.id)) return false;
      return linkedIds(links, target.id).length < settings.maxLinks;
    });
    if (!candidates.length) continue;
    const start = Math.floor(candidates.length * 0.12);
    const end = Math.max(start + 1, Math.ceil(candidates.length * 0.78));
    const target = candidates[start + Math.floor(rng() * (end - start))];
    const acceptChance = 0.35 + target.loyal * 0.42 - (p.traitorUntil >= round ? 0.5 : 0) + (target.credits < p.credits ? 0.05 : 0);
    if (rng() < acceptChance) {
      const key = linkKey(p.id, target.id);
      if (!links.has(key)) {
        links.add(key);
        linkAges.set(key, 0);
        stats.linksFormed++;
      }
    }
  }
}

function chooseTarget(rng, player, players, links, mode, context) {
  const ranked = rankPlayers(players).filter((target) => target.id !== player.id);
  const allies = linkedIds(links, player.id);
  if (mode === 'betray') {
    const allyTargets = allies.map((id) => players[id]).filter(Boolean);
    if (!allyTargets.length) return null;
    return allyTargets.sort((a, b) => b.credits - a.credits)[0];
  }
  if (mode === 'breach') {
    const warned = ranked.filter((target) => context.warned.has(target.id));
    const cautious = ranked.filter((target) => target.caution > 0.58 || target.id === context.bountyTarget);
    const pool = warned.length ? warned : cautious.length ? cautious : ranked.slice(0, Math.ceil(ranked.length / 2));
    return choose(rng, pool);
  }
  const traitors = ranked.filter((target) => target.traitorUntil >= context.round);
  if (traitors.length && rng() < 0.45) return traitors[0];
  if (context.jackpotTo != null && context.jackpotTo !== player.id && rng() < 0.35) return players[context.jackpotTo];
  if (context.bountyTarget != null && context.bountyTarget !== player.id && rng() < 0.45) return players[context.bountyTarget];
  const rich = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  return choose(rng, rich);
}

function softmaxPick(rng, weights) {
  const max = Math.max(...weights.map((w) => w.score));
  const scaled = weights.map((w) => ({ ...w, weight: Math.exp((w.score - max) / 23) }));
  const total = scaled.reduce((sum, w) => sum + w.weight, 0);
  let cursor = rng() * total;
  for (const item of scaled) {
    cursor -= item.weight;
    if (cursor <= 0) return item;
  }
  return scaled[scaled.length - 1];
}

function selectActions(rng, players, links, linkAges, settings, event, round, context, stats) {
  const ranked = rankPlayers(players);
  const cutoff = Math.max(1, Math.round(players.length * (WINNERS_PERCENT / 100)));
  const lastRounds = round >= ROUNDS - 1;
  const warned = context.warned;

  for (const p of players) {
    const allies = linkedIds(links, p.id);
    const miningAllies = allies.length * (0.45 + p.loyal * 0.28);
    const avgTrust = allies.length
      ? allies.reduce((sum, id) => sum + (linkAges.get(linkKey(p.id, id)) || 0), 0) / allies.length
      : 0;
    const coopBonus = miningAllies * (settings.allyMineBonus + Math.min(avgTrust * settings.trustMineBonus, TRUST_MINE_CAP));
    const mineValue = (settings.mineBase + coopBonus) * (event.mine || 1) * (event.global || 1);

    const rank = ranked.findIndex((x) => x.id === p.id);
    const behindPressure = rank >= cutoff && lastRounds ? 18 : rank >= cutoff ? 7 : 0;
    const leaderPressure = rank < cutoff ? 4 : 0;
    const expectedCounterRisk = settings.counter * (0.18 + p.caution * 0.04) * (event.counter || 1);
    const hackValue = settings.steal * (event.hack || 1) * (event.global || 1) + behindPressure - expectedCounterRisk * 0.42;

    const wallThreat = (warned.get(p.id) || 0) * 14 + leaderPressure + p.caution * 18;
    const wallValue = (event.blackout ? 0 : WALL_BASE + (event.wallBase || 0)) + wallThreat + settings.counter * (0.18 + p.caution * 0.1);

    const breachValue = BREACH_STEAL * (0.28 + p.greed * 0.18 + (event.counter || event.wallBase ? 0.22 : 0)) + (warned.size ? 5 : 0);

    const ripeAllies = allies
      .map((id) => ({ id, trust: linkAges.get(linkKey(p.id, id)) || 0, credits: players[id].credits }))
      .sort((a, b) => (b.trust * 20 + b.credits) - (a.trust * 20 + a.credits));
    const bestAlly = ripeAllies[0];
    const trustBonus = bestAlly ? Math.min(bestAlly.trust * settings.trustBetrayBonus, TRUST_BETRAY_CAP) : 0;
    const betrayValue = bestAlly
      ? (settings.betraySteal + trustBonus) * (event.betray || 1) * (event.hack || 1) * (event.global || 1)
        - 42 - p.loyal * 58 + p.greed * 12 + (lastRounds ? 20 : 0) + (bestAlly.trust >= 3 ? 16 : 0)
      : -100;

    const weights = [
      { action: 'mine', score: mineValue + p.loyal * 10 - p.greed * 3 },
      { action: 'wall', score: wallValue + p.caution * 12 - p.greed * 4 },
      { action: 'hack', score: hackValue + p.greed * 14 - p.loyal * 2 - 4 },
      { action: 'breach', score: breachValue + p.greed * 8 - p.loyal * 2 },
      { action: 'betray', score: betrayValue },
    ];
    const selected = softmaxPick(rng, weights);
    p.action = selected.action;
    p.target = null;
    if (selected.action === 'hack') {
      const target = chooseTarget(rng, p, players, links, 'hack', { ...context, round });
      if (!target) p.action = 'mine';
      else {
        p.target = target.id;
        if (links.has(linkKey(p.id, target.id))) p.action = 'betray';
      }
    } else if (selected.action === 'betray') {
      const target = chooseTarget(rng, p, players, links, 'betray', { ...context, round });
      if (!target) p.action = rng() < 0.5 ? 'mine' : 'hack';
      if (target) p.target = target.id;
    } else if (selected.action === 'breach') {
      const target = chooseTarget(rng, p, players, links, 'breach', { ...context, round });
      if (!target) p.action = 'mine';
      else p.target = target.id;
    }
    stats.actions[p.action]++;
  }
}

function resolveRound(players, links, linkAges, settings, event, round, context, stats) {
  const mul = (x) => Math.round(x * (event.global || 1));
  const logs = [];
  const breachedWalls = new Set();

  for (const b of players.filter((p) => p.action === 'breach')) {
    const target = players[b.target];
    if (!target) continue;
    if (target.action === 'wall') {
      const amount = Math.min(target.credits, mul(BREACH_STEAL));
      target.credits -= amount;
      b.credits += amount;
      breachedWalls.add(target.id);
      logs.push({ type: 'breach', from: b.id, to: target.id, amount, success: true });
      stats.breachSuccess++;
    } else {
      logs.push({ type: 'breach', from: b.id, to: target.id, amount: 0, success: false, miss: true });
    }
  }

  for (const h of players.filter((p) => p.action === 'hack' || p.action === 'betray')) {
    const target = players[h.target];
    if (!target) continue;
    const betrayal = h.action === 'betray' || links.has(linkKey(h.id, target.id));
    const beforeRank = rankOf(players, h.id);
    if (target.action === 'wall' && !event.blackout && !breachedWalls.has(target.id)) {
      const amount = Math.min(h.credits, mul(settings.counter * (event.counter || 1)));
      h.credits -= amount;
      target.credits += amount;
      logs.push({ type: 'blocked', action: betrayal ? 'betray' : 'hack', from: h.id, to: target.id, amount });
      stats.blockedAttacks++;
    } else {
      let base = target.action === 'mine' ? settings.steal : HACK_VS_HACK;
      let trust = 0;
      if (betrayal) {
        trust = linkAges.get(linkKey(h.id, target.id)) || 0;
        const trustBonus = Math.min(trust * settings.trustBetrayBonus, TRUST_BETRAY_CAP);
        base = (settings.betraySteal + trustBonus) * (event.betray || 1);
      }
      base *= event.hack || 1;
      if (target.traitorUntil >= round) base *= TRAITOR_MULT;
      const amount = Math.min(target.credits, mul(Math.round(base)));
      target.credits -= amount;
      h.credits += amount;
      let bounty = 0;
      if (target.id === context.bountyTarget) {
        const pot = context.bountyClaimed ? BOUNTY_BASE : context.bountyPot;
        bounty = mul((pot + (event.bountyBonus || 0)) * (event.bountyMul || 1));
        h.credits += bounty;
        context.bountyClaimed = true;
      }
      if (betrayal) {
        const key = linkKey(h.id, target.id);
        if (links.delete(key)) {
          linkAges.delete(key);
          stats.linksBroken++;
        }
        if (!event.noMark) h.traitorUntil = round + 1;
      }
      logs.push({ type: betrayal ? 'betray' : 'hack', from: h.id, to: target.id, amount, bounty, betrayal, trust });
      if (betrayal) {
        const afterRank = rankOf(players, h.id);
        if (beforeRank - afterRank >= 2 || (beforeRank > 4 && afterRank <= 4)) stats.consequentialBetrays++;
      }
    }
  }

  for (const p of players.filter((x) => x.action === 'mine')) {
    let bonus = 0;
    let allies = 0;
    for (const id of linkedIds(links, p.id)) {
      const ally = players[id];
      if (ally && ally.action === 'mine') {
        allies++;
        const trust = linkAges.get(linkKey(p.id, id)) || 0;
        bonus += settings.allyMineBonus + Math.min(trust * settings.trustMineBonus, TRUST_MINE_CAP);
      }
    }
    const amount = mul(Math.round((settings.mineBase + bonus) * (event.mine || 1)));
    p.credits += amount;
    logs.push({ type: 'mine', from: p.id, amount, allies });
    if (allies > 0) stats.cooperativeMineActions++;
  }

  for (const p of players.filter((x) => x.action === 'wall')) {
    const breached = breachedWalls.has(p.id);
    const amount = event.blackout || breached ? 0 : mul(WALL_BASE + (event.wallBase || 0));
    p.credits += amount;
    logs.push({ type: 'wall', from: p.id, amount, breached });
  }

  if (event.dividend) {
    for (const p of players) {
      const count = linkedIds(links, p.id).length;
      if (count > 0) p.credits += mul(count * event.dividend);
    }
  }

  for (const p of players) {
    p.credits = Math.max(0, p.credits);
    p.likelyWall = p.action === 'wall' ? 0.55 : 0.12 + p.caution * 0.22;
  }
  return logs;
}

function simulateGame(settings, seed, gameIndex) {
  const rng = makeRng(hashSeed(seed, gameIndex, settingKey(settings)));
  const players = initPlayers(rng);
  const links = new Set();
  const linkAges = new Map();
  const eventPool = shuffled(rng, EVENTS);
  const stats = {
    actions: Object.fromEntries(ACTIONS.map((action) => [action, 0])),
    cooperativeMineActions: 0,
    linksFormed: 0,
    linksBroken: 0,
    consequentialBetrays: 0,
    breachSuccess: 0,
    blockedAttacks: 0,
    leadChanges: 0,
    leaderByRound: [],
  };
  const halfwayRound = Math.ceil(ROUNDS / 2);
  let halfwayLeader = null;
  let bountyPot = BOUNTY_BASE;
  let bountyClaimed = false;
  let jackpotTo = null;
  let previousLeader = null;

  for (let round = 1; round <= ROUNDS; round++) {
    const event = eventForRound(rng, round, ROUNDS, eventPool);
    if (round > 1) {
      for (const key of links) linkAges.set(key, (linkAges.get(key) || 0) + 1);
      bountyPot = bountyClaimed ? BOUNTY_BASE : bountyPot + 10;
      bountyClaimed = false;
    }
    jackpotTo = null;
    if (event.jackpot) {
      const lucky = choose(rng, players);
      lucky.credits += event.jackpot;
      jackpotTo = lucky.id;
    }
    const leader = rankPlayers(players)[0];
    const bountyTarget = leader.id;
    if (round >= halfwayRound && previousLeader != null && previousLeader !== leader.id) stats.leadChanges++;
    previousLeader = leader.id;
    stats.leaderByRound.push(leader.id);
    if (round === halfwayRound) halfwayLeader = leader.id;

    const warned = new Map();
    for (const p of players) {
      if (rng() < 0.14 + p.greed * 0.06) {
        const target = rankPlayers(players).find((candidate) => candidate.id !== p.id && (candidate.id === bountyTarget || candidate.traitorUntil >= round))
          || choose(rng, players.filter((candidate) => candidate.id !== p.id));
        warned.set(target.id, (warned.get(target.id) || 0) + 1);
      }
    }

    applySignals(rng, players, links, linkAges, settings, round, stats);
    selectActions(rng, players, links, linkAges, settings, event, round, {
      warned,
      bountyTarget,
      bountyPot,
      bountyClaimed,
      jackpotTo,
    }, stats);
    const context = { warned, bountyTarget, bountyPot, bountyClaimed, jackpotTo };
    resolveRound(players, links, linkAges, settings, event, round, context, stats);
    bountyClaimed = context.bountyClaimed;
  }

  const ranked = rankPlayers(players);
  const winnersN = Math.max(1, Math.round(players.length * (WINNERS_PERCENT / 100)));
  const winners = ranked.slice(0, winnersN);
  const winnerIds = new Set(winners.map((p) => p.id));
  const halfwayLeaderWon = winnerIds.has(halfwayLeader);
  const top = ranked[0].credits;
  const second = ranked[1]?.credits || top;
  return {
    stats,
    winnerArchetypes: winners.map((p) => p.archetype),
    halfwayLeaderWon,
    comebackWin: !halfwayLeaderWon,
    finalGapRatio: top > 0 ? (top - second) / top : 0,
    finalTopCredits: top,
  };
}

function inRangeScore(value, low, high, outerLow, outerHigh) {
  if (value >= low && value <= high) return 100;
  if (value < low) return clamp(((value - outerLow) / Math.max(0.0001, low - outerLow)) * 100, 0, 100);
  return clamp(((outerHigh - value) / Math.max(0.0001, outerHigh - high)) * 100, 0, 100);
}

function diversityScore(shares) {
  const values = ACTIONS.map((action) => shares[action] || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const minScore = clamp((min / 0.08) * 100, 0, 100);
  const maxScore = clamp(((0.48 - max) / 0.08) * 100, 0, 100);
  const entropy = values.reduce((sum, share) => share > 0 ? sum - share * Math.log(share) : sum, 0) / Math.log(ACTIONS.length);
  return Math.round(clamp((minScore * 0.35) + (maxScore * 0.25) + (entropy * 100 * 0.4), 0, 100));
}

function summarizeCandidate(settings, seed, games) {
  const aggregate = {
    actions: Object.fromEntries(ACTIONS.map((action) => [action, 0])),
    cooperativeMineActions: 0,
    linksFormed: 0,
    linksBroken: 0,
    consequentialBetrays: 0,
    breachSuccess: 0,
    blockedAttacks: 0,
    leadChanges: 0,
    comebackWins: 0,
    consequentialBetrayGames: 0,
    halfwayLeaderWins: 0,
    finalGapRatioSum: 0,
    finalTopCreditsSum: 0,
    winnerArchetypes: Object.fromEntries(ARCHETYPES.map((a) => [a.id, 0])),
  };

  for (let game = 0; game < games; game++) {
    const result = simulateGame(settings, seed, game);
    for (const action of ACTIONS) aggregate.actions[action] += result.stats.actions[action];
    aggregate.cooperativeMineActions += result.stats.cooperativeMineActions;
    aggregate.linksFormed += result.stats.linksFormed;
    aggregate.linksBroken += result.stats.linksBroken;
    aggregate.consequentialBetrays += result.stats.consequentialBetrays;
    aggregate.consequentialBetrayGames += result.stats.consequentialBetrays > 0 ? 1 : 0;
    aggregate.breachSuccess += result.stats.breachSuccess;
    aggregate.blockedAttacks += result.stats.blockedAttacks;
    aggregate.leadChanges += result.stats.leadChanges;
    aggregate.comebackWins += result.comebackWin ? 1 : 0;
    aggregate.halfwayLeaderWins += result.halfwayLeaderWon ? 1 : 0;
    aggregate.finalGapRatioSum += result.finalGapRatio;
    aggregate.finalTopCreditsSum += result.finalTopCredits;
    for (const archetype of result.winnerArchetypes) aggregate.winnerArchetypes[archetype]++;
  }

  const totalActions = Object.values(aggregate.actions).reduce((sum, value) => sum + value, 0);
  const actionShare = Object.fromEntries(ACTIONS.map((action) => [action, aggregate.actions[action] / totalActions]));
  const conflictRate = actionShare.hack + actionShare.breach + actionShare.betray;
  const cooperationRate = (aggregate.cooperativeMineActions + aggregate.linksFormed) / Math.max(1, totalActions);
  const comebackRate = aggregate.comebackWins / games;
  const halfwayLeaderWinRate = aggregate.halfwayLeaderWins / games;
  const leadChangesPerGame = aggregate.leadChanges / games;
  const consequentialBetrayActionShare = aggregate.consequentialBetrays / Math.max(1, totalActions);
  const consequentialBetrayRate = Math.min(actionShare.betray, consequentialBetrayActionShare);
  const finalGapRatio = aggregate.finalGapRatioSum / games;
  const winnerTotal = Object.values(aggregate.winnerArchetypes).reduce((sum, value) => sum + value, 0);
  const winnerShare = Object.fromEntries(Object.entries(aggregate.winnerArchetypes).map(([key, value]) => [key, value / winnerTotal]));
  const dominantStrategyShare = Math.max(...Object.values(winnerShare));
  const allianceChurn = aggregate.linksBroken / Math.max(1, aggregate.linksFormed);

  const subscores = {
    actionDiversity: diversityScore(actionShare),
    cooperationBalance: Math.round(inRangeScore(cooperationRate, 0.25, 0.55, 0.05, 0.75)),
    conflictBalance: Math.round(inRangeScore(conflictRate, 0.2, 0.5, 0.05, 0.7)),
    comeback: Math.round(inRangeScore(comebackRate, 0.25, 0.45, 0.05, 0.65)),
    leadVolatility: Math.round(inRangeScore(leadChangesPerGame, 1.4, 3.4, 0, 5)),
    betrayalRelevance: Math.round(inRangeScore(consequentialBetrayRate, 0.08, 0.22, 0, 0.38)),
    outcomeSpread: Math.round(inRangeScore(finalGapRatio, 0.08, 0.2, 0.01, 0.36)),
    strategyBalance: Math.round(clamp(((0.56 - dominantStrategyShare) / 0.18) * 100, 0, 100)),
    allianceChurn: Math.round(inRangeScore(allianceChurn, 0.18, 0.55, 0, 0.85)),
  };

  const hardRejects = [];
  if (halfwayLeaderWinRate > 0.65) hardRejects.push('runaway_leader');
  if (cooperationRate < 0.2) hardRejects.push('no_cooperation');
  if (conflictRate > 0.58 || actionShare.hack > 0.35) hardRejects.push('attack_spam');
  if (actionShare.mine > 0.45) hardRejects.push('passive_mining');
  if (consequentialBetrayRate < 0.05) hardRejects.push('betrayal_irrelevant');
  if (conflictRate < 0.15 || actionShare.wall > 0.4) hardRejects.push('defense_stalemate');
  if (dominantStrategyShare > 0.55 || comebackRate < 0.2) hardRejects.push('too_deterministic');

  const dynamicScoreRaw = round(
    subscores.actionDiversity * 0.17
    + subscores.cooperationBalance * 0.13
    + subscores.conflictBalance * 0.13
    + subscores.comeback * 0.14
    + subscores.leadVolatility * 0.12
    + subscores.betrayalRelevance * 0.11
    + subscores.outcomeSpread * 0.09
    + subscores.strategyBalance * 0.07
    + subscores.allianceChurn * 0.04
    - hardRejects.length * 8,
    2
  );
  const dynamicScore = Math.round(dynamicScoreRaw);

  return {
    settings,
    dynamicScore,
    dynamicScoreRaw,
    pass: hardRejects.length === 0 && dynamicScore >= 75,
    hardRejects,
    metrics: {
      actionShare: roundObject(actionShare, 4),
      conflictRate: round(conflictRate, 4),
      cooperationRate: round(cooperationRate, 4),
      comebackRate: round(comebackRate, 4),
      halfwayLeaderWinRate: round(halfwayLeaderWinRate, 4),
      leadChangesPerGame: round(leadChangesPerGame, 4),
      consequentialBetrayRate: round(consequentialBetrayRate, 4),
      consequentialBetrayGamesRate: round(aggregate.consequentialBetrayGames / games, 4),
      finalGapRatio: round(finalGapRatio, 4),
      dominantStrategyShare: round(dominantStrategyShare, 4),
      allianceChurn: round(allianceChurn, 4),
      breachSuccessPerGame: round(aggregate.breachSuccess / games, 4),
      blockedAttacksPerGame: round(aggregate.blockedAttacks / games, 4),
      averageWinningCredits: round(aggregate.finalTopCreditsSum / games, 2),
      winnerShare: roundObject(winnerShare, 4),
    },
    subscores,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundObject(input, digits) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, round(value, digits)]));
}

function runSearch({ seed, games, candidates }) {
  const rng = makeRng(hashSeed('candidate-search-grid', candidates));
  const seen = new Set();
  const summaries = [];
  for (let i = 0; summaries.length < candidates; i++) {
    const settings = sampleCandidate(rng, i);
    const key = settingKey(settings);
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(summarizeCandidate(settings, hashSeed(seed, key), games));
  }
  summaries.sort((a, b) => b.dynamicScoreRaw - a.dynamicScoreRaw || settingKey(a.settings).localeCompare(settingKey(b.settings)));
  return summaries;
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatSettings(settings) {
  return Object.entries(KOREAN_KEYS).map(([key, label]) => `${label} ${settings[key]}`).join(' / ');
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function summarizeCoverage(results) {
  const observedRanges = Object.fromEntries(SETTING_KEYS.map((key) => {
    const values = results.map((item) => item.settings[key]);
    const unique = [...new Set(values)].sort((a, b) => a - b);
    return [key, {
      declared: LIMITS[key],
      observed: [Math.min(...values), Math.max(...values)],
      distinctValues: unique.length,
      values: unique,
    }];
  }));

  const hardRejectCounts = {};
  for (const item of results) {
    for (const reject of item.hardRejects) hardRejectCounts[reject] = (hardRejectCounts[reject] || 0) + 1;
  }

  const byMaxLinks = {};
  for (const value of [...new Set(results.map((item) => item.settings.maxLinks))].sort((a, b) => a - b)) {
    const bucket = results.filter((item) => item.settings.maxLinks === value);
    const passBucket = bucket.filter((item) => item.pass);
    byMaxLinks[value] = {
      candidates: bucket.length,
      passCount: passBucket.length,
      bestScoreRaw: round(Math.max(...bucket.map((item) => item.dynamicScoreRaw)), 2),
      averageScoreRaw: round(average(bucket.map((item) => item.dynamicScoreRaw)), 2),
      rejectRate: round(bucket.filter((item) => item.hardRejects.length > 0).length / bucket.length, 4),
    };
  }

  const top = results[0];
  const roundedTies = results.filter((item) => item.pass === top.pass && item.dynamicScore === top.dynamicScore && item.hardRejects.length === top.hardRejects.length);
  return {
    observedRanges,
    passCount: results.filter((item) => item.pass).length,
    hardRejectCounts,
    byMaxLinks,
    roundedTieCount: roundedTies.length,
    roundedTieSettings: roundedTies.slice(0, 8).map((item) => ({
      settings: item.settings,
      dynamicScore: item.dynamicScore,
      dynamicScoreRaw: item.dynamicScoreRaw,
      hardRejects: item.hardRejects,
    })),
  };
}

function generateMarkdown(results, args) {
  const top = results[0];
  const coverage = summarizeCoverage(results);
  const lines = [];
  lines.push('# Neon Syndicate 역동성 설정 시뮬레이션');
  lines.push('');
  lines.push(`- seed: \`${args.seed}\``);
  lines.push(`- 후보 설정: \`${args.candidates}\``);
  lines.push(`- 후보당 게임 수: \`${args.games}\``);
  lines.push(`- 모델: 현재 서버의 5행동 정산식, 신뢰 누적, 이벤트, 현상금, 배신자 낙인을 반영한 deterministic Monte Carlo`);
  lines.push('- 후보 생성: 허용 한계 경계값 + 전체 범위 무작위 후보 + 실전형 집중 후보를 섞은 sampled search');
  lines.push('- 후보 풀은 후보 수에 따라 고정되며, seed는 각 후보의 게임 진행 난수만 바꿉니다.');
  lines.push('');
  lines.push('## 추천값');
  lines.push('');
  lines.push(`**${formatSettings(top.settings)}**`);
  lines.push('');
  lines.push(`역동성 점수: **${top.dynamicScoreRaw}/100** (정수 ${top.dynamicScore}/100, ${top.pass ? 'hard reject 없음' : `주의: ${top.hardRejects.join(', ')}`})`);
  if (coverage.roundedTieCount > 1) {
    lines.push('');
    lines.push(`정수 점수 ${top.dynamicScore}점 동점 후보가 ${coverage.roundedTieCount}개 있어, raw 점수와 재실행 안정성을 타이브레이크로 봅니다.`);
  }
  lines.push('');
  lines.push('| 지표 | 값 | 해석 |');
  lines.push('| --- | ---: | --- |');
  lines.push(`| 행동 다양성 | ${top.subscores.actionDiversity}/100 | mine/wall/hack/breach/betray가 한쪽으로 쏠리지 않는 정도 |`);
  lines.push(`| 협력 균형 | ${formatPercent(top.metrics.cooperationRate)} | 동맹 제안/협력 채굴이 살아있는 정도 |`);
  lines.push(`| 충돌 균형 | ${formatPercent(top.metrics.conflictRate)} | 해킹/우회/배신이 판을 흔드는 정도 |`);
  lines.push(`| 역전율 | ${formatPercent(top.metrics.comebackRate)} | 중반 선두가 아닌 플레이어가 생존권에 드는 비율 |`);
  lines.push(`| 중후반 선두 교체 | ${top.metrics.leadChangesPerGame}회/게임 | 끝까지 순위가 흔들리는 정도 |`);
  lines.push(`| 의미 있는 배신 행동 | ${formatPercent(top.metrics.consequentialBetrayRate)} | 배신이 실제 순위 변화를 만드는 행동 비중 |`);
  lines.push(`| 의미 있는 배신 발생 판 | ${formatPercent(top.metrics.consequentialBetrayGamesRate)} | 한 번 이상 순위 변화를 만든 배신이 나온 게임 비율 |`);
  lines.push(`| 1-2위 격차 | ${formatPercent(top.metrics.finalGapRatio)} | 너무 벌어지지도, 너무 붙지도 않는 정도 |`);
  lines.push('');
  lines.push('## 상위 후보');
  lines.push('');
  lines.push('| 순위 | raw 점수 | 정수 | 설정 | 협력 | 충돌 | 역전 | 배신 | reject |');
  lines.push('| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |');
  for (const [index, item] of results.slice(0, args.top).entries()) {
    lines.push(`| ${index + 1} | ${item.dynamicScoreRaw} | ${item.dynamicScore} | ${formatSettings(item.settings)} | ${formatPercent(item.metrics.cooperationRate)} | ${formatPercent(item.metrics.conflictRate)} | ${formatPercent(item.metrics.comebackRate)} | ${formatPercent(item.metrics.consequentialBetrayRate)} | ${item.hardRejects.join(', ') || '-'} |`);
  }
  lines.push('');
  lines.push('## 검색 범위');
  lines.push('');
  lines.push('| 항목 | 허용 범위 | 관측 범위 | 서로 다른 값 수 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const key of SETTING_KEYS) {
    const item = coverage.observedRanges[key];
    lines.push(`| ${KOREAN_KEYS[key]} | ${item.declared[0]}-${item.declared[1]} | ${item.observed[0]}-${item.observed[1]} | ${item.distinctValues} |`);
  }
  lines.push('');
  lines.push('| 동맹 한도 | 후보 수 | 통과 수 | 최고 raw 점수 | 평균 raw 점수 | reject 비율 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [value, item] of Object.entries(coverage.byMaxLinks)) {
    lines.push(`| ${value} | ${item.candidates} | ${item.passCount} | ${item.bestScoreRaw} | ${item.averageScoreRaw} | ${formatPercent(item.rejectRate)} |`);
  }
  lines.push('');
  lines.push('## 행동 비율');
  lines.push('');
  lines.push('| 행동 | 비율 |');
  lines.push('| --- | ---: |');
  for (const action of ACTIONS) lines.push(`| ${action} | ${formatPercent(top.metrics.actionShare[action])} |`);
  lines.push('');
  lines.push('## 적용 가이드');
  lines.push('');
  lines.push(`- 동맹 한도는 ${top.settings.maxLinks}을 1차 추천합니다. 이번 sampled search에서 모든 동맹 한도 ${LIMITS.maxLinks[0]}-${LIMITS.maxLinks[1]}를 실제 후보에 포함했고, 이 값이 현재 seed의 최고 raw 점수를 냈습니다.`);
  lines.push(`- 채굴 ${top.settings.mineBase}, 동맹+ ${top.settings.allyMineBonus}, 신뢰+ ${top.settings.trustMineBonus} 조합은 협력률 ${formatPercent(top.metrics.cooperationRate)}를 만들면서도 채굴 비중을 ${formatPercent(top.metrics.actionShare.mine)}로 묶었습니다.`);
  lines.push(`- 해킹 ${top.settings.steal}과 반격 ${top.settings.counter}는 충돌률 ${formatPercent(top.metrics.conflictRate)}와 방어 비중 ${formatPercent(top.metrics.actionShare.wall)}를 동시에 살려, 공격 과잉과 방어 고착 hard reject를 모두 피했습니다.`);
  lines.push(`- 배신 ${top.settings.betraySteal}, 배신신뢰+ ${top.settings.trustBetrayBonus}는 배신 행동 비중 ${formatPercent(top.metrics.actionShare.betray)}, 의미 있는 배신 행동 ${formatPercent(top.metrics.consequentialBetrayRate)}를 만들었습니다. 즉 배신이 강하지만 단독 필승 전략은 아닙니다.`);
  lines.push('- 동점/근접 후보가 있으므로 실제 수업에서 학생들이 지나치게 공격적이면 반격을 +5, 지나치게 수비적이면 반격을 -5 하는 식의 미세 조정 여지는 남겨둡니다.');
  lines.push('');
  lines.push('## 한계');
  lines.push('');
  lines.push('이 결과는 전체 조합을 완전탐색한 수학적 최적해가 아니라, 허용 범위 경계값과 넓은 무작위 후보를 포함한 sampled Monte Carlo 추천입니다. 실제 학생 심리 전체가 아니라 현재 서버 규칙을 반영한 봇형 전략 모델이므로, 수업에서 한두 판 운영한 뒤 행동 쏠림에 맞춰 5 단위로 미세 조정하면 됩니다.');
  return `${lines.join('\n')}\n`;
}

function writeOutputs(outDir, args, results) {
  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    args,
    limits: LIMITS,
    defaults: DEFAULT_SETTINGS,
    coverage: summarizeCoverage(results),
    scoring: {
      hardRejects: [
        'halfwayLeaderWinRate > 65%',
        'cooperationRate < 20%',
        'conflictRate > 58% or hackShare > 35%',
        'mineShare > 45%',
        'consequentialBetrayRate < 0.05/game',
        'conflictRate < 15% or wallShare > 40%',
        'dominantStrategyShare > 55% or comebackRate < 20%',
      ],
      pass: 'hardRejects empty and dynamicScore >= 75',
    },
    top: results.slice(0, args.top),
    candidates: results,
    candidatesEvaluated: results.length,
  };
  const jsonPath = path.join(outDir, 'dynamic-settings-results.json');
  const markdownPath = path.join(outDir, 'dynamic-settings-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, generateMarkdown(results, args), 'utf8');
  return { jsonPath, markdownPath, payload };
}

function printSummary(payload, paths) {
  const top = payload.top[0];
  console.log(JSON.stringify({
    ok: top.pass,
    recommendation: top.settings,
    dynamicScore: top.dynamicScore,
    dynamicScoreRaw: top.dynamicScoreRaw,
    hardRejects: top.hardRejects,
    metrics: top.metrics,
    subscores: top.subscores,
    candidatesEvaluated: payload.candidatesEvaluated,
    files: paths,
  }, null, 2));
  if (!top.pass) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }
  const results = runSearch(args);
  const paths = writeOutputs(args.outDir, args, results);
  printSummary(paths.payload, { json: paths.jsonPath, markdown: paths.markdownPath });
}

main();
