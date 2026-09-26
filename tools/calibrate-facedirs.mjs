/**
 * Brute-force calibration of FACE_DIRS.
 *
 * Only cubes with a near-zero rotation are taken — their basis is unambiguous
 * (the identity), so the faces are independent of each other and each one can
 * be calibrated on its own.
 *
 * For every face all 8 admissible (u, v) pairs are tried, and the one is chosen
 * that across the whole model gives neither violations (texture u not constant
 * along the v axis) nor mirrors (a reversed rectangle).
 *
 * Run: node tools/calibrate-facedirs.mjs model/model.obj
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectBox, orientations } = require('../plugin/gltf_to_minecraft.js');

const file = process.argv[2] ?? 'model/model.obj';
const TEX = 128;
const MAX_ANGLE = 10;   // degrees — above this the basis becomes ambiguous

const positions = [], uvs = [], objects = [];
let cur = null;
for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
	const l = raw.trim();
	if (!l || l[0] === '#') continue;
	const p = l.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(cur = { name: p.slice(1).join(' '), faces: [] });
	else if (p[0] === 'f') {
		const c = p.slice(1).map(t => { const [a, b] = t.split('/'); return { v: +a - 1, t: b ? +b - 1 : -1 }; });
		cur.faces.push({
			positions: c.map(x => positions[x.v]),
			uvs: c.map(x => x.t < 0 ? null : [uvs[x.t][0] * TEX, (1 - uvs[x.t][1]) * TEX]),
		});
	}
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const neg = a => [-a[0], -a[1], -a[2]];
const label = a => (a[0] ? (a[0] > 0 ? '+X' : '-X') : a[1] ? (a[1] > 0 ? '+Y' : '-Y') : (a[2] > 0 ? '+Z' : '-Z'));

const NORMALS = {
	north: [0, 0, -1], south: [0, 0, 1],
	east: [1, 0, 0], west: [-1, 0, 0],
	up: [0, 1, 0], down: [0, -1, 0],
};

/** All 8 admissible (u,v) pairs for a face: u along one axis of the plane, v along the other. */
function candidates(normal) {
	const inPlane = Object.values(AXES).filter(a => Math.abs(dot(a, normal)) < 0.5);
	const out = [];
	for (const a of inPlane) {
		const b = inPlane.find(x => x !== a);
		for (const su of [1, -1]) for (const sv of [1, -1]) {
			out.push({ u: su > 0 ? a : neg(a), v: sv > 0 ? b : neg(b) });
		}
	}
	return out;
}

// --- collect face samples from barely rotated cubes ---

const perFace = {};
for (const name in NORMALS) perFace[name] = [];
let used = 0;

for (const obj of objects) {
	const uniq = new Map();
	for (const f of obj.faces) for (const p of f.positions) uniq.set(p.map(n => n.toFixed(6)).join(','), p);
	const box = detectBox([...uniq.values()]);
	if (!box) continue;

	// the basis closest to the identity — for barely rotated cubes it is the right one
	const o = orientations(box.axes, box.size)[0];
	const angle = Math.acos(Math.min(1, Math.max(-1, (o.trace - 1) / 2))) * 180 / Math.PI;
	if (angle > MAX_ANGLE) continue;
	used++;

	const half = o.size.map(s => s / 2);
	const span = Math.max(...o.size) || 1;
	const tol = span * 1e-4;
	const toLocal = p => { const d = sub(p, box.center); return [dot(d, o.vx), dot(d, o.vy), dot(d, o.vz)]; };

	for (const f of obj.faces) {
		const locals = f.positions.map(toLocal);
		for (const name in NORMALS) {
			const n = NORMALS[name];
			const axis = n[0] ? 0 : n[1] ? 1 : 2;
			if (!locals.every(l => Math.abs(dot(l, n) - half[axis]) < tol)) continue;
			const samples = [];
			locals.forEach((pos, i) => { if (f.uvs[i]) samples.push({ pos, uv: f.uvs[i] }); });
			if (samples.length) perFace[name].push({ samples, span });
		}
	}
}

console.log(`\nCubes in the calibration: ${used} (rotation < ${MAX_ANGLE}°)\n`);

// --- brute force ---

function score(groups, u, v) {
	let violations = 0, flips = 0;
	for (const { samples, span } of groups) {
		const tol = span * 1e-4;
		for (let i = 0; i < samples.length; i++) {
			for (let j = i + 1; j < samples.length; j++) {
				const d = sub(samples[i].pos, samples[j].pos);
				if (Math.abs(dot(d, u)) < tol && Math.abs(samples[i].uv[0] - samples[j].uv[0]) > 1e-3) violations++;
				if (Math.abs(dot(d, v)) < tol && Math.abs(samples[i].uv[1] - samples[j].uv[1]) > 1e-3) violations++;
			}
		}
		const pick = (axis, wantMax) => {
			let best = samples[0], bestP = dot(best.pos, axis);
			for (const s of samples) {
				const p = dot(s.pos, axis);
				if (wantMax ? p > bestP : p < bestP) { best = s; bestP = p; }
			}
			return best;
		};
		if (pick(u, false).uv[0] > pick(u, true).uv[0]) flips++;
		if (pick(v, false).uv[1] > pick(v, true).uv[1]) flips++;
	}
	return { violations, flips };
}

console.log('face    best variant        violations mirrors     (all variants)');
const result = {};
for (const name in NORMALS) {
	const groups = perFace[name];
	const scored = candidates(NORMALS[name])
		.map(c => ({ ...c, ...score(groups, c.u, c.v) }))
		.sort((a, b) => (a.violations - b.violations) || (a.flips - b.flips));
	const best = scored[0];
	result[name] = best;
	const alt = scored.slice(1, 4).map(s => `${label(s.u)}/${label(s.v)}:${s.violations}v${s.flips}m`).join(' ');
	console.log(`${name.padEnd(7)} u=${label(best.u)} v=${label(best.v)}   ${String(best.violations).padStart(6)}  ${String(best.flips).padStart(9)}   ${alt}`);
}

console.log(`\nReady table for FACE_DIRS:\n`);
for (const name in result) {
	const r = result[name];
	console.log(`\t${(name + ':').padEnd(7)}{ normal: [${NORMALS[name]}], u: [${r.u}], v: [${r.v}] },`);
}
console.log('');
