/* 개발용: 지정 포트에 방을 만들고 봇 19명을 채운 뒤, 학생이 1명 들어오면 자동 시작 */
const WebSocket = require('ws');
const PORT = process.argv[2] || 3000;
const ws = new WebSocket('ws://localhost:' + PORT);
let started = false;
ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: '데모방장' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'joined') {
    console.log('CODE:' + m.code);
    for (let i = 0; i < 19; i++) ws.send(JSON.stringify({ t: 'addBot' }));
  }
  if (m.t === 'room' && !started && m.players.some(p => !p.bot)) {
    started = true;
    setTimeout(() => ws.send(JSON.stringify({ t: 'start' })), 800);
    console.log('학생 입장 감지 → 게임 시작');
  }
  if (m.t === 'over') { console.log('게임 종료'); process.exit(0); }
});
setTimeout(() => process.exit(0), 15 * 60 * 1000);
