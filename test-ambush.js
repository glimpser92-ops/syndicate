const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT || (3200 + Math.floor(Math.random() * 600)));
const URL = `ws://localhost:${PORT}`;
const ROOT = __dirname;

let child = null;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await new Promise(resolve => {
      const req = http.get(`http://localhost:${PORT}/healthz`, res => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await wait(150);
  }
  throw new Error('server did not become healthy');
}

async function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(String(d)));
  child.stderr.on('data', d => process.stderr.write(String(d)));
  await waitForHealth();
}

class Client {
  constructor(name) {
    this.name = name;
    this.id = null;
    this.messages = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.on('message', raw => this.onMessage(JSON.parse(raw)));
    });
  }

  onMessage(msg) {
    this.messages.push(msg);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(msg)) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter(x => x !== waiter);
      waiter.resolve(msg);
    }
  }

  waitFor(match, label, timeout = 15000) {
    const old = this.messages.find(match);
    if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(x => x !== waiter);
          reject(new Error(`${this.name} timed out waiting for ${label}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    if (this.ws && this.ws.readyState < 2) this.ws.close();
  }
}

async function createHost() {
  const host = new Client('host');
  await host.connect();
  host.send({ t: 'create', name: 'tester' });
  const joined = await host.waitFor(m => m.t === 'joined', 'host joined');
  return { host, code: joined.code };
}

async function joinPlayer(name, code) {
  const client = new Client(name);
  await client.connect();
  client.send({ t: 'join', code, name });
  const joined = await client.waitFor(m => m.t === 'joined', `${name} joined`);
  client.id = joined.you;
  return client;
}

async function expectNoInvalidAmbushOk(player, targetId) {
  const invalidOk = player.waitFor(m => m.t === 'actionOk' && m.act === 'ambush', 'invalid ambush ack', 700)
    .then(() => true, () => false);
  player.send({ t: 'action', act: 'ambush', target: targetId, predict: 'mine' });
  if (await invalidOk) throw new Error('ambush was accepted before the climax rounds');
}

function assertAmbush(log, expected) {
  if (!log) throw new Error(`missing ambush log for ${expected}`);
  if (log.amount <= 0 || log.amount > 45) throw new Error(`ambush amount out of bounds: ${log.amount}`);
}

async function main() {
  await startServer();
  const clients = [];
  try {
    const { host, code } = await createHost();
    clients.push(host);
    host.send({ t: 'settings', patch: { rounds: 3, signalSeconds: 8, actionSeconds: 8, resolveSeconds: 5 } });

    const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(name => joinPlayer(name, code)));
    clients.push(a, b, c, d);
    await host.waitFor(m => m.t === 'room' && m.players && m.players.length >= 4, 'four players');
    host.send({ t: 'start' });

    await host.waitFor(m => m.t === 'phase' && m.round === 1 && m.phase === 'action', 'round 1 action', 25000);
    await expectNoInvalidAmbushOk(a, b.id);
    a.send({ t: 'action', act: 'wall' });
    b.send({ t: 'action', act: 'mine' });
    c.send({ t: 'action', act: 'mine' });
    d.send({ t: 'action', act: 'mine' });
    await host.waitFor(m => m.t === 'resolve' && m.round === 1, 'round 1 resolve', 12000);

    await host.waitFor(m => m.t === 'phase' && m.round === 2 && m.phase === 'action', 'round 2 action', 30000);
    const ok = a.waitFor(m => m.t === 'actionOk' && m.act === 'ambush' && m.predict === 'mine', 'ambush action ok', 1500);
    a.send({ t: 'action', act: 'ambush', target: b.id, predict: 'mine' });
    b.send({ t: 'action', act: 'mine' });
    c.send({ t: 'action', act: 'wall' });
    d.send({ t: 'action', act: 'hack', target: c.id });
    await ok;
    const r2 = await host.waitFor(m => m.t === 'resolve' && m.round === 2, 'round 2 resolve', 12000);
    const success = r2.logs.find(l => l.type === 'ambush' && l.from === a.id && l.to === b.id);
    assertAmbush(success, 'round 2 success');
    if (!success.success || success.predict !== 'mine' || success.actual !== 'mine') {
      throw new Error(`unexpected ambush success log: ${JSON.stringify(success)}`);
    }
    if (!success.belowCutoff) throw new Error('catch-up ambush did not mark belowCutoff');

    await host.waitFor(m => m.t === 'phase' && m.round === 3 && m.phase === 'action', 'round 3 action', 30000);
    a.send({ t: 'action', act: 'ambush', target: b.id, predict: 'hack' });
    b.send({ t: 'action', act: 'mine' });
    c.send({ t: 'action', act: 'wall' });
    d.send({ t: 'action', act: 'mine' });
    const r3 = await host.waitFor(m => m.t === 'resolve' && m.round === 3, 'round 3 resolve', 12000);
    const failure = r3.logs.find(l => l.type === 'ambush' && l.from === a.id && l.to === b.id);
    if (!failure || failure.success || failure.penalty !== 15) {
      throw new Error(`unexpected ambush failure log: ${JSON.stringify(failure)}`);
    }

    console.log('ambush deterministic test passed');
  } finally {
    clients.forEach(client => client.close());
    if (child) child.kill();
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  if (child) child.kill();
  process.exit(1);
});
