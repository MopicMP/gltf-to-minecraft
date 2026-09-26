/**
 * The export wrapper: what to keep and what to throw away.
 *
 * Eight models from the journal were marked "needs a -90° rotation". The cause
 * turned out to be one: the Sketchfab service wrapper holds TWO different things —
 * the axis conversion (Z-up → Y-up, a rotation that is a multiple of 90°) and the
 * model's placement in the showcase (an arbitrary rotation and offset). Both were
 * thrown away, and the model arrived lying down.
 *
 * Run: node tools/verify-wrapper.mjs [folder with unpacked archives]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { axisRotationOf, parseGLTFFiles } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

// ------------------------------------------------- recognising the rotation

console.log('\n=== An axis rotation differs from an arbitrary one ===');

const q90x = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
ok(axisRotationOf({ rotation: q90x }), '90° about X — axis-aligned (Z-up → Y-up conversion)');
ok(axisRotationOf({ rotation: [0, 0, 0, 1] }), 'zero rotation — axis-aligned');
ok(axisRotationOf({ rotation: [0, 1, 0, 0] }), '180° about Y — axis-aligned');
ok(!axisRotationOf({ rotation: [0.1366, 0.603, 0.7666, -0.1736] }),
	'160° about a skewed axis — arbitrary (showcase placement)');
ok(!axisRotationOf({ rotation: [0.3827, 0, 0, 0.9239] }), '45° about X — arbitrary');
ok(!axisRotationOf({}), 'a node without rotation — nothing to keep');

// the Sketchfab-12.67 matrix: X→X, Y→-Z, Z→Y, i.e. -90° about X
const mSketchfab = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
ok(axisRotationOf({ matrix: mSketchfab }), 'a -90° matrix about X — axis-aligned');

// a degenerate matrix: two axes collapsed into one — this is not a rotation
const mBroken = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
ok(!axisRotationOf({ matrix: mBroken }), 'collapsed axes — not a rotation');

// the wrapper offset must not leak into the result
const withShift = axisRotationOf({ rotation: q90x, translation: [6.3, -3.7, -62.4] });
ok(withShift && withShift.matrix[12] === 0 && withShift.matrix[13] === 0 && withShift.matrix[14] === 0,
	'wrapper offset dropped, only the rotation kept');

// ------------------------------------------------- on real archives

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
	console.log('\n(no folder with unpacked archives given — the check on real models is skipped)');
	console.log(bad ? `\n❌ ERRORS: ${bad}\n` : '\n✅ WRAPPER PARSING IS CORRECT\n');
	process.exit(bad ? 1 : 0);
}

/** Model bounds per axis: a standing figure is taller than it is wide or deep. */
function extent(objects) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const o of objects) {
		for (const f of o.faces) {
			for (const p of f.positions) {
				for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
			}
		}
	}
	return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

const readDir = dir => {
	const files = {};
	const walk = (d, prefix) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, prefix + e.name + '/');
			else files[prefix + e.name] = new Uint8Array(fs.readFileSync(p));
		}
	};
	walk(dir, '');
	return files;
};

console.log('\n=== Bounds of real models (W × H × D) ===');
for (const name of fs.readdirSync(root)) {
	const dir = path.join(root, name);
	if (!fs.statSync(dir).isDirectory()) continue;
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 1, uvWidth: 1, uvHeight: 1 }); }
	catch (e) { console.log(`  ${name}: could not be parsed — ${e.message}`); continue; }

	const [w, h, d] = extent(parsed.objects).map(v => +v.toFixed(2));
	const wrapWarn = parsed.warnings.filter(x => x.indexOf('wrapper') >= 0);
	console.log(`  ${name.padEnd(16)} ${String(w).padStart(7)} × ${String(h).padStart(7)} × ${String(d).padStart(7)}`
		+ `   ${h >= Math.max(w, d) ? 'standing' : 'lying or wide'}`);
	for (const x of wrapWarn) console.log(`      ${x}`);
}

console.log(bad ? `\n❌ ERRORS: ${bad}\n` : '\n✅ WRAPPER PARSING IS CORRECT\n');
process.exit(bad ? 1 : 0);
