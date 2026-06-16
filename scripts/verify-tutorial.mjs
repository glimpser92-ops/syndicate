import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];

if (!script) {
  throw new Error('No inline script found in public/index.html');
}

function makeCanvasContext() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return {
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    drawImage: noop,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
}

function classListFor(element) {
  const classes = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
  const sync = () => {
    element.className = [...classes].join(' ');
  };
  return {
    add: (...names) => {
      names.forEach((name) => classes.add(name));
      sync();
    },
    remove: (...names) => {
      names.forEach((name) => classes.delete(name));
      sync();
    },
    toggle: (name, force) => {
      const shouldHave = force === undefined ? !classes.has(name) : Boolean(force);
      if (shouldHave) classes.add(name);
      else classes.delete(name);
      sync();
      return shouldHave;
    },
    contains: (name) => classes.has(name),
  };
}

function createDom() {
  const byId = new Map();

  function element(id = '', className = '') {
    const node = {
      id,
      className,
      dataset: {},
      style: {},
      children: [],
      disabled: false,
      value: '',
      textContent: '',
      src: '',
      checked: false,
      width: 800,
      height: 500,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      remove() {},
      select() {},
      focus() {},
      blur() {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      getAttribute(name) {
        return this[name] ?? null;
      },
      addEventListener(type, handler) {
        this[`on${type}`] = handler;
      },
      getContext() {
        return makeCanvasContext();
      },
      getBoundingClientRect() {
        return { x: 0, y: 0, width: 100, height: 30, right: 100, bottom: 30 };
      },
      querySelector(selector) {
        if (selector === '.credit') return this.creditElement || null;
        if (selector === 'b') return this.labelElement || null;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };

    Object.defineProperty(node, 'innerHTML', {
      get() {
        return this._innerHTML || '';
      },
      set(value) {
        this._innerHTML = String(value);
        this.textContent = String(value).replace(/<[^>]*>/g, '');
      },
    });

    node.classList = classListFor(node);
    if (id) byId.set(id, node);
    return node;
  }

  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    if (!byId.has(id)) element(id);
  }

  const screens = ['screen-home', 'screen-lobby', 'screen-game', 'screen-over'].map((id, index) => {
    const screen = byId.get(id);
    screen.className = `screen${index === 0 ? ' on' : ''}`;
    screen.classList = classListFor(screen);
    return screen;
  });

  const actionElements = ['mine', 'wall', 'hack', 'betray'].map((action) => {
    const node = element(`action-${action}`, 'act-btn tut-choice');
    node.dataset.tutorialAction = action;
    return node;
  });

  const phaseElements = ['event', 'signal', 'choice', 'settlement'].map((phase) => {
    const node = element(`phase-${phase}`, 'rule-chip');
    node.dataset.tutorialPhase = phase;
    return node;
  });

  const ruleInputs = [
    'maxLinks',
    'rounds',
    'winnersPercent',
    'mineBase',
    'allyMineBonus',
    'trustMineBonus',
    'steal',
    'counter',
    'betraySteal',
    'trustBetrayBonus',
    'signalSeconds',
    'actionSeconds',
    'resolveSeconds',
  ].map((rule) => {
    const node = element(`rule-${rule}`);
    node.dataset.rule = rule;
    node.value = '1';
    return node;
  });

  const simNodes = ['me', 'ally', 'rival', 'guard'].map((id) => {
    const node = byId.get(`tut-${id}`) || element(`tut-${id}`, 'sim-node');
    node.className = `sim-node ${id}`;
    node.classList = classListFor(node);
    node.creditElement = element(`credit-${id}`, 'credit');
    node.labelElement = element(`label-${id}`);
    node.labelElement.textContent = id.toUpperCase();
    return node;
  });

  const body = element('body');
  const document = {
    body,
    hidden: false,
    getElementById(id) {
      if (!byId.has(id)) element(id);
      return byId.get(id);
    },
    createElement() {
      return element();
    },
    execCommand() {
      return true;
    },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
    querySelector(selector) {
      if (selector === '.screen.on') {
        return screens.find((screen) => screen.classList.contains('on')) || screens[0];
      }
      if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
      return element();
    },
    querySelectorAll(selector) {
      if (selector === '.screen') return screens;
      if (selector === '[data-tutorial-action]') return actionElements;
      if (selector === '[data-tutorial-phase]') return phaseElements;
      if (selector === '[data-rule]') return ruleInputs;
      if (selector === '.sim-node') return simNodes;
      if (selector === '#tut-rules li') return byId.get('tut-rules')?.children || [];
      if (selector === '.host-settings') return [];
      if (selector === '#dock-actions .act-btn') return [];
      if (selector === '.sig-btn') return [];
      return [];
    },
  };

  return { document, byId, actionElements };
}

const dom = createDom();
const sandbox = {
  document: dom.document,
  window: null,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { clipboard: null },
  location: {
    href: 'http://127.0.0.1:4904/',
    protocol: 'http:',
    host: '127.0.0.1:4904',
    origin: 'http://127.0.0.1:4904',
    search: '',
    hash: '',
  },
  URL,
  URLSearchParams,
  Map,
  Set,
  Math,
  JSON,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Date,
  Promise,
  console,
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  WebSocket: function WebSocket() {
    return { readyState: 0, send() {}, close() {} };
  },
  AudioContext: function AudioContext() {
    return {
      currentTime: 0,
      destination: {},
      createOscillator: () => ({ frequency: { value: 0 }, connect() {}, start() {}, stop() {} }),
      createGain: () => ({ gain: { value: 0, exponentialRampToValueAtTime() {} }, connect() {} }),
    };
  },
};
sandbox.window = sandbox;
sandbox.window.requestAnimationFrame = () => 0;

vm.runInNewContext(script, sandbox, { filename: 'public/index.html:inline.js', timeout: 1000 });

const payload = () => JSON.parse(sandbox.window.render_game_to_text()).tutorial;
const next = dom.byId.get('tut-next');
const prev = dom.byId.get('tut-prev');
const restart = dom.byId.get('tut-restart');
const action = (name) => dom.actionElements.find((node) => node.dataset.tutorialAction === name);
const snapshots = [];
const snap = (label) => snapshots.push({ label, tutorial: payload(), nextDisabled: next.disabled, prevDisabled: prev.disabled });

snap('initial');
next.onclick();
next.onclick();
snap('r1-choice-before');
action('mine').onclick();
snap('r1-choice-after-mine');
next.onclick();
snap('r1-settle');
next.onclick();
next.onclick();
next.onclick();
action('mine').onclick();
next.onclick();
snap('r2-settle-mine');
prev.onclick();
snap('r2-back-choice-preserved');
prev.onclick();
next.onclick();
snap('r2-choice-cleared');
action('mine').onclick();
next.onclick();
next.onclick();
next.onclick();
next.onclick();
action('betray').onclick();
next.onclick();
next.onclick();
snap('final-betray');
restart.onclick();
snap('after-restart');

const checks = {
  renderHookExposed: typeof sandbox.window.render_game_to_text === 'function',
  initialStep: snapshots[0].tutorial.stepId === 'r1-event',
  r1ChoiceBlocksNext: snapshots.find((s) => s.label === 'r1-choice-before').nextDisabled === true,
  r1MineUnlocksNext: snapshots.find((s) => s.label === 'r1-choice-after-mine').nextDisabled === false,
  r2BackPreservesHack:
    snapshots.find((s) => s.label === 'r2-back-choice-preserved').tutorial.selectedAction === 'mine' &&
    snapshots.find((s) => s.label === 'r2-back-choice-preserved').nextDisabled === false,
  r2EarlierBackClearsChoice:
    snapshots.find((s) => s.label === 'r2-choice-cleared').tutorial.selectedAction === '' &&
    snapshots.find((s) => s.label === 'r2-choice-cleared').nextDisabled === true,
  r1CooperationShowsNewBase:
    snapshots.find((s) => s.label === 'r1-settle').tutorial.log.includes('+50C') &&
    snapshots.find((s) => s.label === 'r1-settle').tutorial.scores.me === 150 &&
    snapshots.find((s) => s.label === 'r1-settle').tutorial.scores.ally === 150,
  r2CooperationGrowsWithTrust:
    snapshots.find((s) => s.label === 'r2-settle-mine').tutorial.log.includes('+58C') &&
    snapshots.find((s) => s.label === 'r2-settle-mine').tutorial.scores.me === 208 &&
    snapshots.find((s) => s.label === 'r2-settle-mine').tutorial.trust === 2,
  finalIsBetrayMarked:
    snapshots.find((s) => s.label === 'final-betray').tutorial.phase === 'final' &&
    snapshots.find((s) => s.label === 'final-betray').tutorial.traitorMark === true,
  finalBetrayShowsSpikeAndRisk:
    snapshots.find((s) => s.label === 'final-betray').tutorial.scores.me === 313 &&
    snapshots.find((s) => s.label === 'final-betray').tutorial.log.includes('TRAITOR MARK') &&
    (
      snapshots.find((s) => s.label === 'final-betray').tutorial.body.includes('다음 라운드') ||
      snapshots.find((s) => s.label === 'final-betray').tutorial.note.includes('위험')
    ),
  restartReturnsInitial:
    snapshots.find((s) => s.label === 'after-restart').tutorial.stepId === 'r1-event' &&
    snapshots.find((s) => s.label === 'after-restart').prevDisabled === true,
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
const result = {
  ok: failed.length === 0,
  checks,
  snapshots: snapshots.map((snapshot) => ({
    label: snapshot.label,
    stepId: snapshot.tutorial.stepId,
    phase: snapshot.tutorial.phase,
    selectedAction: snapshot.tutorial.selectedAction,
    title: snapshot.tutorial.title,
    body: snapshot.tutorial.body,
    log: snapshot.tutorial.log,
    note: snapshot.tutorial.note,
    scores: snapshot.tutorial.scores,
    trust: snapshot.tutorial.trust,
    nextDisabled: snapshot.nextDisabled,
    traitorMark: snapshot.tutorial.traitorMark,
  })),
};

if (failed.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
