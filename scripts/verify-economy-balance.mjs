import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

const STUDENTS = ['Alpha', 'Beta', 'Cipher', 'Delta'];
const TARGETS = {
  cooperationAge0: 50,
  cooperationAge1: 58,
  betrayalAge2: 105,
  firewallCounter: 45,
  traitorMultiplierSteal: 72,
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(port, childLog) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return res.json();
    } catch {
      await delay(100);
    }
  }
  throw new Error(`health timeout stdout=${childLog.out} stderr=${childLog.err}`);
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function createClient(label, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const history = [];
  const waiters = new Set();

  ws.on('message', (raw) => {
    const msg = parseMessage(raw);
    if (!msg) return;
    history.push(msg);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(msg)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(msg);
    }
  });

  return {
    label,
    ws,
    history,
    open() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} ws open timeout`)), 5000);
        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    waitFor(predicate, labelText, timeout = 12000) {
      const seen = history.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`${label} message timeout: ${labelText}`));
          }, timeout),
        };
        waiters.add(waiter);
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function openClient(label, port) {
  const client = createClient(label, port);
  await client.open();
  return client;
}

function phaseWaiter(client, round, phase) {
  return client.waitFor(
    (m) => m.t === 'phase' && m.round === round && m.phase === phase,
    `round ${round} ${phase} phase`,
    30000,
  );
}

function resolveWaiter(client, round) {
  return client.waitFor((m) => m.t === 'resolve' && m.round === round, `round ${round} resolve`, 30000);
}

function byName(players, name) {
  const player = players.find((p) => p.name === name);
  if (!player) throw new Error(`missing player ${name}`);
  return player;
}

function logBy(logs, predicate, label) {
  const log = logs.find(predicate);
  if (!log) throw new Error(`missing resolve log: ${label}`);
  return log;
}

function eventMultiplier(event, kind) {
  const global = event?.global || 1;
  if (kind === 'mine') return global * (event?.mine || 1);
  if (kind === 'hack') return global * (event?.hack || 1);
  if (kind === 'betrayal') return global * (event?.hack || 1) * (event?.betray || 1);
  if (kind === 'counter') return global * (event?.counter || 1);
  return global;
}

function expectedAmount(base, event, kind) {
  return Math.round(base * eventMultiplier(event, kind));
}

function playerCredits(resolve, name) {
  return byName(resolve.players, name).credits;
}

function assertEqual(checks, category, label, actual, expected, context = {}) {
  const pass = Object.is(actual, expected);
  checks.push({ pass, category, label, actual, expected, context });
}

async function createRoom(port) {
  const host = await openClient('host', port);
  const hostRoomReady = host.waitFor((m) => m.t === 'room' && Array.isArray(m.players), 'host room');
  host.send({ t: 'create', name: 'Teacher' });
  const hostJoined = await host.waitFor((m) => m.t === 'joined' && m.role === 'host' && m.code, 'host joined');
  await hostRoomReady;

  const students = {};
  for (const name of STUDENTS) {
    const client = await openClient(name, port);
    client.send({ t: 'join', code: hostJoined.code, name });
    const joined = await client.waitFor((m) => m.t === 'joined' && m.role === 'player' && m.you, `${name} joined`);
    students[name] = { ...client, id: joined.you };
  }

  const room = await host.waitFor(
    (m) => m.t === 'room' && m.code === hostJoined.code && Array.isArray(m.players) && m.players.length === 4,
    'host sees four students',
  );

  host.send({ t: 'settings', patch: { rounds: 3, signalSeconds: 8, actionSeconds: 8, resolveSeconds: 5 } });
  await host.waitFor((m) => m.t === 'settings' && m.rounds === 3, 'settings applied');

  return { host, students, code: hostJoined.code, room };
}

async function formAlliance(host, students, proposerName, responderName, ids) {
  const proposer = students[proposerName];
  const responder = students[responderName];
  const proposal = responder.waitFor((m) => m.t === 'proposal' && m.from === ids[proposerName], `${responderName} proposal`);
  const formed = host.waitFor(
    (m) => m.t === 'linkFormed' && new Set([m.a, m.b]).has(ids[proposerName]) && new Set([m.a, m.b]).has(ids[responderName]),
    `${proposerName}-${responderName} link formed`,
  );
  proposer.send({ t: 'signal', kind: 'propose', target: ids[responderName] });
  const proposalMsg = await proposal;
  responder.send({ t: 'respond', from: proposalMsg.from, accept: true });
  await formed;
}

async function sendActions(students, actions) {
  const acknowledgements = [];
  for (const [name, action] of Object.entries(actions)) {
    const client = students[name];
    acknowledgements.push(client.waitFor((m) => m.t === 'actionOk' && m.act === action.act, `${name} action ok`));
    client.send({ t: 'action', ...action });
  }
  await Promise.all(acknowledgements);
}

async function runScenario(port) {
  const { host, students, code } = await createRoom(port);
  const sockets = [host, ...Object.values(students)];
  const checks = [];
  const observations = { code, rounds: [] };

  try {
    host.send({ t: 'start' });

    const r1Event = await phaseWaiter(host, 1, 'event');
    const ids = Object.fromEntries(r1Event.players.map((p) => [p.name, p.id]));
    assertEqual(
      checks,
      'bot safety',
      'scenario uses four human participants and no bots',
      r1Event.players.filter((p) => p.bot).length,
      0,
      { round: 1, studentCount: r1Event.players.length, names: r1Event.players.map((p) => p.name) },
    );
    await phaseWaiter(host, 1, 'signal');
    await formAlliance(host, students, 'Alpha', 'Beta', ids);
    await formAlliance(host, students, 'Cipher', 'Delta', ids);
    await phaseWaiter(host, 1, 'action');
    await sendActions(students, {
      Alpha: { act: 'mine' },
      Beta: { act: 'mine' },
      Cipher: { act: 'hack', target: ids.Delta },
      Delta: { act: 'mine' },
    });
    const r1 = await resolveWaiter(host, 1);
    observations.rounds.push({ round: 1, event: r1Event.event, logs: r1.logs, players: r1.players });

    const r1AlphaMine = logBy(r1.logs, (l) => l.type === 'mine' && l.from === ids.Alpha, 'round 1 Alpha mine');
    const r1CipherBetray = logBy(
      r1.logs,
      (l) => l.type === 'hack' && l.from === ids.Cipher && l.to === ids.Delta && l.betrayal === true,
      'round 1 Cipher betrayal',
    );
    assertEqual(
      checks,
      'cooperation growth',
      'standard linked age 0 cooperative mine pays the approved immediate alliance target',
      r1AlphaMine.amount,
      TARGETS.cooperationAge0,
      { round: 1, event: r1Event.event?.id, allies: r1AlphaMine.allies },
    );
    assertEqual(
      checks,
      'traitor multiplier',
      'first betrayal exposes the betrayer as marked in public snapshots',
      byName(r1.players, 'Cipher').traitor,
      true,
      { round: 1 },
    );
    assertEqual(
      checks,
      'betrayal spike',
      'age 0 betrayal is observed through the public resolve log',
      r1CipherBetray.amount,
      expectedAmount(75, r1Event.event, 'betrayal'),
      { round: 1, event: r1Event.event?.id, trust: r1CipherBetray.trust },
    );

    const r2Event = await phaseWaiter(host, 2, 'event');
    assertEqual(
      checks,
      'traitor multiplier',
      'betrayer remains marked in the next round',
      byName(r2Event.players, 'Cipher').traitor,
      true,
      { round: 2, event: r2Event.event?.id },
    );
    await phaseWaiter(host, 2, 'signal');
    await phaseWaiter(host, 2, 'action');
    await sendActions(students, {
      Alpha: { act: 'mine' },
      Beta: { act: 'mine' },
      Cipher: { act: 'mine' },
      Delta: { act: 'hack', target: ids.Cipher },
    });
    const r2 = await resolveWaiter(host, 2);
    observations.rounds.push({ round: 2, event: r2Event.event, logs: r2.logs, players: r2.players });

    const r2AlphaMine = logBy(r2.logs, (l) => l.type === 'mine' && l.from === ids.Alpha, 'round 2 Alpha mine');
    const r2TraitorHit = logBy(
      r2.logs,
      (l) => l.type === 'hack' && l.from === ids.Delta && l.to === ids.Cipher,
      'round 2 marked traitor hit',
    );
    assertEqual(
      checks,
      'cooperation growth',
      'aged link at age 1 cooperative mine pays the approved trust-growth target after event modifiers',
      r2AlphaMine.amount,
      expectedAmount(TARGETS.cooperationAge1, r2Event.event, 'mine'),
      { round: 2, event: r2Event.event?.id, allies: r2AlphaMine.allies, linkAges: r2.linkAges },
    );
    assertEqual(
      checks,
      'traitor multiplier',
      'hacking a marked mining traitor steals the approved multiplier amount after event modifiers',
      r2TraitorHit.amount,
      expectedAmount(TARGETS.traitorMultiplierSteal, r2Event.event, 'hack'),
      { round: 2, event: r2Event.event?.id, targetTraitor: byName(r2Event.players, 'Cipher').traitor },
    );

    const r3Event = await phaseWaiter(host, 3, 'event');
    assertEqual(
      checks,
      'traitor multiplier',
      'one-round traitor mark has cleared by the following round after vulnerability is tested',
      byName(r3Event.players, 'Cipher').traitor,
      false,
      { round: 3, event: r3Event.event?.id },
    );
    await phaseWaiter(host, 3, 'signal');
    await phaseWaiter(host, 3, 'action');
    await sendActions(students, {
      Alpha: { act: 'hack', target: ids.Beta },
      Beta: { act: 'mine' },
      Cipher: { act: 'hack', target: ids.Delta },
      Delta: { act: 'wall' },
    });
    const r3 = await resolveWaiter(host, 3);
    observations.rounds.push({ round: 3, event: r3Event.event, logs: r3.logs, players: r3.players });

    const r3Betray = logBy(
      r3.logs,
      (l) => l.type === 'hack' && l.from === ids.Alpha && l.to === ids.Beta && l.betrayal === true,
      'round 3 aged betrayal',
    );
    const r3Firewall = logBy(
      r3.logs,
      (l) => l.type === 'blocked' && l.from === ids.Cipher && l.to === ids.Delta,
      'round 3 firewall counter',
    );
    assertEqual(
      checks,
      'betrayal spike',
      'aged link at age 2 betrayal steals the approved spike amount after event modifiers',
      r3Betray.amount,
      expectedAmount(TARGETS.betrayalAge2, r3Event.event, 'betrayal'),
      { round: 3, event: r3Event.event?.id, trust: r3Betray.trust, linkAges: r3.linkAges },
    );
    assertEqual(
      checks,
      'firewall counter',
      'wrong hack into firewall loses the approved punishment amount after event modifiers',
      r3Firewall.amount,
      expectedAmount(TARGETS.firewallCounter, r3Event.event, 'counter'),
      { round: 3, event: r3Event.event?.id },
    );

    const failures = checks.filter((check) => !check.pass);
    const summary = {
      ok: failures.length === 0,
      targetAmounts: TARGETS,
      categoriesObserved: [...new Set(checks.map((check) => check.category))],
      failureCategories: [...new Set(failures.map((check) => check.category))],
      noBotParticipants: checks.some((check) => check.category === 'bot safety' && check.pass),
      checks,
      observations: {
        code,
        students: STUDENTS,
        rounds: observations.rounds.map((round) => ({
          round: round.round,
          event: round.event,
          logs: round.logs,
          players: round.players.map((p) => ({ name: p.name, bot: p.bot, credits: p.credits, traitor: p.traitor })),
        })),
        finalCredits: Object.fromEntries(STUDENTS.map((name) => [name, playerCredits(r3, name)])),
      },
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    for (const socket of sockets) socket.close();
  }
}

async function main() {
  const port = await getFreePort();
  const childLog = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    childLog.out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childLog.err += chunk.toString();
  });

  try {
    await waitHealth(port, childLog);
    await runScenario(port);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, childLog }, null, 2));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
}

await main();
