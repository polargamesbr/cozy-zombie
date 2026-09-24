import './style.css';
import { Game } from './game/Game';
import { installTestApi } from './debug/testApi';

const params = new URLSearchParams(location.search);
const test = params.has('test');
const seed = params.has('seed') ? Number(params.get('seed')) : test ? 12345 : undefined;

const low = params.has('low');

const game = new Game(document.getElementById('app')!, { test, seed, low });
installTestApi(game);
game.start();
