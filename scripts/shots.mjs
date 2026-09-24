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
  async trees() {
    await g(() => {
      __game.teleport(-17, 3, 2.4);
      __game.camera({ yaw: 2.6, zoom: 19 });
      __game.aim(-19, -2);
      __game.advance(0.8);
    });
    await shot('trees-backlit');
    await g(() => {
      __game.camera({ yaw: -0.4, zoom: 19 });
      __game.advance(0.4);
    });
    await shot('trees-front');
  },
  async audio() {
    await g(() => __game.audio.unlock());
    await page.waitForTimeout(800);
    console.log('audio state', JSON.stringify(await g(() => __game.audio.state())));
    // the soundtrack keeps its own clock: tick a few real frames so its volume fades in
    for (let i = 0; i < 20; i++) {
      await g(() => __game.advance(0.1, 10));
      await page.waitForTimeout(50);
    }
    console.log('soundtrack', JSON.stringify(await g(() => __game.audio.state().track)));
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
    // real-time loop: the first frames compile every shader (slow on SwiftShader)
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__game && window.__game.game.time > 2, null, { timeout: 180000, polling: 1000 });
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
  async limbs() {
    // localized reactions: a limp, a crawler (legs shot out) and a brute losing an arm
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-2, -3, 1.57);
      __game.spawn('shambler', 3, -1.4, true);
      __game.spawn('shambler', 3.4, -4.4, true);
      __game.spawn('brute', 5.4, -2.8, true);
      __game.camera({ yaw: -0.3, zoom: 13 });
      __game.aim(4, -3);
      __game.advance(0.3);
      __game.hit(0, 'legL', 1.1);
      __game.hit(1, 'legR', 2.2);
      __game.tearArm(2, 1);
      __game.advance(0.06);
    });
    await shot('limbs-1');
    await g(() => __game.advance(1.6));
    await shot('limbs-2');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(1.3));
    await shot('limbs-3');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async faces() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-9.6, 1.6, 0.4);
      __game.spawn('shambler', -11.2, 0.2);
      __game.spawn('runner', -9.6, -0.4);
      __game.spawn('brute', -7.8, 0.0);
      __game.freeze(true);
      __game.camera({ yaw: -0.2, zoom: 7 });
      __game.aim(-8.6, 6);
      __game.advance(0.6);
      for (const z of __game.game.zombies) z.yaw = -0.2;
      __game.express(0, 'zombieAttack', 3);
      __game.express(1, 'zombieHurt', 3);
      __game.express(2, 'zombieBlink', 3);
      __game.express(-1, 'playerBlink', 3);
      __game.advance(0.1);
    });
    await shot('faces');
  },
  async crawl() {
    // side view of a crawler and a limper coming at the player
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-3, -3, 1.57);
      __game.spawn('shambler', 2.2, -3.4, true);
      __game.spawn('runner', 3.2, -1.6, true);
      __game.camera({ yaw: -0.3, zoom: 10 });
      __game.aim(2, -3);
      __game.advance(0.2);
      __game.hit(0, 'legL', 2.2);
      __game.hit(1, 'legR', 0.8);
      __game.advance(2.4);
    });
    await shot('crawl-1');
    await g(() => __game.advance(0.25));
    await shot('crawl-2');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(1.2));
    await shot('crawl-3');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async crawlclose() {
    // frozen crawler seen from the side, close and low
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-4, -3, 1.57);
      __game.spawn('shambler', 1, -3.2, true);
      __game.camera({ yaw: -0.3, zoom: 10 });
      __game.aim(2, -3);
      __game.advance(0.2);
      __game.hit(0, 'legL', 2.2);
      __game.advance(3.2);
      __game.freeze(true);
      const z = __game.game.zombies[0];
      __game.teleport(z.pos.x - 0.6, z.pos.z + 2.2, 3.14);
      __game.camera({ yaw: 0.25, zoom: 5 });
      __game.aim(z.pos.x - 0.6, z.pos.z - 3);
      __game.advance(0.4);
    });
    await shot('crawlclose-1');
    await g(() => {
      __game.express(0, 'zombieAttack', 2);
      __game.game.zombies[0].frozen = false;
      __game.advance(0.25);
    });
    await shot('crawlclose-2');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async kick() {
    // boot a zombie off the bank: it flies, splashes and drowns
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-12.1, -13.1, -1.57);
      __game.spawn('shambler', -13.3, -13.1);
      __game.spawn('shambler', -11.6, -10.9);
      __game.freeze(true);
      __game.camera({ yaw: 2.2, zoom: 13 });
      __game.aim(-17, -13.1);
      __game.advance(0.5);
      __game.kick();
      __game.advance(0.05);
    });
    await shot('kick-1');
    await g(() => __game.advance(0.2));
    await shot('kick-2');
    await g(() => __game.advance(0.45));
    await shot('kick-3');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(2.5));
    await shot('kick-4');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async dynamite() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-3, -3, 1.57);
      __game.spawn('shambler', 4.2, -2.4);
      __game.spawn('runner', 5, -3.7);
      __game.spawn('shambler', 3.7, -4.3);
      __game.spawn('brute', 7.5, -1.2);
      __game.freeze(true);
      __game.camera({ yaw: -0.3, zoom: 17 });
      __game.advance(0.3);
      __game.holdThrow(4.3, -3.4);
      __game.advance(0.4);
    });
    await shot('dyn-1');
    await g(() => {
      __game.releaseThrow();
      __game.advance(0.35);
    });
    await shot('dyn-2');
    await g(() => __game.advance(1.53));
    await shot('dyn-3');
    await g(() => __game.advance(0.4));
    await shot('dyn-4');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async killcam() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-7.5, 0.5, 0);
      __game.spawn('shambler', -7.4, 3.3);
      __game.freeze(true);
      __game.camera({ yaw: -0.3, zoom: 17 });
      __game.aim(-7.4, 5, 0.9);
      __game.weapon('shotgun');
      __game.advance(0.6);
      __game.fire();
      __game.advance(0.2);
    });
    await shot('killcam-1');
    await g(() => __game.advance(0.6));
    await shot('killcam-2');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(2.5));
    await shot('killcam-3');
  },
  async truck() {
    // shoot the fuel cap until it catches fire, then it takes the zombies with it
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-2.7, 1.9, 1.57);
      __game.spawn('shambler', 2.6, 3.8);
      __game.spawn('runner', -0.6, 4.4);
      __game.spawn('shambler', 3.4, -0.6);
      __game.spawn('shambler', -2.4, -0.8);
      __game.freeze(true);
      __game.camera({ yaw: -0.3, zoom: 18 });
      __game.weapon('pistol');
      __game.advance(0.6);
      for (let i = 0; i < 5; i++) {
        __game.aim(-0.2, 1.69, 1.12);
        __game.fire();
        __game.advance(0.2);
      }
      __game.advance(0.4);
    });
    await shot('truck-1');
    await g(() => __game.advance(1.95));
    await shot('truck-2');
    await g(() => __game.advance(0.5));
    await shot('truck-3');
    console.log(JSON.stringify(await g(() => __game.state())));
    await g(() => __game.advance(3));
    await shot('truck-4');
  },
  async fences() {
    // zombies outside the yard: shamblers/runners climb the pickets, the brute smashes through
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(-6.4, 0.6, 0);
      __game.spawn('shambler', -5.2, 7.6, true);
      __game.spawn('runner', -6.6, 8.2, true);
      __game.spawn('brute', -4.6, 6.6, true);
      __game.spawn('crawler', -7.6, 6.4, true);
      __game.camera({ yaw: -0.2, zoom: 15 });
      __game.aim(-6.4, 5);
      __game.advance(1.3);
    });
    await shot('fences-1');
    console.log(JSON.stringify(await g(() => __game.state().zombies.map((z) => z.state))));
    await g(() => __game.advance(0.5));
    await shot('fences-2');
    console.log(JSON.stringify(await g(() => __game.state().zombies.map((z) => z.state))));
    await g(() => __game.advance(2.0));
    await shot('fences-3');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async barnhorde() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.teleport(10.5, 3.5, 3.1);
      __game.camera({ yaw: -0.25, zoom: 19 });
      __game.aim(13, -4);
      __game.advance(0.4);
      __game.wave(3);
      __game.advance(1.0);
    });
    await shot('barnhorde-1');
    await g(() => __game.advance(0.75));
    await shot('barnhorde-2');
    await g(() => __game.advance(1.4));
    await shot('barnhorde-3');
    console.log(JSON.stringify(await g(() => __game.state())));
  },
  async daycycle() {
    for (const [t, name] of [
      [1, 'sunset'],
      [2, 'night'],
      [3, 'dawn'],
    ]) {
      await g((tt) => {
        __game.godMode();
        __game.clearZombies();
        __game.teleport(-2.5, -2, 1.2);
        __game.spawn('shambler', 2.5, -3.2);
        __game.spawn('runner', 3.6, -0.8);
        __game.freeze(true);
        __game.day(tt);
        __game.camera({ yaw: -0.42, zoom: 18 });
        __game.aim(3, -2);
        __game.advance(1.2);
      }, t);
      await shot(`day-${name}`);
    }
  },
  async repair() {
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.breakFence(4);
      const s = __game.game.farm.fenceSegments[4];
      const n = s.normal;
      __game.teleport(s.center.x - n.x * 1.1, s.center.z - n.z * 1.1, 0);
      __game.camera({ yaw: -0.3, zoom: 12 });
      __game.aim(s.center.x, s.center.z);
      __game.advance(1.5);
    });
    await shot('repair-1');
    await g(() => {
      __game.key('KeyC', true);
      __game.advance(0.6);
    });
    await shot('repair-2');
    await g(() => {
      __game.advance(0.7);
      __game.release('KeyC');
      __game.advance(0.3);
    });
    await shot('repair-3');
    console.log(JSON.stringify(await g(() => __game.game.farm.fenceSegments[4].broken)));
  },
  async gamepad() {
    // twin-stick: walk with the left stick, aim with the right (assist snaps to the zombie), RT fires
    await g(() => {
      __game.godMode();
      __game.clearZombies();
      __game.clearAim();
      __game.teleport(-2, -3, 0);
      __game.spawn('shambler', 3.5, -2.2);
      __game.spawn('runner', 1.5, -6.5);
      __game.freeze(true);
      __game.camera({ yaw: -0.3, zoom: 15 });
      __game.weapon('pistol');
      __game.advance(0.4);
      // right stick: screen-right and a bit up
      __game.pad({ axes: [0.35, 0, 0.95, -0.15] });
      __game.advance(0.5);
    });
    await shot('gamepad-1');
    console.log(JSON.stringify(await g(() => ({ aim: __game.game.aimPoint, active: __game.game.pad.active }))));
    await g(() => {
      for (let i = 0; i < 4; i++) {
        __game.pad({ axes: [0, 0, 0.95, -0.15], buttons: [7] });
        __game.advance(0.05);
        __game.pad({ axes: [0, 0, 0.95, -0.15] });
        __game.advance(0.15);
      }
      __game.pad({ axes: [0, 0, 0, 0], buttons: [1] });
      __game.advance(0.05);
      __game.pad({ axes: [0, 0, 0, 0] });
      __game.advance(0.5);
    });
    await shot('gamepad-2');
    console.log(JSON.stringify(await g(() => ({ state: __game.state(), rumbles: __game.rumbles.length, first: __game.rumbles[0] }))));
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
    await page.goto(`http://localhost:${PORT}/?test`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 60000 });
  }
  await scenarios[name]();
  console.log(`${name}: ${Date.now() - t} ms`);
}
if (logs.length) console.log('--- browser logs ---\n' + logs.slice(0, 40).join('\n'));
await browser.close();
server.kill();
process.exit(0);
