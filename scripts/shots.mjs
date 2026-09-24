// Visual QA: builds nothing, just serves the last build (`npm run build` first), drives the game
// through `window.__game` in deterministic test mode and saves screenshots into ./shots.
//
//   node scripts/shots.mjs overview combat explosion
//
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = 4179;
const OUT = process.env.SHOTS_DIR || 'shots';
const W = Number(process.env.SHOTS_W || 1280);
const H = Number(process.env.SHOTS_H || 720);
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 60000 });
console.log(`loaded in ${Date.now() - t0} ms`);

const g = (fn, ...args) => page.evaluate(fn, ...args);
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
};

const scenarios = {
  async audio() {
    await g(() => __game.audio.unlock());
    await page.waitForTimeout(800);
    console.log('audio state', JSON.stringify(await g(() => __game.audio.state())));
    const quiet = await g(() => __game.audio.level());
    await g(() => __game.audio.shots());
    await page.waitForTimeout(120);
    const loud = await g(() => __game.audio.level());
    console.log('level before/after shots', quiet.toFixed(4), loud.toFixed(4));
    await g(() => __game.audio.intensity(1));
    await page.waitForTimeout(6500);
    console.log('music after danger', JSON.stringify(await g(() => __game.audio.state())));
    await g(() => __game.audio.intensity(0));
    await g(() => __game.audio.stinger('clear'));
    await page.waitForTimeout(500);
    console.log('level with stinger', (await g(() => __game.audio.level())).toFixed(4));
  },
  async boom2() {
    // centered explosion with a survivor that gets knocked down and stands back up
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(3, 3, 0);
      __game.spawn('shambler', 3.4, -3.4);
      __game.spawn('runner', 1.2, -4.8);
      __game.spawn('brute', 6.6, -5.6);
      __game.freeze(true);
      __game.camera({ yaw: -0.2, zoom: 17 });
      __game.aim(3, -4);
      __game.advance(0.5);
      __game.explode(3, -4.4, 1);
      __game.advance(0.03);
    });
    await shot('boom2-1');
    await g(() => __game.advance(0.12));
    await shot('boom2-2');
    await g(() => __game.advance(0.35));
    await shot('boom2-3');
    await g(() => __game.advance(1.6));
    await shot('boom2-4');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(1.4));
    await shot('boom2-5');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async dodge() {
    await g(() => {
      __game.clearZombies();
      __game.teleport(-2, -3, 1.6);
      __game.camera({ yaw: -0.2, zoom: 12 });
      __game.aim(4, -3);
      __game.advance(0.4);
      __game.key('KeyD', true);
      __game.advance(0.2);
      __game.key('Space');
      __game.advance(0.1);
    });
    await shot('dodge-1');
    await g(() => __game.advance(0.1));
    await shot('dodge-2');
    await g(() => { __game.release('KeyD'); __game.advance(0.4); });
  },
  async death() {
    await g(() => {
      __game.clearZombies();
      __game.teleport(-2, -3, 1.6);
      __game.game.player.hp = 1;
      __game.spawn('brute', -0.8, -3, true);
      __game.camera({ yaw: -0.2, zoom: 14 });
      __game.aim(2, -3);
      __game.advance(2.0);
    });
    await shot('death-1');
    await g(() => __game.advance(1.2));
    await shot('death-2');
    await g(() => __game.advance(2.0));
    await shot('death-3');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async title() {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(6000);
    await shot('title');
  },
  async chase() {
    await g(() => {
      __game.clearZombies();
      __game.teleport(-2, -2, 1.5);
      __game.spawn('shambler', 4, -3, true);
      __game.spawn('runner', 5, 1, true);
      __game.camera({ yaw: -0.3, zoom: 17 });
      __game.aim(4, -2);
      __game.weapon('pistol');
      __game.advance(1.2);
    });
    await shot('chase-1');
    await g(() => __game.advance(1.0));
    await shot('chase-2');
    console.log(JSON.stringify(await g(() => __game.state())));
    // pistol volley at the runner
    for (let i = 0; i < 4; i++) {
      await g(() => {
        const z = __game.game.zombies.find((q) => q.alive);
        if (z) __game.aim(z.pos.x, z.pos.z, 0.9);
        __game.fire();
        __game.advance(0.16);
      });
    }
    await shot('chase-3');
    await g(() => __game.advance(1.5));
    await shot('chase-4');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async pick() {
    await g(() => {
      __game.freeze(true);
      __game.teleport(-7.5, 0.5, 0);
      __game.camera({ yaw: -0.3, zoom: 15 });
      __game.advance(0.6);
    });
    await shot('pick');
    await g(() => {
      __game.game.scene.traverse((o) => { if (o.isPointLight) { o.visible = false; } });
      __game.advance(0.05);
    });
    await shot('pick-nolights');
    for (const [x, y] of [[628, 514], [484, 367], [630, 516]]) {
      console.log(x, y, JSON.stringify(await g(([a, b]) => __game.pick(a, b), [x, y]), null, 0));
    }
  },
  async overview() {
    await g(() => __game.advance(1.0));
    await shot('overview-0');
    for (const [i, yaw] of [
      [1, 0.6],
      [2, 2.2],
      [3, -2.4],
    ]) {
      await g((y) => {
        __game.camera({ yaw: y });
        __game.advance(0.4);
      }, yaw);
      await shot(`overview-${i}`);
    }
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async wide() {
    await g(() => {
      __game.camera({ yaw: -0.42, zoom: 32 });
      __game.teleport(2, -4);
      __game.advance(0.6);
    });
    await shot('wide');
  },
  async barn() {
    await g(() => {
      __game.freeze(true);
      __game.teleport(8, 2, 2.5);
      __game.camera({ yaw: -0.3, zoom: 20 });
      __game.advance(0.8);
    });
    await shot('barn');
  },
  async pond() {
    await g(() => {
      __game.teleport(-17, -8, 3.5);
      __game.camera({ yaw: 0.8, zoom: 18 });
      __game.advance(0.8);
    });
    await shot('pond');
  },
  async closeup() {
    await g(() => {
      __game.freeze(true);
      __game.teleport(-9.6, 1.4, 0.4);
      __game.camera({ yaw: -0.2, zoom: 12 });
      __game.aim(-8, 5);
      __game.advance(0.8);
    });
    await shot('closeup');
  },
  async combat() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-7.5, 0.5, 0);
      __game.spawn('shambler', -7.5, 2.6);
      __game.spawn('shambler', -6.2, 2.9);
      __game.freeze(true);
      __game.camera({ yaw: -0.3, zoom: 15 });
      __game.aim(-7.4, 5, 0.9);
      __game.weapon('shotgun');
      __game.advance(0.6);
    });
    await shot('combat-0');
    await g(() => __game.fire());
    await g(() => __game.advance(0.02));
    await shot('combat-1');
    await g(() => __game.advance(0.1));
    await shot('combat-2');
    await g(() => __game.advance(0.2));
    await shot('combat-3');
    await g(() => __game.advance(0.5));
    await shot('combat-4');
    await g(() => __game.advance(1.5));
    await shot('combat-5');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async explosion() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(10.5, 1.5, 3.1);
      __game.spawn('shambler', 14.5, -3.8);
      __game.spawn('runner', 15.8, -4.4);
      __game.spawn('shambler', 16.2, -6.8);
      __game.freeze(true);
      __game.camera({ yaw: -0.25, zoom: 18 });
      __game.advance(0.5);
      __game.explode(15.2, -5.3, 1);
      __game.advance(0.05);
    });
    await shot('boom-1');
    await g(() => __game.advance(0.25));
    await shot('boom-2');
    await g(() => __game.advance(0.6));
    await shot('boom-3');
    await g(() => __game.advance(2.5));
    await shot('boom-4');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
};

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : ['overview']) {
  if (!scenarios[name]) {
    console.log('unknown scenario', name);
    continue;
  }
  const t = Date.now();
  if (name !== wanted[0]) {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 60000 });
  }
  await scenarios[name]();
  console.log(`${name}: ${Date.now() - t} ms`);
}
if (logs.length) console.log('--- browser logs ---\n' + logs.slice(0, 40).join('\n'));
await browser.close();
server.kill();
process.exit(0);
