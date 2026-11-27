import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./NodeCard.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

assert.match(source, /percent > 90 \? 'hot' : 'normal'/);
assert.doesNotMatch(source, /'warm'/);
assert.doesNotMatch(css, /\.lp-bar\[data-level='warm'\]/);
assert.doesNotMatch(css, /\.lp-metric-value\[data-load='warm'\]/);
assert.doesNotMatch(css, /\.lp-info-value\[data-tone='(green|yellow)'\]/);
