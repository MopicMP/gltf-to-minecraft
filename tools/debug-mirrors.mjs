/**
 * Diagnostics of mirrored UV: where they are and how they are distributed.
 * Run: node tools/debug-mirrors.mjs model/model.obj
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox } = require('../plugin/gltf_to_minecraft.js');

const file = process.argv[2] ?? 'model/model.obj';
const TEX = 128;

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
		const corners = p.slice(1).map(tok => {
			const [v, t] = tok.split('/');
			return { v: +v - 1, t: t ? +t - 1 : -1 };
		});
		current.faces.push({
			positions: corners.map(c => positions[c.v]),
			uvs: corners.map(c => c.t < 0 ? null : [uvs[c.t][0] * TEX, (1 - uvs[c.t][1]) * TEX]),
		});
	}
}

const rows = [];
for (const obj of objects) {
	const sol = solveBox(obj.faces);
	if (sol.error) continue;
	const entries = Object.entries(sol.faceUV);
	const flippedU = entries.filter(([, uv]) => uv[0] > uv[2]).map(([n]) => n);
	const flippedV = entries.filter(([, uv]) => uv[1] > uv[3]).map(([n]) => n);
	rows.push({
		name: obj.name,
		center: sol.center.map(v => +(v * 16).toFixed(2)),   // in pixels
		faces: entries.length,
		flippedU, flippedV,
		uv: sol.faceUV,
		size: sol.size.map(v => +(v * 16).toFixed(2)),
	});
}

// --- distribution by the number of mirrored faces per cube ---
// IMPORTANT: count BOTH horizontal AND vertical. The first version looked at u only
// and so never showed v mirrors (e.g. on cube_107) — time lost.
const flipCount = r => new Set([...r.flippedU, ...r.flippedV]).size;
const hist = new Map();
for (const r of rows) hist.set(flipCount(r), (hist.get(flipCount(r)) ?? 0) + 1);
console.log(`\n=== Mirrored faces (u or v) per cube ===`);
for (const [k, v] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  ${k} faces: ${v} cubes`);
}
console.log(`\n  u only: ${rows.reduce((s, r) => s + r.flippedU.length, 0)} faces`);
console.log(`  v only: ${rows.reduce((s, r) => s + r.flippedV.length, 0)} faces`);

const dirty = rows.filter(r => flipCount(r));
console.log(`\nCubes with a mirror in total: ${dirty.length} of ${rows.length}`);

// --- are the cubes mirrored as a whole? ---
const whole = dirty.filter(r => r.flippedU.length === r.faces);
console.log(`Mirrored ENTIRELY (all faces): ${whole.length}`);
console.log(`Mirrored PARTLY              : ${dirty.length - whole.length}`);

// --- where they are ---
if (dirty.length) {
	const ys = dirty.map(r => r.center[1]);
	const xs = dirty.map(r => r.center[0]);
	console.log(`\nPosition of mirrored cubes (pixels):`);
	console.log(`  Y (height): ${Math.min(...ys).toFixed(1)} … ${Math.max(...ys).toFixed(1)}`);
	console.log(`  X (left/right): ${Math.min(...xs).toFixed(1)} … ${Math.max(...xs).toFixed(1)}`);
	console.log(`  of them X<0: ${xs.filter(x => x < -0.01).length}, X>0: ${xs.filter(x => x > 0.01).length}, X≈0: ${xs.filter(x => Math.abs(x) <= 0.01).length}`);
}

const allY = rows.map(r => r.center[1]);
console.log(`\nFor comparison, the whole model along Y: ${Math.min(...allY).toFixed(1)} … ${Math.max(...allY).toFixed(1)}`);

// --- does a mirrored cube have an unmirrored twin opposite along X? ---
console.log(`\n=== Looking for mirror pairs ===`);
let paired = 0;
for (const r of dirty) {
	const twin = rows.find(o => o !== r
		&& Math.abs(o.center[0] + r.center[0]) < 0.05
		&& Math.abs(o.center[1] - r.center[1]) < 0.05
		&& Math.abs(o.center[2] - r.center[2]) < 0.05);
	const mark = twin ? (twin.flippedU.length ? 'twin is mirrored TOO' : `twin ${twin.name} is clean`) : 'no twin';
	if (twin && !twin.flippedU.length) paired++;
	console.log(`  ${r.name.padEnd(10)} centre=[${r.center.join(', ')}] mirrored:${r.flippedU.length}/6  → ${mark}`);
}
console.log(`\nMirrored cubes with a clean mirror twin: ${paired} of ${dirty.length}`);

// --- do the twins use the same texture areas? ---
// If so, the only difference between them is the mirror, and our record is right.
console.log(`\n=== Comparing texture areas of the pairs ===`);
const rectKey = uv => [Math.min(uv[0], uv[2]), Math.min(uv[1], uv[3]), Math.max(uv[0], uv[2]), Math.max(uv[1], uv[3])]
	.map(v => v.toFixed(2)).join('/');

for (const r of dirty.filter(d => d.flippedU.length === 6)) {
	const twin = rows.find(o => o !== r
		&& !o.flippedU.length
		&& Math.abs(o.center[0] + r.center[0]) < 0.05
		&& Math.abs(o.center[1] - r.center[1]) < 0.05
		&& Math.abs(o.center[2] - r.center[2]) < 0.05);
	if (!twin) continue;
	const a = Object.values(r.uv).map(rectKey).sort();
	const b = Object.values(twin.uv).map(rectKey).sort();
	const same = a.length === b.length && a.every((v, i) => v === b[i]);
	const sizeSame = r.size.join() === twin.size.join();
	console.log(`  ${r.name.padEnd(10)} ↔ ${twin.name.padEnd(10)} areas ${same ? 'MATCH' : 'DIFFER'}, sizes ${sizeSame ? 'match' : 'differ'}`);
	if (!same) {
		console.log(`      ${r.name}: ${a.join('  ')}`);
		console.log(`      ${twin.name}: ${b.join('  ')}`);
	}
}
console.log('');
