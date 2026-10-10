/**
 * Rebuilding the parts that are not boxes, on shapes made here.
 *
 * A prism of twelve sides cannot be one box. It must come back as a plate for
 * each side and each cap, the caps cut to their twelve-sided outline by the
 * texture, every texel the colour of the face under it; with the best way, a
 * strip along each slanted edge of a cap, lying on the edge itself. A cube off
 * by a hair stays one box. What a closed box hides goes, unless the two move
 * apart or the box is see-through there. And every piece has to come back out of the box solver as the very box
 * it was, its UV spanning its sheet exactly.
 *
 * Run: node tools/verify-rounded.mjs
 */
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../plugin/gltf_to_minecraft.js');
const { ROUND, rebuildNotBoxes, shapePart, piecesAt, plateMask, plateMaskBesideStrips, solveBox, pieceFaces, decodePNG } = lib;

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

// ------------------------------------------------------------ shapes

/** An 8×8 picture: texel k has colour k, so a face reading texel k shows whose it is. */
const colourOf = k => [(k * 37) % 256, 255 - (k * 23) % 200, (k * 71) % 256, 255];
const PICTURE = { w: 8, h: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
for (let k = 0; k < 64; k++) PICTURE.data.set(colourOf(k), k * 4);
const uvOf = k => [((k % 8) + 0.5) / 8, (Math.floor(k / 8) + 0.5) / 8];

/**
 * A prism of n sides around the Y axis: radius r, height h, standing at c. Face
 * k reads texel k: the sides 0..n-1, the bottom n, the top n+1.
 */
function prism(n, r, h, c = [0, 0, 0], turn = 0) {
	const ring = y => Array.from({ length: n }, (_, i) => {
		const a = turn + 2 * Math.PI * i / n;
		return [c[0] + r * Math.cos(a), c[1] + y, c[2] + r * Math.sin(a)];
	});
	const lo = ring(-h / 2), hi = ring(h / 2);
	const faces = [];
	const tri = (a, b, d, k) => faces.push({ positions: [a, b, d], uvs: [uvOf(k), uvOf(k), uvOf(k)], image: 0, k });
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		tri(lo[i], lo[j], hi[j], i);
		tri(lo[i], hi[j], hi[i], i);
	}
	for (let i = 1; i + 1 < n; i++) {
		tri(lo[0], lo[i + 1], lo[i], n);
		tri(hi[0], hi[i], hi[i + 1], n + 1);
	}
	return faces;
}

/** A cube of side s at c, one corner pushed out by `nudge`: not a box, but nearly. */
function nudgedCube(s, c, nudge) {
	const P = [];
	for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) P.push([c[0] + x * s / 2, c[1] + y * s / 2, c[2] + z * s / 2]);
	P[7] = P[7].map(v => v + nudge);
	const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
	const faces = [];
	quads.forEach((q, k) => {
		faces.push({ positions: [P[q[0]], P[q[1]], P[q[2]]], uvs: [uvOf(k), uvOf(k), uvOf(k)], image: 0, k });
		faces.push({ positions: [P[q[0]], P[q[2]], P[q[3]]], uvs: [uvOf(k), uvOf(k), uvOf(k)], image: 0, k });
	});
	return faces;
}

/** A square plate of side s lying flat, two triangles. */
function square(s) {
	const P = [[0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s]];
	return [
		{ positions: [P[0], P[1], P[2]], uvs: [uvOf(0), uvOf(0), uvOf(0)], image: 0, k: 0 },
		{ positions: [P[0], P[2], P[3]], uvs: [uvOf(0), uvOf(0), uvOf(0)], image: 0, k: 0 },
	];
}

const run = (parts, boxes, mode) => rebuildNotBoxes({
	parts: parts.map(p => ({ faces: p.faces || p, rigid: p.rigid || 0 })),
	boxes: boxes || [], pictures: () => PICTURE, mode,
});

/** Which face each plate stands for: the k its triangles carry. */
const faceK = (pc, faces) => {
	const plate = pc.kind === 'plate' ? pc : pc.owner;
	const byTri = new Map(faces.map(f => [f.positions, f.k]));
	return new Set(plate.group.tris.map(t => byTri.get(t)));
};

// ------------------------------------------------------------ the prism, fast

console.log('\n=== A prism of twelve sides, fast ===');
{
	const faces = prism(12, 6, 10);
	const r = await run([faces], [], 'fast');
	const plates = r.pieces.filter(pc => pc.kind === 'plate');
	ok(r.pieces.length === 14 && plates.length === 14, `a plate for each side and cap: ${plates.length} plates of ${r.pieces.length} pieces (want 14)`);
	ok(r.texel === ROUND.TEXELS[0], `texel ${r.texel}: the finest, the prism is small`);

	// every shown texel wears its own face's colour
	let wrong = 0, shown = 0;
	for (const pc of plates) {
		const ks = [...faceK(pc, faces)];
		const want = colourOf(ks[0]);
		const sh = pc.sheets[0];
		for (let i = 0; i < sh.cols * sh.rows; i++) {
			if (!sh.data[i * 4 + 3]) continue;
			shown++;
			if ([0, 1, 2].some(c => sh.data[i * 4 + c] !== want[c])) wrong++;
		}
	}
	ok(shown > 0 && !wrong, `every shown texel has its face's colour (${shown} shown, ${wrong} wrong)`);

	// a cap's shown texels cover its twelve-sided outline, give or take a rim
	const cap = plates.find(pc => faceK(pc, faces).has(13));
	const T = cap.texel;
	const area = 0.5 * 12 * 36 * Math.sin(2 * Math.PI / 12);
	const perimeter = 12 * 2 * 6 * Math.sin(Math.PI / 12);
	const got = cap.sheets[0].data.filter((_, i) => i % 4 === 3 && _).length * T * T;
	ok(Math.abs(got - area) <= perimeter * T, `the cap is cut to its outline: ${got.toFixed(2)} px² shown for ${area.toFixed(2)} (within ${(perimeter * T).toFixed(2)})`);
	ok(cap.box.half[1] * 2 >= 11.5 && cap.box.half[0] === 0, 'the cap is a flat cube as wide as the prism');

	// each piece comes back out of the box solver as itself, its UV on its sheet
	let lost = 0, moved = 0, uvOff = 0;
	const rect = k => ({ x: 100 + 40 * k, y: 3, w: 0, h: 0 });
	for (const pc of r.pieces) {
		const sh = pc.sheets[0];
		pc.sheetIndex = [r.pieces.indexOf(pc)];
		const R = { ...rect(pc.sheetIndex[0]), w: sh.cols, h: sh.rows };
		const sol = solveBox(pieceFaces(pc, () => R));
		if (sol.error) { lost++; continue; }
		const d = Math.hypot(...pc.box.c.map((v, k) => v - sol.center[k]));
		const want = pc.box.half.map(h => 2 * h).sort((a, b) => a - b), gotS = sol.size.map(Math.abs).sort((a, b) => a - b);
		if (d > 1e-6 || want.some((v, k) => Math.abs(v - gotS[k]) > 1e-6)) moved++;
		const uv = Object.values(sol.faceUV);
		const span = [2 * pc.box.half[1] / pc.texel, 2 * pc.box.half[2] / pc.texel].sort((a, b) => a - b);
		if (uv.length !== 2 || uv.some(f => {
			const s = [Math.abs(f[2] - f[0]), Math.abs(f[3] - f[1])].sort((a, b) => a - b);
			return Math.abs(s[0] - span[0]) > 1e-6 || Math.abs(s[1] - span[1]) > 1e-6
				|| Math.min(f[0], f[2]) !== R.x || Math.min(f[1], f[3]) !== R.y;
		})) uvOff++;
	}
	ok(!lost && !moved && !uvOff, `the box solver gives every piece back as it was: lost ${lost}, moved ${moved}, UV off ${uvOff}`);
}

// ------------------------------------------------------------ the prism, best

console.log('\n=== The same prism, best quality ===');
{
	const faces = prism(12, 6, 10);
	const r = await run([faces], [], 'best');
	const strips = r.pieces.filter(pc => pc.kind === 'strip');
	// a cap turned to lay four of its edges along the grid leaves eight slanted
	ok(strips.length === 16, `a strip along each slanted cap edge: ${strips.length} (want 16)`);
	ok(strips.every(pc => faceK(pc, faces).has(12) || faceK(pc, faces).has(13)), 'the strips belong to the caps only: the sides are rectangles along the grid');
	// a strip stands on an edge of the source
	const edges = [];
	for (const f of faces) for (let i = 0; i < 3; i++) edges.push([f.positions[i], f.positions[(i + 1) % 3]]);
	const onEdge = pc => {
		const A = pc.corner, B = lib.boxAlong ? null : null;
		const end = pc.corner.map((v, k) => v + pc.a1[k] * 2 * pc.box.half[1]);
		return edges.some(([P, Q]) => (Math.hypot(...P.map((v, k) => v - A[k])) < 1e-9 && Math.hypot(...Q.map((v, k) => v - end[k])) < 1e-9)
			|| (Math.hypot(...Q.map((v, k) => v - A[k])) < 1e-9 && Math.hypot(...P.map((v, k) => v - end[k])) < 1e-9));
	};
	ok(strips.every(onEdge), 'every strip runs exactly along an edge of the source');
	ok(strips.every(pc => Math.abs(2 * pc.box.half[2] - ROUND.STRIP_WIDTH * pc.texel) < 1e-9), `each strip is ${ROUND.STRIP_WIDTH} texels wide`);
	// beside a strip the cap keeps whole texels only: fewer shown than without strips
	const fast = await run([prism(12, 6, 10)], [], 'fast');
	const capOf = res => res.pieces.find(pc => pc.kind === 'plate' && [...pc.group.tris].length > 2 && pc.box.half[0] === 0
		&& Math.abs(pc.box.axes[0][1]) > 0.99 && pc.box.c[1] > 0);
	const shownIn = pc => pc.sheets[0].data.filter((_, i) => i % 4 === 3 && _).length;
	ok(shownIn(capOf(r)) < shownIn(capOf(fast)), `beside its strips the cap shows only whole texels: ${shownIn(capOf(r))} against ${shownIn(capOf(fast))}`);
}

// ------------------------------------------------------------ nearly a box

console.log('\n=== A cube off by a hair ===');
{
	const near = shapePart(nudgedCube(4, [0, 0, 0], 0.05).map(f => f.positions));
	ok(!!near.box, `0.05 px off: one box, within ${ROUND.FIT_TOL} px`);
	const far = shapePart(nudgedCube(4, [0, 0, 0], 0.6).map(f => f.positions));
	ok(!far.box && far.regions.length > 6, `0.6 px off: plates (${far.regions ? far.regions.length : 0} regions)`);
	const r = await run([nudgedCube(4, [0, 0, 0], 0.05)], [], 'fast');
	const one = r.pieces[0];
	ok(r.pieces.length === 1 && one.kind === 'box' && one.sheets.filter(Boolean).length === 6, 'the box wears six baked sheets');
	// each side of the box reads the face it lies on; nudgedCube's quads go -x, +x,
	// -y, +y, -z, +z. The box may lean a hair to hold the pushed corner, and a ray
	// at the very rim may land on the neighbour, so nine in ten texels will do
	const DIRS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
	let right = 0;
	one.sheets.forEach((sh, f) => {
		const [a, sg] = lib.BOX_SIDES[f];
		const n = one.box.axes[a].map(x => x * sg);
		const k = DIRS.findIndex(d => d.every((x, i) => Math.abs(x - n[i]) < 0.1));
		const c = colourOf(k);
		let good = 0;
		for (let i = 0; i < sh.cols * sh.rows; i++) if ([0, 1, 2].every(j => sh.data[i * 4 + j] === c[j])) good++;
		if (k >= 0 && good >= 0.9 * sh.cols * sh.rows) right++;
	});
	ok(right === 6, `each side of the box reads its own face: ${right} of 6`);
}

// ------------------------------------------------------------ the texel budget

console.log('\n=== A plate too large for the finest texel ===');
{
	// 400 px a side: 3200² texels at 1/8 is over the budget, 1600² at 1/4 is not.
	// A triangle is no box and becomes a plate
	const plate = await run([square(400).slice(0, 1)], [], 'fast');
	ok(plate.texel === 0.25 && plate.pieces[0].kind === 'plate', `a large plate: texel ${plate.texel} (want 0.25)`);
	// A square is a flat box, kept whole, and its two faces both count: 2 × 1600²
	// at 1/4 is over the budget too
	const slab = await run([square(400)], [], 'fast');
	ok(slab.texel === 0.5 && slab.pieces[0].kind === 'box', `a large slab kept whole counts both its faces: texel ${slab.texel} (want 0.5)`);
}

// ------------------------------------------------------------ what cannot be seen

console.log('\n=== What a closed box hides ===');
{
	// the file's own box, as the parser gives it: twelve triangles reading the
	// picture — texel 0 for a solid one, texel 63 made clear for a see-through one
	const shell = (half, k, rigid = 0) => {
		const faces = nudgedCube(2 * half, [0, 0, 0], 0);
		for (const f of faces) f.uvs = [uvOf(k), uvOf(k), uvOf(k)];
		return { box: { c: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [half, half, half] }, faces, rigid };
	};
	const inside = await run([{ faces: prism(8, 2, 3), rigid: 0 }], [shell(10, 0)], 'fast');
	ok(inside.pieces.length === 0 && inside.stats.culled === 10, `a prism inside a solid box goes: ${inside.stats.culled} pieces left out, ${inside.pieces.length} kept`);
	const apart = await run([{ faces: prism(8, 2, 3), rigid: 1 }], [shell(10, 0)], 'fast');
	ok(apart.pieces.length === 10 && !apart.stats.culled, `the same prism on a moving bone stays: ${apart.pieces.length} kept`);
	const out = await run([{ faces: prism(8, 2, 3, [20, 0, 0]), rigid: 0 }], [shell(10, 0)], 'fast');
	ok(out.pieces.length === 10, `the same prism beside the box stays: ${out.pieces.length} kept`);
	// an outer layer clear where it is unused hides nothing there
	const clear = { ...PICTURE, data: PICTURE.data.slice() };
	clear.data[63 * 4 + 3] = 0;
	const seeThrough = await rebuildNotBoxes({ parts: [{ faces: prism(8, 2, 3), rigid: 0 }], boxes: [shell(10, 63)], pictures: () => clear, mode: 'fast' });
	ok(seeThrough.pieces.length === 10, `a prism inside a see-through box stays: ${seeThrough.pieces.length} kept`);
	// finishing early skips the cull and keeps it all
	const hurried = await rebuildNotBoxes({ parts: [{ faces: prism(8, 2, 3), rigid: 0 }], boxes: [shell(10, 0)], pictures: () => PICTURE, mode: 'fast' },
		{ stopRequested: () => true });
	ok(hurried.pieces.length === 10 && hurried.stats.hurried, 'Finish now keeps the hidden pieces');
	const gone = await rebuildNotBoxes({ parts: [{ faces: prism(8, 2, 3), rigid: 0 }], boxes: [shell(10, 0)], pictures: () => PICTURE, mode: 'fast' },
		{ cancelled: () => true });
	ok(gone === null, 'Cancel gives nothing back');
}

// ------------------------------------------------------------ pictures

console.log('\n=== PNG pixels without a canvas ===');
{
	const png = (w, h, type, depth, rows, extra = []) => {
		const chunk = (t, d) => {
			const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
			const td = Buffer.concat([Buffer.from(t), d]);
			const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
			return Buffer.concat([len, td, crc]);
		};
		const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = type;
		const raw = Buffer.concat(rows.map(r => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
		return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
			...extra.map(([t, d]) => chunk(t, Buffer.from(d))), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
	};
	const rgba = decodePNG(png(2, 1, 6, 8, [[255, 0, 0, 255, 0, 0, 255, 0]]));
	ok(rgba.w === 2 && [...rgba.data].join() === '255,0,0,255,0,0,255,0', 'RGBA read as it is');
	// one bit a pixel, a palette of two, the second clear
	const pal = decodePNG(png(3, 1, 3, 1, [[0b10100000]], [['PLTE', [10, 20, 30, 40, 50, 60]], ['tRNS', [255, 0]]]));
	ok([...pal.data].join() === '40,50,60,0,10,20,30,255,40,50,60,0', 'a one-bit palette with a clear entry');
	const grey = decodePNG(png(1, 1, 4, 8, [[128, 64]]));
	ok([...grey.data].join() === '128,128,128,64', 'grey with alpha');
	let threw = false;
	try { decodePNG(png(1, 1, 2, 16, [[0, 0, 0, 0, 0, 0]])); } catch (e) { threw = true; }
	ok(threw, 'sixteen bits a channel are left to the canvas');
}

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: PARTS THAT ARE NOT BOXES ARE REBUILT\n');
process.exit(bad ? 1 : 0);
