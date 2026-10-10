/**
 * Two ways files are written that the import once read wrong, each of which
 * made parts of a scene vanish or wear the wrong texture.
 *
 * A panel a thousandth of a pixel thick, far from the origin: the corner across
 * the thickness is within the tolerance of the true neighbour, and an edge run
 * to it tilted the box a hair — its two big faces then lay on none of its sides
 * and came out empty, the panel invisible. Leaves, awnings and signs are made so.
 *
 * A material in the specular-glossiness workflow keeps its colour texture as
 * diffuseTexture inside that extension, not as baseColorTexture. Unread, every
 * part fell back to the first picture, and people in a building wore its walls.
 *
 * A toon outline made as an inside-out copy of a part on a one-sided material:
 * a viewer that culls back faces shows it as a rim, but as two-sided cubes it
 * covered the part it outlines. Such shells are left out, and only they.
 *
 * Run: node tools/verify-quirks.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox, parseGLTFFiles, FACE_DIRS } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

/**
 * A box as twelve triangles, the way Blockbench exports a cube: centre c, half
 * sizes h along the axes, turned by `turn` degrees about Y. The two faces across
 * the thinnest axis read UV rectangles of their own; the rest read a thin line.
 */
function exportedBox(c, h, turn) {
	const r = turn * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
	const at = (x, y, z) => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
	const faces = [];
	const quad = (P, uv) => {
		faces.push({ positions: [P[0], P[1], P[2]], uvs: [uv[0], uv[1], uv[2]] });
		faces.push({ positions: [P[0], P[2], P[3]], uvs: [uv[0], uv[2], uv[3]] });
	};
	const [a, b, d] = h;
	// the big faces, across z: front reads [10..36, 10..32], back reads [50..76, 10..32]
	quad([at(-a, -b, d), at(a, -b, d), at(a, b, d), at(-a, b, d)], [[10, 32], [36, 32], [36, 10], [10, 10]]);
	quad([at(a, -b, -d), at(-a, -b, -d), at(-a, b, -d), at(a, b, -d)], [[50, 32], [76, 32], [76, 10], [50, 10]]);
	// the thin sides: lines of UV, as the exporter leaves them
	const line = [[0.1, 0.1], [0.1, 0.1], [0.1, 21.9], [0.1, 21.9]];
	quad([at(-a, -b, -d), at(-a, -b, d), at(-a, b, d), at(-a, b, -d)], line);
	quad([at(a, -b, d), at(a, -b, -d), at(a, b, -d), at(a, b, d)], line);
	quad([at(-a, b, d), at(a, b, d), at(a, b, -d), at(-a, b, -d)], line);
	quad([at(-a, -b, -d), at(a, -b, -d), at(a, -b, d), at(-a, -b, d)], line);
	return faces;
}

// The order the corners come in decides which edge triple is met first, so each
// panel is tried in many orders: faces shuffled, and each triangle's corners turned.
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const shuffled = faces => {
	const out = faces.map(f => {
		const k = Math.floor(rnd() * 3);
		const turn = a => [a[k], a[(k + 1) % 3], a[(k + 2) % 3]];
		return { positions: turn(f.positions), uvs: turn(f.uvs) };
	});
	for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
	return out;
};

console.log('\n=== Panels a thousandth of a pixel thick ===');
{
	let total = 0, lost = 0;
	for (const c of [[0, 0, 0], [585, 33, 24.0005], [-340, 120, 812.25]]) {
		for (const turn of [0, 22.5, 37, 90]) {
			for (const thick of [0.001, 0.002, 0.01]) for (let n = 0; n < 12; n++) {
				const sol = solveBox(shuffled(exportedBox(c, [13, 11, thick / 2], turn)));
				total++;
				if (sol.error) { lost++; continue; }
				// the two big faces are the ones across the thinnest side, and both must read UV
				const s = sol.size.map(Math.abs);
				const thin = s.indexOf(Math.min(...s));
				const big = Object.keys(FACE_DIRS).filter(n => FACE_DIRS[n].normal[thin] !== 0);
				if (big.some(n => sol.emptyFaces.includes(n))) lost++;
			}
		}
	}
	ok(!lost, `both big faces of every panel carry their texture: ${total - lost} of ${total}`);
}

console.log('\n=== A material in the specular-glossiness workflow ===');
{
	// two quads, one on each of two materials, each with its own picture
	const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0]);
	const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]);
	const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3]);
	const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer)]);
	const png = size => {
		// the header is all the parser reads for size; the bytes need not decode
		const b = Buffer.alloc(33);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).copy(b);
		b.writeUInt32BE(size, 16); b.writeUInt32BE(size, 20); b[24] = 8; b[25] = 6;
		return new Uint8Array(b);
	};
	const sg = i => ({ extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: i }, diffuseFactor: [1, 1, 1, 1] } } });
	const gltf = {
		asset: { version: '2.0' },
		extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
		buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 96 },
			{ buffer: 0, byteOffset: 96, byteLength: 64 },
			{ buffer: 0, byteOffset: 160, byteLength: 24 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
			{ bufferView: 0, byteOffset: 48, componentType: 5126, count: 4, type: 'VEC3' },
			{ bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
			{ bufferView: 1, byteOffset: 32, componentType: 5126, count: 4, type: 'VEC2' },
			{ bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
			{ bufferView: 2, byteOffset: 12, componentType: 5123, count: 6, type: 'SCALAR' },
		],
		images: [{ uri: 'walls.png' }, { uri: 'skin.png' }],
		textures: [{ source: 0 }, { source: 1 }],
		materials: [sg(0), sg(1)],
		meshes: [
			{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 4, material: 0 }] },
			{ primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 3 }, indices: 5, material: 1 }] },
		],
		nodes: [{ name: 'wall', mesh: 0 }, { name: 'person', mesh: 1 }],
		scenes: [{ nodes: [0, 1] }],
	};
	const p = parseGLTFFiles({
		'scene.gltf': new Uint8Array(Buffer.from(JSON.stringify(gltf))),
		'walls.png': png(1024), 'skin.png': png(64),
	}, { scale: 16, uvWidth: 1, uvHeight: 1 });
	const person = p.objects.find(o => o.name === 'person'), wall = p.objects.find(o => o.name === 'wall');
	ok(wall && wall.image === 0 && person && person.image === 1, `each part reads its own picture: wall ${wall && wall.image}, person ${person && person.image}`);
	ok(p.images.every(i => i.role === 'color'), 'both pictures count as colour');
}

console.log('\n=== Outline shells: inside-out copies on a one-sided material ===');
{
	// A closed box as twelve triangles, wound outward, or inward when `inward`.
	const box = (lo, hi, inward) => {
		const at = (x, y, z) => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
		const quads = [
			[at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)], [at(1, 0, 0), at(0, 0, 0), at(0, 1, 0), at(1, 1, 0)],
			[at(1, 0, 1), at(1, 0, 0), at(1, 1, 0), at(1, 1, 1)], [at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0)],
			[at(0, 1, 1), at(1, 1, 1), at(1, 1, 0), at(0, 1, 0)], [at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)],
		];
		const pos = [], idx = [];
		for (const q of quads) {
			const k = pos.length;
			pos.push(...q);
			idx.push(...(inward ? [k, k + 2, k + 1, k, k + 3, k + 2] : [k, k + 1, k + 2, k, k + 2, k + 3]));
		}
		return { pos, idx };
	};
	// Meshes in one buffer, each on its own material; nodes as given.
	const file = (meshes, materials, nodes) => {
		const parts = [], views = [], accessors = [];
		let at = 0;
		const add = (typed, type, count, target) => {
			const b = Buffer.from(typed.buffer);
			parts.push(b);
			views.push({ buffer: 0, byteOffset: at, byteLength: b.length });
			accessors.push({ bufferView: views.length - 1, componentType: target, count, type });
			at += b.length;
			return accessors.length - 1;
		};
		const gltfMeshes = meshes.map(({ pos, idx, material }) => ({
			primitives: [{
				attributes: { POSITION: add(new Float32Array(pos.flat()), 'VEC3', pos.length, 5126) },
				indices: add(new Uint16Array(idx), 'SCALAR', idx.length, 5123), material,
			}],
		}));
		const bin = Buffer.concat(parts);
		const gltf = {
			asset: { version: '2.0' },
			buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
			bufferViews: views, accessors, materials, meshes: gltfMeshes, nodes,
			scenes: [{ nodes: nodes.map((_, i) => i).filter(i => !nodes.some(n => (n.children || []).includes(i))) }],
		};
		return parseGLTFFiles({ 'scene.gltf': new Uint8Array(Buffer.from(JSON.stringify(gltf))) }, { scale: 16, uvWidth: 1, uvHeight: 1 });
	};
	const toast = { name: 'toast' }, rim = { name: 'rim' }, twoSided = { name: 'rim', doubleSided: true };
	const body = { ...box([0, 0, 0], [1, 1, 1], false), material: 0 };
	const shell = { ...box([-0.05, -0.05, -0.05], [1.05, 1.05, 1.05], true), material: 1 };
	const names = p => p.objects.map(o => o.name).sort().join(', ');

	let p = file([body, shell], [toast, rim], [{ name: 'body', mesh: 0 }, { name: 'shell', mesh: 1 }]);
	ok(names(p) === 'body' && p.outlineShells === 1, `the inside-out shell is left out, the part stays: ${names(p)}; shells ${p.outlineShells}`);

	p = file([body, shell], [toast, twoSided], [{ name: 'body', mesh: 0 }, { name: 'shell', mesh: 1 }]);
	ok(names(p) === 'body, shell' && !p.outlineShells, `on a two-sided material the winding means nothing, both stay: ${names(p)}`);

	// Mirrored: an outward box under a negative scale reads inward in world
	// space, yet glTF turns the winding there, and it is an ordinary part.
	p = file([body, shell], [toast, rim], [
		{ name: 'mirror', scale: [-1, 1, 1], children: [1, 2] }, { name: 'body', mesh: 0 }, { name: 'shell', mesh: 1 },
	]);
	ok(names(p) === 'body' && p.outlineShells === 1, `under a mirroring transform the part stays and the shell goes: ${names(p)}`);

	// Open geometry has no inside: a lone inward quad is not a shell.
	const quad = { pos: shell.pos.slice(0, 4), idx: [0, 2, 1, 0, 3, 2], material: 1 };
	p = file([body, quad], [toast, rim], [{ name: 'body', mesh: 0 }, { name: 'panel', mesh: 1 }]);
	ok(names(p) === 'body, panel', `an open panel facing inward stays: ${names(p)}`);
}

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: THE FILE QUIRKS ARE READ RIGHT\n');
process.exit(bad ? 1 : 0);
