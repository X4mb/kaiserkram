import type { Feature } from './feature.js';
import { landing } from '../features/landing/index.js';
import { party } from '../features/party/index.js';
import { earshot } from '../features/earshot/index.js';
import { trader } from '../features/trader/index.js';
import { containers } from '../features/containers/index.js';
import { grudges } from '../features/grudges/index.js';
import { travel } from '../features/travel/index.js';

/** Every feature, in the order the feature manager lists them. */
export const FEATURES: readonly Feature[] = [landing, travel, party, earshot, grudges, trader, containers];
