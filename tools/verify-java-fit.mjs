/**
 * Java block/item models: the box they must fit, and the Minecraft they need.
 *
 * Every element's from/to must lie within −16…32 on each axis, and Blockbench
 * enforces it. The import places a still model there and shrinks it only when it
 * is larger than the box. Which Minecraft can show its cube rotations follows
 * Blockbench's three Java rotation formats.
 *
 * Run: node tools/verify-java-fit.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fitJavaBox, applyFit, javaFormatFor, versionBelow, JAVA_BOX } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** Bounds of the boxes after the fit, inflate included, as Blockbench tests them. */
function boundsAfter(boxes, fit) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const b of boxes) {
		const c = applyFit(b.center, fit);
		for (let a = 0; a < 3; a++) {
			const half = Math.abs(b.size[a]) * fit.k / 2 + (b.inflate || 0) * fit.k;
			lo[a] = Math.min(lo[a], c[a] - half);
			hi[a] = Math.max(hi[a], c[a] + half);
		}
	}
	return { lo, hi };
}
const inside = ({ lo, hi }) => lo.every(v => v >= JAVA_BOX[0] - 1e-9) && hi.every(v => v <= JAVA_BOX[1] + 1e-9);
const box = (center, size, inflate = 0) => ({ center, size, inflate });

console.log('\n=== Placing a model that fits ===');
{
	// Centred by the import already: X and Z around zero, the bottom on the ground.
	const boxes = [box([0, 10, 0], [10, 20, 6])];
	const fit = fitJavaBox(boxes, true);
	const b = boundsAfter(boxes, fit);
	ok(fit.k === 1, 'not shrunk');
	ok(near(b.lo[0], 3) && near(b.hi[0], 13) && near(b.lo[2], 5) && near(b.hi[2], 11),
		'X and Z centred on the block (8)');
	ok(near(b.lo[1], 0), 'the bottom on the block\'s floor');
	ok(fit.shift.every(v => Number.isInteger(v)), 'moved by whole pixels, so a model on its grid stays on it');
}
{
	// Off-grid position: the move still happens in whole pixels.
	const boxes = [box([0.37, 5.25, -0.4], [4, 10.5, 4])];
	const fit = fitJavaBox(boxes, true);
	ok(fit.shift.every(v => Number.isInteger(v)), 'an off-centre model is also moved by whole pixels');
	ok(inside(boundsAfter(boxes, fit)), '...and ends up inside the box');
}

console.log('\n=== Pushed back inside, not shrunk ===');
{
	// 40 px tall stood on the floor reaches 40, past the ceiling of 32.
	const boxes = [box([0, 20, 0], [8, 40, 8])];
	const fit = fitJavaBox(boxes, true);
	const b = boundsAfter(boxes, fit);
	ok(fit.k === 1, 'a 40 px tall model is not shrunk: it fits the 48 px box');
	ok(near(b.hi[1], 32) && near(b.lo[1], -8), 'it is lowered until its top is at 32');
}
{
	// Without placing, the model keeps its position as far as the box allows.
	const boxes = [box([105, 4, 0], [10, 8, 10])];
	const fit = fitJavaBox(boxes, false);
	const b = boundsAfter(boxes, fit);
	ok(near(b.hi[0], 32) && near(b.lo[1], 0), 'without centring it only moves as far as it must');
}
{
	// Inflate is baked into from/to on export, so it counts towards the box.
	const boxes = [box([0, 16, 0], [8, 32, 8], 0.5)];
	const fit = fitJavaBox(boxes, true);
	const b = boundsAfter(boxes, fit);
	ok(inside(b), 'inflate is counted: a 32 px model with 0.5 inflate still ends inside');
	ok(near(b.hi[1], 32), '...its inflated top lands exactly on 32');
}

console.log('\n=== Shrunk only when larger than the box ===');
{
	const boxes = [box([0, 20, 0], [96, 40, 10]), box([30, 5, 0], [4, 10, 4])];
	const fit = fitJavaBox(boxes, true);
	const b = boundsAfter(boxes, fit);
	ok(fit.k < 1 && fit.k > 0.49, `a 96 px wide model is shrunk ×${fit.k.toFixed(3)}`);
	ok(inside(b), '...and fits entirely');
	ok(b.hi[0] - b.lo[0] < 48 && b.hi[0] - b.lo[0] > 47.9, '...filling the box along its longest side');
}
{
	// A turned cube's from/to are its UNturned box: a 60 px stick at 45° has
	// corners within about 43 px, but its from/to span 60 and must fit.
	const boxes = [box([0, 0, 0], [60, 2, 2])];
	const fit = fitJavaBox(boxes, true);
	ok(fit.k < 1, 'bounds come from from/to, not from the turned corners');
}
ok(fitJavaBox([], true).k === 1, 'an empty model does not crash the fit');

console.log('\n=== The Minecraft a model needs ===');
const need = r => javaFormatFor(r).version;
ok(need([[0, 0, 0]]) === '1.9.0', 'no rotation: any version');
ok(need([[0, 22.5, 0], [0, 0, -45]]) === '1.9.0', 'one axis in 22.5° steps within ±45°: any version');
ok(need([[0, 30, 0]]) === '1.21.6', 'one axis, 30°: 1.21.6');
ok(need([[0, 30, 0], [10, 10, 0]]) === '1.21.11', 'two axes: 1.21.11');
ok(need([[0, 90, 0]]) === '1.21.11', 'one axis past 45°: 1.21.11');
{
	const c = javaFormatFor([[0, 0, 0], [0, 30, 0], [10, 10, 0], [0, 90, 0]]).counts;
	ok(c[0] === 1 && c[1] === 1 && c[2] === 2, `cubes counted by what they need: ${c.join(', ')}`);
}
ok(need([[0, 1e-9, 0]]) === '1.9.0', 'float noise is not a rotation');

console.log('\n=== Comparing versions ===');
ok(versionBelow('1.21.6', '1.21.11'), '1.21.6 is below 1.21.11 (not a string comparison)');
ok(versionBelow('1.9.0', '1.21.6'), '1.9.0 is below 1.21.6');
ok(!versionBelow('26.3', '1.21.11'), '26.3 is not below 1.21.11');
ok(!versionBelow('1.21.11', '1.21.11'), 'equal is not below');

console.log(`\n${bad ? `❌ FAILED: ${bad}` : '✅ ALL CORRECT'}\n`);
process.exit(bad ? 1 : 0);
