/**
 * Installs the mutant segmenter. See not-a-partition.mjs.
 *
 * Separate from the hooks themselves because `register` loads them in another thread,
 * where this file's own top-level call must not run again.
 */
import {register} from 'node:module';

register('./not-a-partition.mjs', import.meta.url);
