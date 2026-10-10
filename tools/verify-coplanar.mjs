/**
 * Separating coinciding faces through inflate.
 *
 * Two cubes in one plane shimmer: the GPU cannot decide which face is
 * closer. Coordinates must not be shifted — a clean 5 in the panel would turn into
 * 4.99432. Instead, the smaller cube of the pair is slightly inflated through the inflate field.
 *
 * Rotated cubes are checked too: their from/to are local, and a bounding box
 * built from center ± size/2 does not match their real position.
 *
 * Run: node tools/verify-coplanar.mjs [folder with unpacked models]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCoplanar, cubeFaces, solveBox, splitComponents, parseGLTFFiles } =
	require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

/** An unrotated cube by its bounds. */
const box = (lo, hi) => ({
	center: [0, 1, 2].map(i => (lo[i] + hi[i]) / 2),
	size: [0, 1, 2].map(i => hi[i] - lo[i]),
	vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1],
});

/** A cube rotated about Y by deg. */
const turned = (lo, hi, deg) => {
	const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
	return Object.assign(box(lo, hi), { vx: [c, 0, -s], vy: [0, 1, 0], vz: [s, 0, c] });
};

/** A cube by centre and size, rotated about Y. */
const turnedAt = (center, size, deg) => {
	const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
	return { center, size, vx: [c, 0, -s], vy: [0, 1, 0], vz: [s, 0, c] };
};

/**
 * An overlay on the front face of a rotated cube.
 *
 * Every cube rotates about ITS OWN origin, so the same angle does not yet
 * mean a shared plane: for cubes with different centres the front faces
 * drift apart. For the faces to coincide, the overlay's centre has to be shifted
 * along the local axis by the difference of the half-sizes.
 */
const facingOverlay = (base, size, deg) => {
	const r = deg * Math.PI / 180, s = Math.sin(r), c = Math.cos(r);
	const shift = base.size[2] / 2 - size[2] / 2;
	return turnedAt(
		[base.center[0] + s * shift, base.center[1], base.center[2] + c * shift],
		size, deg);
};

console.log('\n=== Axis-aligned cubes ===');

let r = resolveCoplanar([box([0, 0, 0], [16, 16, 16]), box([2, 2, 2], [14, 14, 16])]);
ok(r.pairs === 1, `coinciding front faces — a conflict (pairs: ${r.pairs})`);
ok(r.inflate[0] === 0 && r.inflate[1] > 0,
	`the smaller cube is inflated, the big one is untouched (${r.inflate[0]}, ${r.inflate[1]})`);

r = resolveCoplanar([box([0, 0, 0], [16, 16, 16]), box([0, 16, 0], [16, 24, 16])]);
ok(r.pairs === 0, `cubes stacked on each other — no conflict (pairs: ${r.pairs})`);

r = resolveCoplanar([box([0, 0, 0], [8, 8, 8]), box([8, 0, 8], [16, 8, 16])]);
ok(r.pairs === 0, `touching along an edge — no conflict (pairs: ${r.pairs})`);

r = resolveCoplanar([box([0, 0, 0], [8, 8, 8]), box([40, 40, 40], [48, 48, 48])]);
ok(r.pairs === 0, 'cubes apart — no conflict');

console.log('\n=== Layers go to different depths ===');
r = resolveCoplanar([
	box([0, 0, 0], [16, 16, 16]),
	box([1, 1, 1], [15, 15, 16]),
	box([2, 2, 2], [14, 14, 16]),
]);
ok(r.inflate[0] === 0, `the base is not inflated (${r.inflate[0]})`);
ok(r.inflate[1] > r.inflate[0] && r.inflate[2] > r.inflate[1],
	`every layer deeper: ${r.inflate[0]} < ${r.inflate[1].toFixed(3)} < ${r.inflate[2].toFixed(3)}`);

console.log('\n=== Rotated cubes ===');

// Both rotated the same way and lying in one plane — there will be a shimmer.
const base30 = turnedAt([8, 8, 8], [16, 16, 16], 30);
r = resolveCoplanar([base30, facingOverlay(base30, [12, 12, 12], 30)]);
ok(r.pairs === 1, `an overlay on a rotated cube — a conflict (pairs: ${r.pairs})`);
ok(r.inflate[0] === 0 && r.inflate[1] > 0, 'the overlay is inflated, the base is untouched');

// Same angle, different centres: every cube rotates about its own
// origin, so the front faces drift apart and there is no shared plane.
r = resolveCoplanar([turned([0, 0, 0], [16, 16, 16], 30), turned([2, 2, 2], [14, 14, 16], 30)]);
ok(r.pairs === 0, `an offset cube at the same angle — different planes (pairs: ${r.pairs})`);

// Rotated differently: the face planes coincide even less.
r = resolveCoplanar([base30, facingOverlay(base30, [12, 12, 12], 31)]);
ok(r.pairs === 0, `a different angle — no conflict (pairs: ${r.pairs})`);

// A 90° rotation: the basis becomes a permutation of the axes. The bounding box used to be
// computed per component and was wrong exactly here.
const a90 = turned([0, 0, 0], [4, 16, 16], 90);
const b90 = turned([0, 0, 0], [4, 12, 12], 90);
r = resolveCoplanar([a90, b90]);
ok(r.pairs >= 1, `a 90° rotation — the match is found (pairs: ${r.pairs})`);

console.log('\n=== Faces are built in world coordinates ===');
const f = cubeFaces(turned([0, 0, 0], [16, 16, 16], 90));
const normals = f.map(x => x.n.map(v => Math.round(v)).join(','));
ok(normals.includes('1,0,0') || normals.includes('-1,0,0'), 'there is a face along world X');
ok(f.every(x => Math.abs(Math.hypot(...x.n) - 1) < 1e-9), 'all normals are unit length');
ok(f.length === 6, `exactly six faces (${f.length})`);

console.log('\n=== The safety valve on huge models ===');
const many = [];
for (let i = 0; i < 30; i++) many.push(box([0, 0, 0], [1, 1, 1]));
r = resolveCoplanar(many, 0.02, 10);
ok(r.skipped === 30 && r.pairs === 0, `over the limit, separation is skipped (skipped ${r.skipped})`);

const root = process.argv[2];
if (root && fs.existsSync(root)) {
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

	console.log('\n=== On real models (scale ×16) ===');
	console.log('  model                                 cubes   rotated   pairs  inflated  max');
	for (const dir of dirs) {
		let parsed;
		try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }
		const sols = [];
		for (const obj of parsed.objects) {
			for (const faces of splitComponents(obj.faces)) {
				const sol = solveBox(faces);
				if (!sol.error) sols.push(sol);
			}
		}
		if (!sols.length) continue;
		const rotated = sols.filter(s => ![s.vx, s.vy, s.vz].every(v =>
			v.filter(c => Math.abs(Math.abs(c) - 1) < 1e-6).length === 1)).length;
		const res = resolveCoplanar(sols);
		const touched = res.inflate.filter(v => v > 0).length;
		const max = res.inflate.reduce((x, y) => Math.max(x, y), 0);
		const label = path.relative(root, dir).replace(/[/\\]source$/, '');
		console.log(`  ${label.slice(0, 36).padEnd(38)} ${String(sols.length).padStart(5)} `
			+ `${String(rotated).padStart(11)} ${String(res.pairs).padStart(5)} `
			+ `${String(touched).padStart(8)} ${max.toFixed(3).padStart(6)}`);
		if (max > 0.125) { bad++; console.log('    FAIL: inflation exceeded half a grid step — it will show'); }
	}
}

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: COINCIDING FACES ARE SEPARATED\n');
process.exit(bad ? 1 : 0);
