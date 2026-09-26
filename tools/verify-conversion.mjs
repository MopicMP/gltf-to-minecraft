/**
 * Runs the plugin core (solveBox) over a real OBJ, without starting Blockbench.
 * Imports the function from plugin/gltf_to_minecraft.js — not a copy.
 *
 * Run: node tools/verify-conversion.mjs model/model.obj
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox } = require('../plugin/gltf_to_minecraft.js');

const file = process.argv[2] ?? 'model/model.obj';
const TEX = 128;   // project texture size

// ------------------------------------------------------------- OBJ parsing

const positions = [], uvs = [], objects = [];
let current = null;
for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
	const line = raw.trim();
	if (!line || line[0] === '#') continue;
	const p = line.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(current = { name: p.slice(1).join(' '), faces: [] });
	else if (p[0] === 'f') {
		if (!current) objects.push(current = { name: '<unnamed>', faces: [] });
		const corners = p.slice(1).map(tok => {
			const [v, t] = tok.split('/');
			return { v: +v - 1, t: t ? +t - 1 : -1 };
		});
		current.faces.push({
			positions: corners.map(c => positions[c.v]),
			// in Blockbench UV are in texture pixels and the V axis points down, in OBJ — the other way
			uvs: corners.map(c => c.t < 0 ? null : [uvs[c.t][0] * TEX, (1 - uvs[c.t][1]) * TEX]),
		});
	}
}

// -------------------------------------------------------------- checks

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dist = (a, b) => Math.hypot(...sub(a, b));

let okSolve = 0, okShape = 0, totalViolations = 0, emptyFaces = 0, uvFaces = 0;
const problems = [], worstShape = [], flips = {};

for (const obj of objects) {
	const sol = solveBox(obj.faces);
	if (sol.error) { problems.push(`${obj.name}: ${sol.error}`); continue; }
	okSolve++;

	// --- is the shape restored exactly? ---
	// a cube is given as center ± size/2 with a rotation about center.
	// It is unfolded back into 8 corners and compared with the source vertices.
	const half = mul(sol.size, 0.5);
	const corners = [];
	for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
		corners.push(add(sol.center, add(add(
			mul(sol.vx, sx * half[0]),
			mul(sol.vy, sy * half[1])),
			mul(sol.vz, sz * half[2]))));
	}
	const uniq = new Map();
	for (const f of obj.faces) for (const p of f.positions) uniq.set(p.join(','), p);

	let worst = 0;
	for (const p of uniq.values()) worst = Math.max(worst, Math.min(...corners.map(c => dist(p, c))));
	const span = Math.max(...sol.size) || 1;
	worstShape.push(worst / span);
	if (worst <= span * 1e-5) okShape++;
	else problems.push(`${obj.name}: shape differs by ${worst.toExponential(2)}`);

	totalViolations += sol.violations;
	if (sol.violations) problems.push(`${obj.name}: ${sol.violations} UV mismatches`);
	emptyFaces += sol.emptyFaces.length;
	uvFaces += Object.keys(sol.faceUV).length;

	// An indirect check of the SIGNS in FACE_DIRS.
	// Blockbench reads a reversed rectangle (x1>x2) as a mirror. Occasionally
	// that is legitimate, but if almost all faces of some direction are reversed —
	// the sign in FACE_DIRS for it was chosen wrong.
	// Only barely rotated cubes are counted: for strongly rotated ones the choice of one
	// of the 24 bases is ambiguous (several give zero violations), and a mirror
	// there follows from the choice of basis, not from a mistake in FACE_DIRS.
	const trace = sol.vx[0] + sol.vy[1] + sol.vz[2];
	const angle = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180 / Math.PI;
	if (angle > 10) continue;

	for (const [name, uv] of Object.entries(sol.faceUV)) {
		const f = flips[name] ??= { u: 0, v: 0, total: 0 };
		f.total++;
		if (uv[0] > uv[2]) f.u++;
		if (uv[1] > uv[3]) f.v++;
	}
}

// --------------------------------------------------------------- report

const n = objects.length;
console.log(`\n=== CHECK OF THE CONVERTER CORE (${n} objects) ===\n`);
console.log(`Recognised as a box  : ${okSolve}/${n}`);
console.log(`Shape restored       : ${okShape}/${n} exactly`);
console.log(`Faces with UV        : ${uvFaces}`);
console.log(`Faces without source : ${emptyFaces} (will be hidden)`);
console.log(`UV needing rotation  : ${totalViolations}`);

if (worstShape.length) {
	worstShape.sort((a, b) => a - b);
	console.log(`\nWorst relative shape deviation: ${worstShape[worstShape.length - 1].toExponential(2)}`);
}

console.log(`\nMirrored UV per face (a high % = a wrong sign in FACE_DIRS):`);
for (const [name, f] of Object.entries(flips)) {
	const pu = ((f.u / f.total) * 100).toFixed(0), pv = ((f.v / f.total) * 100).toFixed(0);
	const flag = (f.u / f.total > 0.9 || f.v / f.total > 0.9) ? '  ← suspicious' : '';
	console.log(`  ${name.padEnd(6)} u:${pu.padStart(3)}%  v:${pv.padStart(3)}%  of ${f.total}${flag}`);
}

if (problems.length) {
	console.log(`\nProblems (${problems.length}):`);
	for (const p of problems.slice(0, 15)) console.log('  ' + p);
	if (problems.length > 15) console.log(`  …and ${problems.length - 15} more`);
}

const pass = okSolve === n && okShape === n && totalViolations === 0;
console.log(`\n${pass ? '✅ ALL CLEAN — lossless conversion' : '❌ THERE ARE PROBLEMS, see above'}\n`);
process.exit(pass ? 0 : 1);
