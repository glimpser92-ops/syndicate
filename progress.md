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
- Added a student entry QR code to the host lobby immediately after room creation.
- Reworked the first-screen tutorial into a guided 3-round rule simulation with choices, phase navigation, and richer text-state verification.
- Fixed tutorial back-navigation so returning from settlement preserves the current choice, while stepping back before the choice clears it.
- Added guarded event, canvas, animation, and WebSocket fallbacks so the first-screen tutorial keeps running in restricted browser environments.
- Verified the 3-round tutorial path through mining, bounty hacking, betrayal, final results, restart, and 390px mobile width; verified host room creation plus student join over WebSocket.
- Added `scripts/verify-tutorial.mjs` to regression-check the scripted tutorial and `window.render_game_to_text` without needing a live browser.
- Adjusted the first-screen layout after independent designer review: the home screen now starts from the top instead of vertical centering, mobile shows the tutorial before the join/create card, and mobile tutorial actions appear before the longer explanation block.
- Added `scripts/verify-room-smoke.mjs` and `npm run verify:room` to durably regression-check host room creation, student join, max 20 participants, and host exclusion from the player list.
- Received independent code-reviewer approval for the final tutorial/room behavior; an architect gate still needs to be rerun after the new room-smoke script.
- Tuned the classroom economy so repeated alliance mining grows from 50C to 58C+, trusted betrayal spikes to 105C before event modifiers, wrong firewall attacks cost 45C, and marked traitors are hit at 1.8x for the next round.
- Added `scripts/verify-economy-balance.mjs` and `npm run verify:economy` to prove the balance through public WebSocket play with four human students.
- Captured failing-first economy evidence in `.omo/evidence/task-1-economy-failing-first.txt`, then passing evidence in `.omo/evidence/task-2-economy-passing.txt`.
- Added compact host controls for alliance bonus, trust mining bonus, firewall counter, and betrayal trust bonus in both lobby and live host settings.
- Updated student dock copy and the first-screen 3-round tutorial so cooperation growth, the late betrayal temptation, and punishment risk are visible with the current numbers.
- Extended `verify:room` to prove lobby and live-game economy settings broadcast to students while the host remains a non-playing monitor.
- Captured browser QA evidence for desktop/mobile host settings, student dock copy, settings JSON, and no console errors under `.omo/evidence/`.
- Passed final combined verification and independent ultrawork review for the economy-balance change.
- Added the five-action counterplay update: explicit 우회/breach, explicit 배신/betray, the cycle 배신 > 채굴 > 우회 > 방화벽 > 해킹 > 배신, and exact personal attacker visibility during settlement.

TODO:
- None.
