/**
 * Snapping coordinates to the 0.25 px grid: how much it distorts the model.
 *
 * Numbers like -4.3979 are awkward in the editor, but rounding changes the geometry.
 * The cost is measured here — and measured IN WORLD COORDINATES.
 *
 * The first version of the test measured the shift of from/to, i.e. in the cube's
 * local frame, and showed a harmless 0.125 px. But a vertex of a rotated cube sits
 * at origin + R·(p − origin): an origin snapped separately from from/to
 * carried vertices up to 0.46 px away, and rectangular details turned skewed.
 * The test did not see it, while the user saw it at once.
 *
 * Run: node tools/verify-snap.mjs [folder with unpacked models]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { snapGrid, snapVec, snapAngle, isIdentityBasis, snapSafely, placeCoords,
	solveBox, splitComponents, parseGLTFFiles } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

console.log('\n=== The snapping itself ===');
ok(snapGrid(-4.3979) === -4.5, `-4.3979 → ${snapGrid(-4.3979)}`);
ok(snapGrid(0.0005) === 0, `0.0005 → ${snapGrid(0.0005)}`);
ok(snapGrid(7.5312) === 7.5, `7.5312 → ${snapGrid(7.5312)}`);
ok(!Object.is(snapGrid(-0.001), -0), 'no negative zero appears');
ok(snapAngle(22.4998) === 22.5, `angle 22.4998° → ${snapAngle(22.4998)}°`);
ok(snapVec([1.1, 2.2, 3.3]).join(',') === '1,2.25,3.25', `vector: ${snapVec([1.1, 2.2, 3.3]).join(',')}`);

console.log('\n=== What may be snapped ===');
const I = { vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1] };
ok(isIdentityBasis(I), 'a cube without rotation — snapped');
ok(!isIdentityBasis({ vx: [0, 0, 1], vy: [0, 1, 0], vz: [-1, 0, 0] }),
	'a 90° rotation — the basis is axis-aligned but not identity: not snapped');
ok(!isIdentityBasis({ vx: [0.87, 0, -0.5], vy: [0, 1, 0], vz: [0.5, 0, 0.87] }),
	'a 30° rotation — not snapped');

console.log('\n=== Snapping must not break small details ===');
const solOf = (center, size, basis) => Object.assign(
	{ center, size }, basis || { vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1] });

ok(snapSafely(solOf([8, 8, 8], [6, 7.5, 5])), 'a large cube on the grid — snapped');
ok(!snapSafely(solOf([3.3, 5.1, 2.05], [0.6, 0.7, 0.001])),
	'a pupil 0.6×0.7×0.001 — NOT snapped: it would grow by a quarter and lose its thickness');
ok(!snapSafely(solOf([3, 5, 2], [5, 0.001, 2])),
	'a thin overlay — not snapped: its thickness would collapse to zero');
ok(snapSafely(solOf([4.00001, 8, 8], [6, 8, 4])), 'floating-point noise — cleaned by snapping');
ok(!snapSafely(solOf([8, 8, 8], [6, 7.5, 5], { vx: [0.87, 0, -0.5], vy: [0, 1, 0], vz: [0.5, 0, 0.87] })),
	'a rotated cube — never snapped');

/** The eight cube vertices in the WORLD: origin + R·(vertex − origin). */
const corners = (from, to, origin, basis) => {
	const out = [];
	for (const x of [from[0], to[0]]) {
		for (const y of [from[1], to[1]]) {
			for (const z of [from[2], to[2]]) {
				const d = [x - origin[0], y - origin[1], z - origin[2]];
				out.push([0, 1, 2].map(k =>
					origin[k] + basis[0][k] * d[0] + basis[1][k] * d[1] + basis[2][k] * d[2]));
			}
		}
	}
	return out;
};

// Coordinate placement is taken from the plugin itself, not repeated here.
// A copy of the logic would mean the test checks itself: if it diverged
// from the plugin, the test would not notice.
const placeOf = placeCoords;

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
	console.log('\n(no model folder given — the cost of snapping was not measured)');
	console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: GRID SNAPPING WORKS\n');
	process.exit(bad ? 1 : 0);
}

const readDir = dir => {
	const files = {};
	const walk = (d, p) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const q = path.join(d, e.name);
			if (e.isDirectory()) walk(q, p + e.name + '/');
			else files[p + e.name] = new Uint8Array(fs.readFileSync(q));
		}
	};
	walk(dir, '');
	return files;
};

const dirs = [];
const collect = d => {
	const es = fs.readdirSync(d, { withFileTypes: true });
	if (es.some(e => e.isFile())) { dirs.push(d); return; }
	for (const e of es) if (e.isDirectory()) collect(path.join(d, e.name));
};
collect(root);

console.log('\n=== Vertex shift in the world (scale ×16) ===');
console.log('  model                                 cubes  straight skewed  max shift');
let worst = 0, worstLabel = '';
for (const dir of dirs) {
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }

	let cubes = 0, upright = 0, turned = 0, maxShift = 0;
	// Symmetric details (two eyes, two arms) have the same size.
	// If one snaps and the other does not, the model becomes asymmetric —
	// that is exactly how one pupil went missing while snapping depended on rotation.
	const byShape = new Map();
	let distorted = 0;
	for (const obj of parsed.objects) {
		for (const faces of splitComponents(obj.faces)) {
			const sol = solveBox(faces);
			if (sol.error) continue;
			cubes++;
			const basis = [sol.vx, sol.vy, sol.vz];
			if (isIdentityBasis(sol)) upright++; else turned++;

			const half = sol.size.map(v => Math.abs(v) / 2);
			const from = sol.center.map((c, i) => c - half[i]);
			const to = sol.center.map((c, i) => c + half[i]);
			const place = placeOf(sol);

			const before = corners(from, to, sol.center, basis);
			const after = corners(place(from), place(to), place(sol.center), basis);
			for (let i = 0; i < before.length; i++) {
				maxShift = Math.max(maxShift, Math.hypot(
					after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]));
			}

			// Size before and after. The threshold is absolute: the plugin promises to move
			// a coordinate no further than SNAP_TOLERANCE (0.02), so a size may
			// change by at most two such moves. Percentages do not work here:
			// for a detail 0.001 thick any wobble is hundreds of percent,
			// though the eye cannot see it.
			const LIMIT = 0.041;
			const sizeBefore = sol.size.map(v => Math.abs(v));
			const placedFrom = place(from), placedTo = place(to);
			const sizeAfter = [0, 1, 2].map(i => Math.abs(placedTo[i] - placedFrom[i]));
			for (let i = 0; i < 3; i++) {
				if (Math.abs(sizeAfter[i] - sizeBefore[i]) > LIMIT) distorted++;
			}
			// Symmetric details must stay identical to within
			// the same amount: if one drifted and the other did not, it shows.
			const key = sizeBefore.map(v => v.toFixed(4)).join(",");
			if (!byShape.has(key)) byShape.set(key, []);
			byShape.get(key).push(sizeAfter);
		}
	}
	const asym = [...byShape.values()].filter(list => {
		for (let i = 1; i < list.length; i++) {
			for (let k = 0; k < 3; k++) {
				if (Math.abs(list[i][k] - list[0][k]) > 0.041) return true;
			}
		}
		return false;
	}).length;
	if (asym) { bad++; console.log(`  FAIL: identical details diverged in size: ${asym} groups`); }
	if (distorted) { bad++; console.log(`  FAIL: the shape drifted on ${distorted} axes`); }
	if (!cubes) continue;
	const label = path.relative(root, dir).replace(/[/\\]source$/, '');
	if (maxShift > worst) { worst = maxShift; worstLabel = label; }
	console.log(`  ${label.slice(0, 36).padEnd(38)} ${String(cubes).padStart(5)} `
		+ `${String(upright).padStart(7)} ${String(turned).padStart(6)} ${maxShift.toFixed(4).padStart(12)}`);
}

console.log('');
// Half a grid step along each axis gives 0.125·√3 ≈ 0.2165 in space.
ok(worst <= 0.2166, `vertices nowhere moved further than half a grid step `
	+ `(maximum ${worst.toFixed(4)} px${worstLabel ? ', ' + worstLabel : ''})`);

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: GRID SNAPPING WORKS\n');
process.exit(bad ? 1 : 0);
