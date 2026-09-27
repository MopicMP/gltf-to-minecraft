/**
 * Textures chosen per face, and faces with no texture.
 *
 * Blockbench exports each face of a cube as a primitive of its own, and a face
 * with no texture points at a placeholder: a 1×1 picture whose one pixel is
 * transparent. The import used to take one image per object — the first
 * primitive's — and lay all six faces into it, so a cube whose first face had
 * no texture arrived invisible (a user's shark lost a fin that way).
 *
 * Checked here: the placeholder is recognised by its pixels, which takes a
 * deflate decoder of our own (compared with Node's zlib byte for byte), and a
 * cube keeps its texture whichever face comes first.
 *
 * Run: node tools/verify-per-face-textures.mjs [folder with models, default test/model]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inflateRaw, isBlankImage, parseGLTFFiles, solveBox } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('\n=== The deflate decoder against zlib ===');
{
	// Deterministic pseudo-random bytes, so a failure can be reproduced.
	let seed = 12345;
	const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
	const inputs = [];
	for (const n of [0, 1, 2, 17, 255, 1000, 5000]) {
		inputs.push(Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256)));        // noise
		inputs.push(Uint8Array.from({ length: n }, (_, i) => (i * 7) % 13));                // repeats
		inputs.push(new Uint8Array(n));                                                      // zeros
	}
	inputs.push(new Uint8Array(Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(40))));
	let total = 0, wrong = 0;
	for (const input of inputs) {
		for (const level of [0, 1, 6, 9]) {
			for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY]) {
				const packed = zlib.deflateRawSync(input, { level, strategy });
				total++;
				let out;
				try { out = inflateRaw(packed, input.length); } catch (e) { out = null; }
				if (!out || !same(out, input)) wrong++;
			}
		}
	}
	ok(!wrong, `${total - wrong} of ${total} streams (stored, fixed and dynamic blocks) decode exactly`);
	ok((() => { try { inflateRaw(zlib.deflateRawSync(new Uint8Array(100)), 50); return false; } catch { return true; } })(),
		'a stream longer than expected is stopped, not decoded to the end');
	ok((() => { try { inflateRaw(Uint8Array.from([0xff, 0xff, 0xff]), 100); return false; } catch { return true; } })(),
		'garbage throws instead of producing bytes');
}

// Every PNG in the local collection: our decoder must agree with zlib on real files.
const root = process.argv[2] || path.join('test', 'model');
const pngs = [];
(function walk(d) {
	let e;
	try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
	for (const x of e) {
		const p = path.join(d, x.name);
		if (x.isDirectory()) walk(p);
		else if (/\.png$/i.test(x.name) && fs.statSync(p).size < 4 * 1024 * 1024) pngs.push(p);
	}
})(root);
if (pngs.length) {
	let agree = 0;
	for (const p of pngs) {
		const b = fs.readFileSync(p);
		const parts = [];
		for (let at = 8; at + 8 <= b.length;) {
			const len = b.readUInt32BE(at), name = b.toString('latin1', at + 4, at + 8);
			if (name === 'IDAT') parts.push(b.subarray(at + 8, at + 8 + len));
			if (name === 'IEND') break;
			at += 12 + len;
		}
		const z = Buffer.concat(parts);
		const want = zlib.inflateSync(z);
		let got;
		try { got = inflateRaw(new Uint8Array(z.subarray(2)), want.length); } catch { got = null; }
		if (got && same(got, want)) agree++;
	}
	ok(agree === pngs.length, `the pixels of ${agree} of ${pngs.length} PNG files in ${root} decode as zlib decodes them`);
}

/** A PNG from rows of raw samples, each row led by its filter byte. */
function png(width, height, colorType, rows, extra = []) {
	const chunk = (name, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = colorType;
	return new Uint8Array(Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
		chunk('IHDR', ihdr),
		...extra.map(([n, d]) => chunk(n, Buffer.from(d))),
		chunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
		chunk('IEND', Buffer.alloc(0)),
	]));
}

// Blockbench's own placeholder, byte for byte as its glTF exporter writes it.
const BLOCKBENCH_BLANK = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b494441541857636000020000050001aad5c8510000000049454e44ae426082', 'hex'));

console.log('\n=== What counts as an empty texture ===');
ok(isBlankImage(BLOCKBENCH_BLANK), 'Blockbench\'s placeholder (1×1, pixel 0,0,0,0) is empty');
ok(isBlankImage(png(1, 1, 6, [0, 0, 0, 0, 0])), 'a 1×1 RGBA pixel of zeros is empty');
ok(!isBlankImage(png(1, 1, 6, [0, 0, 0, 0, 255])), 'an opaque black pixel is not');
ok(!isBlankImage(png(1, 1, 6, [0, 255, 255, 255, 0])), 'a transparent white pixel is not claimed — only zeros are certain');
ok(isBlankImage(png(2, 2, 4, [4, 0, 0, 0, 0, 2, 0, 0, 0, 0])), 'grey+alpha zeros under Paeth and Up filters are empty');
ok(!isBlankImage(png(1, 1, 2, [0, 0, 0, 0])), 'black RGB has no alpha, so it is not empty');
ok(isBlankImage(png(1, 1, 3, [0, 0], [['PLTE', [0, 0, 0]], ['tRNS', [0]]])), 'a palette whose entry 0 is transparent: empty');
ok(!isBlankImage(png(1, 1, 3, [0, 0], [['PLTE', [0, 0, 0]]])), 'the same palette without tRNS: not empty');
ok(!isBlankImage(png(128, 128, 6, new Array(128 * (1 + 128 * 4)).fill(0))), 'a large image is not read at all');
ok(!isBlankImage(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...new Array(40).fill(0)])), 'a JPEG is not');
ok(!isBlankImage(BLOCKBENCH_BLANK.slice(0, 50)), 'a truncated file is not');

console.log('\n=== A cube whose first face has no texture ===');

/** A 16 px cube, one primitive per face, as Blockbench 3.x exported them. */
function cubeGLTF(materialOfFace, splitBlank) {
	const s = 1;
	const corners = [
		[[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0]],   // -z
		[[s, 0, s], [0, 0, s], [0, s, s], [s, s, s]],   // +z
		[[0, 0, s], [0, 0, 0], [0, s, 0], [0, s, s]],   // -x
		[[s, 0, 0], [s, 0, s], [s, s, s], [s, s, 0]],   // +x
		[[0, s, 0], [s, s, 0], [s, s, s], [0, s, s]],   // +y
		[[0, 0, s], [s, 0, s], [s, 0, 0], [0, 0, 0]],   // -y
	];
	const uvq = [[0, 1], [1, 1], [1, 0], [0, 0]];
	const floats = [];
	const views = [], accessors = [];
	for (const quad of corners) {
		// wound outward, as an exporter writes a cube: inward on a one-sided
		// material it would read as an outline shell and be left out
		const pos = [0, 2, 1, 0, 3, 2].map(i => quad[i]);
		const uv = [0, 2, 1, 0, 3, 2].map(i => uvq[i]);
		for (const [kind, list, type] of [['p', pos, 'VEC3'], ['t', uv, 'VEC2']]) {
			const offset = floats.length * 4;
			for (const v of list) floats.push(...v);
			views.push({ buffer: 0, byteOffset: offset, byteLength: list.length * list[0].length * 4 });
			const acc = { bufferView: views.length - 1, componentType: 5126, count: 6, type };
			if (kind === 'p') { acc.min = [0, 0, 0]; acc.max = [s, s, s]; }
			accessors.push(acc);
		}
	}
	const bin = Buffer.from(new Float32Array(floats).buffer);
	const prim = f => ({ attributes: { POSITION: f * 2, TEXCOORD_0: f * 2 + 1 }, material: materialOfFace[f] });
	const faces = [0, 1, 2, 3, 4, 5];
	const meshes = splitBlank
		? [{ primitives: faces.filter(f => materialOfFace[f] === 0).map(prim) },
			{ primitives: faces.filter(f => materialOfFace[f] === 1).map(prim) }]
		: [{ primitives: faces.map(prim) }];
	const gltf = {
		asset: { version: '2.0' },
		scene: 0, scenes: [{ nodes: meshes.map((_, i) => i) }],
		nodes: meshes.map((_, i) => ({ name: `cube_${i}`, mesh: i })),
		meshes, accessors, bufferViews: views,
		buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
		images: [{ uri: 'real.png' }, { uri: 'blank.png' }],
		textures: [{ source: 0 }, { source: 1 }],
		materials: [
			{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, alphaMode: 'MASK' },
			{ pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, alphaMode: 'MASK' },
		],
	};
	return {
		'model.gltf': new Uint8Array(Buffer.from(JSON.stringify(gltf))),
		'real.png': png(2, 2, 6, [0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]),
		'blank.png': BLOCKBENCH_BLANK,
	};
}

// The real image gets the atlas rectangle at (0,0), 16×16; the placeholder a
// rectangle far off, so a face laid into it cannot be mistaken for a real one.
const REAL = { x: 0, y: 0, w: 16, h: 16 }, ELSEWHERE = { x: 100, y: 100, w: 1, h: 1 };
const inReal = uv => uv[0] >= REAL.x - 1e-6 && uv[0] <= REAL.x + REAL.w + 1e-6 && uv[1] >= REAL.y - 1e-6 && uv[1] <= REAL.y + REAL.h + 1e-6;
{
	const files = cubeGLTF([1, 0, 0, 0, 0, 0], false);
	const parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128, uvRects: [REAL, ELSEWHERE], uvFallback: REAL });
	ok(parsed.images[1].blank && !parsed.images[0].blank, 'the placeholder is marked empty, the texture is not');
	ok(parsed.objects.length === 1 && parsed.objects[0].image === 0, 'the cube\'s image is the real one, not its first face\'s');
	const faces = parsed.objects[0].faces;
	const textured = faces.filter(f => f.uvs.every(Boolean));
	ok(textured.length === 10 && textured.every(f => f.uvs.every(inReal)), `all 10 textured triangles read the real texture (${textured.filter(f => f.uvs.every(inReal)).length})`);
	ok(faces.filter(f => f.uvs.every(uv => !uv)).length === 2 && parsed.blank.triangles === 2, 'the untextured face has no UV, so it stays hidden');
	const sol = solveBox(faces);
	ok(!sol.error && sol.emptyFaces.length === 1 && Object.keys(sol.faceUV).length === 5, `the cube keeps 5 textured faces and 1 hidden (hidden: ${sol.emptyFaces.join(', ')})`);
}
{
	// Sketchfab's conversion: the untextured faces become an object of their own.
	const files = cubeGLTF([1, 0, 0, 0, 0, 0], true);
	const parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128, uvRects: [REAL, ELSEWHERE], uvFallback: REAL });
	ok(parsed.objects.length === 1 && parsed.blank.objects === 1, 'an object made only of untextured faces is left out');
}
{
	// And nothing changes for a cube with a texture on every face.
	const files = cubeGLTF([0, 0, 0, 0, 0, 0], false);
	const parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128, uvRects: [REAL, ELSEWHERE], uvFallback: REAL });
	ok(parsed.objects[0].faces.every(f => f.uvs.every(inReal)) && !parsed.blank.triangles, 'a fully textured cube is untouched');
}

console.log(`\n${bad ? `❌ FAILED: ${bad}` : '✅ EVERY FACE GETS ITS OWN TEXTURE'}\n`);
process.exit(bad ? 1 : 0);
