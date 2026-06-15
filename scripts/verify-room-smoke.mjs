import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

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

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitMessage(ws, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`message timeout: ${label}`)), 5000);
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
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

  let host;
  let student;
  try {
    const health = await waitHealth(port, childLog);
    host = await openSocket(port);
    const hostRoomReady = waitMessage(host, (m) => m.t === 'room' && Array.isArray(m.players), 'host room');
    host.send(JSON.stringify({ t: 'create', name: '방장' }));
    const hostJoined = await waitMessage(host, (m) => m.t === 'joined' && m.role === 'host' && m.code, 'host joined');
    await hostRoomReady;

    const code = hostJoined.code;
    const hostSeesStudent = waitMessage(
      host,
      (m) => m.t === 'room' && m.code === code && Array.isArray(m.players) && m.players.some((p) => p.name === '학생1'),
      'host sees student',
    );

    student = await openSocket(port);
    student.send(JSON.stringify({ t: 'join', code, name: '학생1' }));
    const studentJoined = await waitMessage(student, (m) => m.t === 'joined' && m.role === 'player', 'student joined');
    const room = await hostSeesStudent;
    const players = Array.isArray(room.players) ? room.players : [];

    const result = {
      ok: true,
      health,
      code,
      hostRole: hostJoined.role,
      studentRole: studentJoined.role,
      max: room.max,
      playerCount: players.length,
      hostExcludedFromPlayers: !players.some((p) => p.name === '방장'),
      studentNames: players.map((p) => p.name),
    };

    const checks = {
      healthOk: health.ok === true,
      hostIsHost: result.hostRole === 'host',
      studentIsPlayer: result.studentRole === 'player',
      maxIsTwenty: result.max === 20,
      studentJoinedList: result.studentNames.includes('학생1'),
      hostExcludedFromPlayers: result.hostExcludedFromPlayers,
    };

    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ ok, checks, result }, null, 2));
    if (!ok) process.exitCode = 1;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message, childLog }, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      host?.close();
    } catch {}
    try {
      student?.close();
    } catch {}
    child.kill('SIGTERM');
  }
}

await main();
