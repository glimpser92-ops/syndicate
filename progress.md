Original prompt: 이 게임을 github에 배포해서 쓰려고 해. 어떻게 해야 돼? 그리고 방장이 방을 열면 학생들이 접속할 수 있게 해줘.

Done:
- Reviewed the Node/WebSocket game structure.
- Confirmed multiplayer rooms already exist server-side.
- Added Render deployment config, Git ignore rules, package engine, and a health check endpoint.
- Added shareable student invite links, clipboard fallback, invite-code URL prefill, and test hooks.
- Updated README with GitHub/Render deployment and classroom usage steps.
- Verified syntax, health endpoint, WebSocket host/student room join, and host lobby share UI.
- Added a first-screen neon tutorial simulation with side-by-side rule explanation for mining, firewall, hacking, and betrayal examples.
- Verified tutorial behavior in the browser at desktop and mobile widths with no console errors.
- Split host into a non-playing monitor/admin role; student/bot participants are counted separately up to 20.
- Added host-adjustable live room rules and game-phase settings.
- Added in-game reconnect code/link/QR surfaces and player rejoin tokens.
- Verified host lobby, host monitor, student game UI, settings WebSocket updates, and in-game player rejoin.

TODO:
- No pending TODOs.
