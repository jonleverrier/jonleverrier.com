// Asks what is behind WebGL, off the main thread — see probeOffMainThread() in hero.js
// for why. Answers once and is terminated.
import {probeTier} from './hero-tier.js';

postMessage(probeTier(new OffscreenCanvas(1, 1)));
