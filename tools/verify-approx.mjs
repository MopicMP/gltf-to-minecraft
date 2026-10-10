/**
 * Approximating not-boxes with a bounding box: how the texture lands.
 *
 * Models marked "broken textures" are made of wedges and bevels —
 * geometry Minecraft does not have. Such an object loses its shape
 * inevitably, but it used to get ONE UV rectangle for all six faces,
 * and every side showed the bounds of the whole unwrap at once. Hence the mess.
 *
 * Run: node tools/verify-approx.mjs [folder with unpacked models]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boxFromBounds, triangleNormal, solveBox, splitComponents, parseGLTFFiles } =
	require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

// ------------------------------------------------------------ normal

console.log('\n=== Triangle normal ===');
const n1 = triangleNormal([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
ok(n1 && Math.abs(n1[2] - 1) < 1e-9, 'a triangle in the XY plane faces +Z');
ok(!triangleNormal([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), 'a degenerate triangle gives null');
ok(!triangleNormal([[0, 0, 0], [1, 0, 0]]), 'two points are not enough');

// ------------------------------------------------- UV laid out per face

console.log('\n=== Wedge: every face gets its own piece of texture ===');

// a wedge: a square at the bottom, bevelled at the top — exactly what models contain
const quad = (p0, p1, p2, p3, uv0, uv1, uv2, uv3) => ([
	{ positions: [p0, p1, p2], uvs: [uv0, uv1, uv2] },
	{ positions: [p0, p2, p3], uvs: [uv0, uv2, uv3] },
]);
// The vertex winding sets the normal's direction, so each face has its own:
// the bottom is wound so that its normal points down, and so on.
const wedge = [
	// bottom: normal -Y
	...quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]),
	// top: normal +Y
	...quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0], [0.5, 0.5], [0.5, 0.6], [0.6, 0.6], [0.6, 0.5]),
	// front: normal -Z
	...quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [0.2, 0.2], [0.2, 0.3], [0.3, 0.3], [0.3, 0.2]),
];
const sol = boxFromBounds(wedge);
ok(!!sol && sol.approximated, 'bounding box built and marked as approximated');

const rects = Object.entries(sol.faceUV).map(([k, v]) => [k, v.join(',')]);
const unique = new Set(rects.map(r => r[1]));
ok(unique.size > 1, `faces have different UV rectangles (distinct: ${unique.size})`);
ok(sol.faceUV.down.join(',') === '0,0,0.1,0.1', `bottom took its own piece: ${sol.faceUV.down.join(',')}`);
ok(sol.faceUV.up.join(',') === '0.5,0.5,0.6,0.6', `top took its own piece: ${sol.faceUV.up.join(',')}`);
ok(sol.faceUV.north.join(',') === '0.2,0.2,0.3,0.3', `front took its own piece: ${sol.faceUV.north.join(',')}`);
// a face without triangles gets the overall bounds — no side may be left empty
ok(sol.faceUV.east.join(',') === '0,0,0.6,0.6', 'a face without its own triangles takes the overall bounds');

// ------------------------------------------------- on real models

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

	console.log('\n=== Real models reported as "broken textures" ===');
	const dirs = [];
	const collect = d => {
		const es = fs.readdirSync(d, { withFileTypes: true });
		if (es.some(e => e.isFile())) { dirs.push(d); return; }
		for (const e of es) if (e.isDirectory()) collect(path.join(d, e.name));
	};
	collect(root);

	for (const dir of dirs) {
		let parsed;
		try { parsed = parseGLTFFiles(readDir(dir), { scale: 1, uvWidth: 1, uvHeight: 1 }); } catch { continue; }
		let approx = 0, distinct = 0, single = 0;
		for (const obj of parsed.objects) {
			for (const faces of splitComponents(obj.faces)) {
				if (!solveBox(faces).error) continue;
				const s = boxFromBounds(faces);
				if (!s) continue;
				approx++;
				const u = new Set(Object.values(s.faceUV).map(r => r.join(',')));
				if (u.size > 1) distinct++; else single++;
			}
		}
		if (!approx) continue;
		console.log(`  ${path.relative(root, dir).replace(/[\/]source$/, "").padEnd(38)} approximated ${String(approx).padStart(4)}: `
			+ `with different UV per face ${String(distinct).padStart(4)}, with identical ${single}`);
	}
}

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: APPROXIMATION LAYS UV OUT PER FACE\n');
process.exit(bad ? 1 : 0);
