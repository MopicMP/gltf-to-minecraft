/**
 * Compares parsing of a REAL glTF (the original the OBJ was once made from)
 * with a reference computed from that OBJ.
 *
 * Matching goes by geometry, not by names: in glTF the nodes are all called
 * the same ("cube", "cube", …), while the OBJ exporter renamed them.
 *
 * Run: node tools/verify-real-gltf.mjs "model(gltf)/source/model.gltf" model/model.obj
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox, parseGLTFFiles } = require('../plugin/gltf_to_minecraft.js');

const gltfPath = process.argv[2] ?? 'model(gltf)/source/model.gltf';
const objPath = process.argv[3] ?? 'model/model.obj';
const TEX = 128;

// ------------------------------------------------------------ reference from OBJ

const positions = [], uvs = [], objects = [];
let cur = null;
for (const raw of fs.readFileSync(objPath, 'utf8').split('\n')) {
	const l = raw.trim();
	if (!l || l[0] === '#') continue;
	const p = l.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(cur = { name: p.slice(1).join(' '), faces: [] });
	else if (p[0] === 'f') {
		const c = p.slice(1).map(t => { const [a, b] = t.split('/'); return { v: +a - 1, t: b ? +b - 1 : -1 }; });
		for (let i = 1; i + 1 < c.length; i++) {
			const tri = [c[0], c[i], c[i + 1]];
			cur.faces.push({
				positions: tri.map(x => positions[x.v].map(v => v * 16)),
				uvs: tri.map(x => x.t < 0 ? null : [uvs[x.t][0] * TEX, (1 - uvs[x.t][1]) * TEX]),
			});
		}
	}
}

const baseline = [];
for (const o of objects) {
	const s = solveBox(o.faces);
	if (!s.error) baseline.push({ name: o.name, sol: s });
}

// ------------------------------------------------------------- glTF parsing

const files = { [path.basename(gltfPath)]: new Uint8Array(fs.readFileSync(gltfPath)) };
const parsed = parseGLTFFiles(files, { scale: 16, uvWidth: TEX, uvHeight: TEX });

console.log(`\nReference from OBJ: ${baseline.length} objects`);
console.log(`Parsed from glTF  : ${parsed.objects.length} objects`);
if (parsed.warnings.length) {
	console.log(`Warnings          : ${parsed.warnings.length}`);
	for (const w of parsed.warnings.slice(0, 5)) console.log('  ' + w);
}

// ---------------------------------------------- matching by geometry

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const used = new Set();
let matched = 0, failed = 0, uvOk = 0, uvBad = 0;
const problems = [];

for (const obj of parsed.objects) {
	const got = solveBox(obj.faces);
	if (got.error) { failed++; problems.push(`${obj.name}: ${got.error}`); continue; }

	// A pair is looked for by centre AND size at once: the model has cubes with
	// coinciding centres, and by centre alone the pair is ambiguous.
	let best = null, bestD = Infinity;
	baseline.forEach((b, i) => {
		if (used.has(i)) return;
		const d = dist(got.center, b.sol.center)
			+ got.size.reduce((s, v, k) => s + Math.abs(v - b.sol.size[k]), 0);
		if (d < bestD) { bestD = d; best = { b, i }; }
	});
	const span = Math.max(...got.size) || 1;
	if (!best || bestD > span * 0.01) {
		failed++;
		problems.push(`${obj.name}: no pair found (nearest at ${bestD.toFixed(4)} px)`);
		continue;
	}
	used.add(best.i);
	matched++;

	const sizeOk = got.size.every((v, i) => Math.abs(v - best.b.sol.size[i]) < span * 0.01);
	if (!sizeOk) { problems.push(`${obj.name} ↔ ${best.b.name}: sizes differ`); uvBad++; continue; }

	let ok = true;
	for (const f in best.b.sol.faceUV) {
		const a = best.b.sol.faceUV[f], c = got.faceUV[f];
		if (!c || !a.every((v, i) => Math.abs(v - c[i]) < 0.01)) ok = false;
	}
	if (ok) uvOk++;
	else { uvBad++; problems.push(`${obj.name} ↔ ${best.b.name}: UV differ`); }
}

console.log(`\nMatched by geometry : ${matched}/${baseline.length}`);
console.log(`  UV matched        : ${uvOk}`);
console.log(`  UV differed       : ${uvBad}`);
console.log(`  not parsed        : ${failed}`);
if (problems.length) {
	console.log(`\nProblems (${problems.length}):`);
	for (const p of problems.slice(0, 10)) console.log('  ' + p);
}

const pass = matched === baseline.length && uvBad === 0 && failed === 0;
console.log(`\n${pass ? '✅ THE ORIGINAL glTF PARSES EXACTLY LIKE THE OBJ' : '❌ THERE ARE DIFFERENCES'}\n`);
process.exit(pass ? 0 : 1);
