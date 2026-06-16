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
  const students = [];
  try {
    const health = await waitHealth(port, childLog);
    host = await openSocket(port);
    const hostRoomReady = waitMessage(host, (m) => m.t === 'room' && Array.isArray(m.players), 'host room');
    host.send(JSON.stringify({ t: 'create', name: '방장' }));
    const hostJoined = await waitMessage(host, (m) => m.t === 'joined' && m.role === 'host' && m.code, 'host joined');
    await hostRoomReady;

    const code = hostJoined.code;
    const joinedStudents = [];
    for (const name of ['학생1', '학생2', '학생3', '학생4']) {
      const student = await openSocket(port);
      students.push(student);
      student.send(JSON.stringify({ t: 'join', code, name }));
      joinedStudents.push(await waitMessage(student, (m) => m.t === 'joined' && m.role === 'player', `${name} joined`));
    }
    const room = await waitMessage(
      host,
      (m) => m.t === 'room' && m.code === code && Array.isArray(m.players) && m.players.length === 4,
      'host sees four students',
    );
    const players = Array.isArray(room.players) ? room.players : [];

    const lobbySettingsSeen = waitMessage(
      students[0],
      (m) => m.t === 'settings' && m.settings?.allyMineBonus === 23 && m.settings?.trustMineBonus === 9,
      'student sees lobby economy settings',
    );
    host.send(JSON.stringify({ t: 'settings', patch: { allyMineBonus: 23, trustMineBonus: 9, counter: 47, trustBetrayBonus: 16 } }));
    const lobbySettings = await lobbySettingsSeen;

    const phaseSeen = waitMessage(host, (m) => m.t === 'phase' && m.phase === 'event' && m.round === 1, 'game event phase');
    host.send(JSON.stringify({ t: 'start' }));
    await phaseSeen;

    const liveSettingsSeen = waitMessage(
      students[0],
      (m) => m.t === 'settings' && m.round === 1 && m.settings?.counter === 49 && m.settings?.trustBetrayBonus === 18,
      'student sees live economy settings',
    );
    host.send(JSON.stringify({ t: 'settings', patch: { counter: 49, trustBetrayBonus: 18 } }));
    const liveSettings = await liveSettingsSeen;

    const result = {
      ok: true,
      health,
      code,
      hostRole: hostJoined.role,
      studentRoles: joinedStudents.map((student) => student.role),
      max: room.max,
      playerCount: players.length,
      hostExcludedFromPlayers: !players.some((p) => p.name === '방장'),
      studentNames: players.map((p) => p.name),
      lobbySettings: {
        allyMineBonus: lobbySettings.settings.allyMineBonus,
        trustMineBonus: lobbySettings.settings.trustMineBonus,
        counter: lobbySettings.settings.counter,
        trustBetrayBonus: lobbySettings.settings.trustBetrayBonus,
      },
      liveSettings: {
        counter: liveSettings.settings.counter,
        trustBetrayBonus: liveSettings.settings.trustBetrayBonus,
        round: liveSettings.round,
      },
    };

    const checks = {
      healthOk: health.ok === true,
      hostIsHost: result.hostRole === 'host',
      studentsArePlayers: result.studentRoles.every((role) => role === 'player'),
      maxIsTwenty: result.max === 20,
      studentJoinedList: result.studentNames.includes('학생1'),
      hostExcludedFromPlayers: result.hostExcludedFromPlayers,
      fourStudentsCanStart: result.playerCount === 4,
      lobbyEconomySettingsBroadcast:
        result.lobbySettings.allyMineBonus === 23 &&
        result.lobbySettings.trustMineBonus === 9 &&
        result.lobbySettings.counter === 47 &&
        result.lobbySettings.trustBetrayBonus === 16,
      liveEconomySettingsBroadcast:
        result.liveSettings.round === 1 &&
        result.liveSettings.counter === 49 &&
        result.liveSettings.trustBetrayBonus === 18,
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
      for (const student of students) student.close();
    } catch {}
    child.kill('SIGTERM');
  }
}

await main();
