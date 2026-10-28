// video.js 8's .d.ts files lack "type": "module", so under NodeNext a default import is the whole module.
// `.default` on a namespace import gives the class under both NodeNext and Bundler.
import type * as ButtonModule from 'video.js/dist/types/button.js';
import type * as PlayerModule from 'video.js/dist/types/player.js';
import type * as TechModule from 'video.js/dist/types/tech/tech.js';

export type Player = PlayerModule.default;
export type Tech = TechModule.default;
// `typeof ButtonModule.default` would be the whole module under NodeNext.
export type ButtonClass = new (player: Player, options?: object) => ButtonModule.default;
