/**
 * Coinciding faces (z-fighting): where cubes lie in one plane.
 *
 * The GPU cannot decide which of two coinciding faces is closer, and the model
 * shimmers. The tool counts how many such places there are and of what kind —
 * the cure depends on it.
 *
 * Run: node tools/analyze-zfight.mjs <folder with unpacked models>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGLTFFiles, solveBox, splitComponents, snapVec } = require('../plugin/gltf_to_minecraft.js');

const root = process.argv[2];
if (!root) { console.log('Specify a folder with unpacked models'); process.exit(1); }

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

const EPS = 1e-6;
const AXES = ['X', 'Y', 'Z'];

console.log('');
for (const dir of dirs) {
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }

	// Only axis-aligned cubes are taken: rotated ones rarely share a plane,
	// and comparing them would take a completely different approach.
	const boxes = [];
	for (const obj of parsed.objects) {
		for (const faces of splitComponents(obj.faces)) {
			const sol = solveBox(faces);
			if (sol.error) continue;
			const axisAligned = [sol.vx, sol.vy, sol.vz].every(v =>
				v.filter(c => Math.abs(Math.abs(c) - 1) < 1e-6).length === 1
				&& v.filter(c => Math.abs(c) < 1e-6).length === 2);
			if (!axisAligned) continue;
			const half = sol.size.map(v => Math.abs(v) / 2);
			boxes.push({
				name: obj.name,
				lo: snapVec(sol.center.map((c, i) => c - half[i])),
				hi: snapVec(sol.center.map((c, i) => c + half[i])),
				vol: half.reduce((a, b) => a * 2 * b, 1),
			});
		}
	}

	// A pair of faces conflicts if they lie in one plane and their projections
	// overlap by area (touching along an edge is harmless).
	let sameSide = 0, backToBack = 0, covered = 0, partial = 0;
	const examples = [];
	const overlap = (a, b, skip) => {
		for (let i = 0; i < 3; i++) {
			if (i === skip) continue;
			const lo = Math.max(a.lo[i], b.lo[i]);
			const hi = Math.min(a.hi[i], b.hi[i]);
			if (hi - lo <= EPS) return 0;
		}
		let area = 1;
		for (let i = 0; i < 3; i++) {
			if (i === skip) continue;
			area *= Math.min(a.hi[i], b.hi[i]) - Math.max(a.lo[i], b.lo[i]);
		}
		return area;
	};

	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i], b = boxes[j];
			for (let ax = 0; ax < 3; ax++) {
				const area = overlap(a, b, ax);
				if (!area) continue;
				// same side: both faces look outward in the same direction — the shimmer is visible
				const sameLo = Math.abs(a.lo[ax] - b.lo[ax]) < EPS;
				const sameHi = Math.abs(a.hi[ax] - b.hi[ax]) < EPS;
				// back to back: the end of one coincides with the start of the other
				const touch = Math.abs(a.hi[ax] - b.lo[ax]) < EPS || Math.abs(b.hi[ax] - a.lo[ax]) < EPS;
				if (sameLo || sameHi) {
					sameSide++;
					// Whether one cube is nested inside another ENTIRELY, along all three axes.
					// Only then are its faces really invisible and can
					// be left undrawn. With merely coplanar faces neither one
					// covers the other — they are at the same depth, hence the shimmer.
					const within = (x, y) => {
						for (let i = 0; i < 3; i++) {
							if (x.lo[i] < y.lo[i] - EPS || x.hi[i] > y.hi[i] + EPS) return false;
						}
						return true;
					};
					const nested = within(a, b) || within(b, a);
					if (nested) covered++;
					else partial++;
					if (examples.length < 3) {
						examples.push(`${a.name} / ${b.name} — shared plane along ${AXES[ax]}`
							+ `, area ${area.toFixed(2)} px²`
							+ (nested ? ' — one cube nested entirely inside the other' : ' — the cubes are merely coplanar'));
					}
				} else if (touch) {
					backToBack++;
				}
			}
		}
	}

	if (!boxes.length) continue;
	const label = path.relative(root, dir).replace(/[/\\]source$/, '');
	console.log(`### ${label}`);
	console.log(`    axis-aligned cubes ${boxes.length} · coinciding faces "same side" ${sameSide}`
		+ ` · "back to back" joints ${backToBack}`);
	if (sameSide) console.log(`      of the coinciding: one cube nested in another ${covered}, merely coplanar ${partial}`);
	for (const e of examples) console.log(`      ${e}`);
}
console.log('');
