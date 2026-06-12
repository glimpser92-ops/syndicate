/* 서버 로직 자동 검증: 방장 생성 → 봇 20명 → 게임 시작 → 종료까지 관찰 */
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
let phases = 0, resolves = 0, linksFormed = 0, betrayals = 0;

ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: '테스터' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'joined') {
    console.log('방 생성됨:', m.code);
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ t: 'addBot' }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'start' })), 300);
  }
  if (m.t === 'room') console.log('로비 인원:', m.players.length);
  if (m.t === 'phase') {
    phases++;
    if (m.phase === 'event') console.log(`-- R${m.round} 이벤트: ${m.event.name} (${m.event.desc}) | 현상금: ${m.players.find(p => p.id === m.bounty)?.name}`);
    if (m.phase === 'signal') ws.send(JSON.stringify({ t: 'signal', kind: 'emoji', emoji: '🤝' }));
    if (m.phase === 'action') ws.send(JSON.stringify({ t: 'action', act: 'mine' }));
  }
  if (m.t === 'proposal') ws.send(JSON.stringify({ t: 'respond', from: m.from, accept: true }));
  if (m.t === 'linkFormed') linksFormed++;
  if (m.t === 'linkBroken' && m.betrayal) betrayals++;
  if (m.t === 'resolve') {
    resolves++;
    const top = [...m.players].sort((a, b) => b.credits - a.credits).slice(0, 3);
    console.log(`   R${m.round} 정산: 로그 ${m.logs.length}건 | 상위: ${top.map(p => p.name + ' ' + p.credits + 'C').join(', ')}`);
    const acts = m.logs.reduce((o, l) => (o[l.type] = (o[l.type] || 0) + 1, o), {});
    console.log('   행동 분포:', JSON.stringify(acts));
  }
  if (m.t === 'over') {
    console.log('게임 종료! 생존자:', m.winners.length, '| 동맹 결성:', linksFormed, '| 배신:', betrayals, '| 페이즈:', phases, '| 정산:', resolves);
    process.exit(0);
  }
});
ws.on('error', e => { console.error('연결 실패:', e.message); process.exit(1); });
setTimeout(() => { console.error('타임아웃'); process.exit(1); }, 8 * 60 * 1000);
