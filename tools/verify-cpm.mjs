/**
 * Checks the .cpmproject build: our own output is read by the mod's rules.
 *
 * Blockbench cannot be started here, and checking by hand in the game is slow. But
 * the format rules sit entirely in CustomPlayerModels/.../project/loaders/*V1.java
 * and in BoxRender.java, and an independent check is written from them.
 *
 * Three things are checked, from cheap to expensive:
 *   1. structure — the fields and types ElementsLoaderV1 reads;
 *   2. limits — angles in 0..360, integer UV, the cube count against MAX_CUBE_COUNT;
 *   3. geometry — the tree is run through the same transform as the CPM renderer
 *      (shift by pos, rotation, shift by offset, box of size), and the eight corners
 *      of every box are compared with the source from Blockbench.
 *
 * The third is the real one: it catches mixed-up axes, signs and angle order —
 * exactly where the transfer breaks.
 *
 *   node tools/verify-cpm.mjs "model(gltf)/source/model.gltf"
 *   node tools/verify-cpm.mjs "model(gltf)/source/model.gltf" --write out.cpmproject
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const plugin = require('../plugin/gltf_to_minecraft.js');
const {
	parseGLTFFiles, solveBox, boxFromBounds, isDegenerate, splitComponents,
	placeCoords, buildCPMFiles, cpmAutoAssign, cpmUVScale, cpmPoint,
	CPM_PARTS, CPM_PART_NAMES, FACE_NAMES,
} = plugin;

const args = process.argv.slice(2);
const gltfPath = args.find(a => !a.startsWith('--')) || 'model(gltf)/source/model.gltf';
const writeAt = args.includes('--write') ? args[args.indexOf('--write') + 1] : null;
const FPS = Number(args.includes("--fps") ? args[args.indexOf("--fps") + 1] : 0) || 12;
const SCALE = Number(args.includes('--scale') ? args[args.indexOf('--scale') + 1] : 0) || null;

// ------------------------------------------------------------------ loading

if (!fs.existsSync(gltfPath)) {
	console.error(`no such file: ${gltfPath}`);
	process.exit(2);
}

const dir = path.dirname(gltfPath);
const files = {};
files[path.basename(gltfPath)] = new Uint8Array(fs.readFileSync(gltfPath));
// glTF refers to neighbouring files (.bin, images) by relative paths
const gltfJson = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
for (const ref of [...(gltfJson.buffers || []), ...(gltfJson.images || [])]) {
	if (!ref.uri || ref.uri.startsWith('data:')) continue;
	const p = path.join(dir, decodeURIComponent(ref.uri));
	if (fs.existsSync(p)) files[ref.uri] = new Uint8Array(fs.readFileSync(p));
	else {
		const alt = path.join(dir, '..', decodeURIComponent(ref.uri));
		if (fs.existsSync(alt)) files[ref.uri] = new Uint8Array(fs.readFileSync(alt));
	}
}

// Scale: as in the import — by the bounds, unless set by hand.
const probe = parseGLTFFiles(files, { scale: 1, uvWidth: 1, uvHeight: 1, rotate: [0, 0, 0] });

// The texture is taken from the parse, not from disk: in this model it is embedded in glTF
// as a data URI, and a search by file name simply does not find it.
let texW = 64, texH = 64, skinBytes = null;
for (const img of probe.images) {
	const s = plugin.imageSize(img.bytes);
	if (!s || img.role === 'aux') continue;
	texW = s.width; texH = s.height; skinBytes = img.bytes;
	break;
}
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const o of probe.objects) for (const f of o.faces) for (const q of f.positions) {
	for (let a = 0; a < 3; a++) { if (q[a] < lo[a]) lo[a] = q[a]; if (q[a] > hi[a]) hi[a] = q[a]; }
}
const heightUnits = hi[1] - lo[1] || 1;
// CPM measures in player pixels: 32 px tall. That is the default
// for the separate scale slider on the CPM branch.
const scale = SCALE || 32 / heightUnits;
// The player's feet stand at y = 0, so the bottom of the model goes down to zero, and X and Z are centred.
const offset = [
	-((lo[0] + hi[0]) / 2) * scale,
	-lo[1] * scale,
	-((lo[2] + hi[2]) / 2) * scale,
];

const parsed = parseGLTFFiles(files, { scale, offset, rotate: [0, 0, 0], uvWidth: texW, uvHeight: texH });

// Merged meshes are split into components — as in the import.
const split = [];
for (const obj of parsed.objects) {
	const parts = splitComponents(obj.faces);
	parts.forEach((faces, i) => split.push({
		...obj,
		name: parts.length > 1 ? `${obj.name}_${i + 1}` : obj.name,
		faces,
	}));
}

const cubes = [];
let approximated = 0;
for (const obj of split) {
	if (isDegenerate(obj.faces)) continue;
	let sol = solveBox(obj.faces);
	if (sol.error) {
		sol = boxFromBounds(obj.faces);
		if (!sol) continue;
		approximated++;
	}
	cubes.push({ name: obj.name, node: obj.node, sol, inflate: 0 });
}

// ------------------------------------------------------------------- build

const assign = cpmAutoAssign(parsed.hierarchy);
const uv = cpmUVScale(cubes, 16, Math.max(texW, texH));
// Nodes moved by at least one animation: they must not be collapsed, or the
// animations would have nothing left to rotate.
const animated = new Set();
for (const a of parsed.animations) for (const ch of a.channels) animated.add(ch.node);

const poses = {};
for (const a of parsed.animations) poses[a.name] = plugin.cpmAutoPose(a.name);

// Aligning the skeleton with the player's. Without it a model not built around the centre
// looks right at rest, and at the first movement its limbs get twisted.
const align = plugin.cpmAlignOffset(parsed.hierarchy, assign, 1);

const built = buildCPMFiles({
	align,
	// The head is driven by the model itself: it has its own animations, and the vanilla
	// camera rotation would be laid on top and tear the head off the body when tilting.
	stopVanillaAnim: { head: true },
	hierarchy: parsed.hierarchy,
	cubes,
	assign,
	keepNodes: animated,
	animations: parsed.animations,
	poses,
	fps: FPS,
	gltfScale: scale,
	uvMul: uv.mul,
	texWidth: texW,
	texHeight: texH,
	uvWidth: texW * uv.mul,
	uvHeight: texH * uv.mul,
	skin: skinBytes,
	name: path.basename(gltfPath),
});

// ---------------------------------------------------------------- checks

const problems = [];
const notes = [];
const fail = m => problems.push(m);

// 1. Structure: the fields and types ElementsLoaderV1.loadElement reads.
const NUM_FIELDS = ['textureSize', 'u', 'v', 'mcScale', 'nameColor'];
const BOOL_FIELDS = ['show', 'texture', 'mirror', 'glow', 'recolor', 'hidden', 'singleTex', 'extrude', 'locked'];
const VEC_FIELDS = ['offset', 'pos', 'rotation', 'size', 'rscale', 'scale'];
const config = built.config;

if (config.version !== 1) fail(`version = ${config.version}, the loader expects 1`);
if (!Array.isArray(config.elements)) fail('elements is not a list');

const rootIds = config.elements.map(e => e.id);
for (const p of CPM_PART_NAMES) {
	if (!rootIds.includes(p)) fail(`no root ${p}`);
}
for (const e of config.elements) {
	// ElementsLoaderV1 looks for a root by the player part's name; any other name is exactly
	// what the official plugin tripped over (Unknown root group).
	if (!CPM_PART_NAMES.includes(e.id) && !e.customPart) fail(`unknown root: ${e.id}`);
}

let elemCount = 0, boxCount = 0, uvFaces = 0;
const walk = (list, depth) => {
	for (const el of list || []) {
		elemCount++;
		if (typeof el.name !== 'string') fail(`${el.name}: name is not a string`);
		for (const f of NUM_FIELDS) if (typeof el[f] !== 'number') fail(`${el.name}: ${f} is not a number`);
		for (const f of BOOL_FIELDS) if (typeof el[f] !== 'boolean') fail(`${el.name}: ${f} is not a boolean`);
		for (const f of VEC_FIELDS) {
			const v = el[f];
			if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
				fail(`${el.name}: ${f} is not a vector`);
			}
		}
		// Integer.parseUnsignedInt(color, 16) will fail on anything else
		if (!/^[0-9a-fA-F]{1,8}$/.test(String(el.color))) fail(`${el.name}: color = ${el.color} is not a hex string`);
		for (const a of ['x', 'y', 'z']) {
			const r = el.rotation[a];
			if (!(r >= 0 && r < 360)) fail(`${el.name}: rotation.${a} = ${r} outside 0..360 — writeAngle will clamp it to zero`);
			if (!(el.size[a] >= 0)) fail(`${el.name}: size.${a} is negative`);
		}
		if (el.size.x || el.size.y || el.size.z) boxCount++;
		if (el.faceUV) {
			for (const [d, f] of Object.entries(el.faceUV)) {
				uvFaces++;
				for (const k of ['sx', 'sy', 'ex', 'ey']) {
					if (!Number.isInteger(f[k])) fail(`${el.name}/${d}: ${k} = ${f[k]} is not an integer`);
				}
				if (!['0', '90', '180', '270'].includes(f.rot)) fail(`${el.name}/${d}: rot = ${f.rot}`);
			}
		}
		walk(el.children, depth + 1);
	}
};
for (const root of config.elements) walk(root.children, 0);

// 2. Viewer limits. Not a format error, but the model simply will not be shown.
if (boxCount > 256) notes.push(`cubes ${boxCount} — above the default MAX_CUBE_COUNT=256, only friends will see it`);
if (Math.max(texW, texH) > 256) notes.push(`image ${texW}×${texH} — above the default MAX_TEX_SHEET_SIZE=256`);

// 3. Geometry. The CPM renderer's transform is repeated and the box corners compared.
const rad = d => d * Math.PI / 180;
function rotZYX(r) {
	const [x, y, z] = [rad(r.x), rad(r.y), rad(r.z)];
	const cx = Math.cos(x), sx = Math.sin(x);
	const cy = Math.cos(y), sy = Math.sin(y);
	const cz = Math.cos(z), sz = Math.sin(z);
	const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
	const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
	const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
	return matMul3(Rz, matMul3(Ry, Rx));
}
function matMul3(a, b) {
	const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
		o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
	}
	return o;
}
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function apply3(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

// Expected: the box corners in Blockbench, converted into CPM coordinates.
// Matching by name is impossible: this model has 108 meshes and almost all are called
// "cube". So boxes are matched by centre — they stand in different places.
const expected = [];
for (const c of cubes) {
	const place = placeCoords(c.sol);
	const half = c.sol.size.map(v => Math.abs(v) / 2);
	const from = place(c.sol.center.map((v, i) => v - half[i]));
	const to = place(c.sol.center.map((v, i) => v + half[i]));
	const center = from.map((v, i) => (v + to[i]) / 2);
	const size = from.map((v, i) => Math.abs(to[i] - v));
	const pts = [];
	for (const sxx of [-1, 1]) for (const syy of [-1, 1]) for (const szz of [-1, 1]) {
		const d = [sxx * size[0] / 2, syy * size[1] / 2, szz * size[2] / 2];
		const w = [
			center[0] + c.sol.vx[0] * d[0] + c.sol.vy[0] * d[1] + c.sol.vz[0] * d[2],
			center[1] + c.sol.vx[1] * d[0] + c.sol.vy[1] * d[1] + c.sol.vz[1] * d[2],
			center[2] + c.sol.vx[2] * d[0] + c.sol.vy[2] * d[1] + c.sol.vz[2] * d[2],
		];
		// the expectation is shifted too: the alignment moves the whole model
		pts.push(add3(cpmPoint(w), align));
	}
	expected.push({ name: c.name, pts });
}

// Actual: the tree run along the same path as the renderer.
function collectBoxes(cfg) {
	const out = [];
	const render = (list, base, rot) => {
		for (const el of list || []) {
			const p = apply3(rot, [el.pos.x, el.pos.y, el.pos.z]);
			const origin = [base[0] + p[0], base[1] + p[1], base[2] + p[2]];
			const R = matMul3(rot, rotZYX(el.rotation));
			if (el.size.x || el.size.y || el.size.z) {
				const pts = [];
				for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
					const local = [
						el.offset.x + i * el.size.x,
						el.offset.y + j * el.size.y,
						el.offset.z + k * el.size.z,
					];
					const w = apply3(R, local);
					pts.push([origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]]);
				}
				out.push({ name: el.name, pts });
			}
			render(el.children, origin, R);
		}
	};
	for (const root of cfg.elements) {
		const pivot = CPM_PARTS[root.id];
		if (!pivot) continue;
		const base = [pivot[0] + root.pos.x, pivot[1] + root.pos.y, pivot[2] + root.pos.z];
		render(root.children, base, rotZYX(root.rotation));
	}
	return out;
}
const got = collectBoxes(config);

// The scale slider is a separate factor on top of the parse. It is checked on the
// final geometry, not on the element fields: some bones are measured from the
// FIXED player pivot, so their pos must not double. The model
// must grow from the ground, i.e. from the point y = 24 in CPM coordinates.
{
	// without alignment on both sides: the uniformity of the scale is checked, and the shift
	// depends on it non-linearly and is beside the point
	const plain = k => buildCPMFiles({
		hierarchy: parsed.hierarchy, cubes, assign, keepNodes: animated, scale: k,
		align: [0, 0, 0], uvMul: uv.mul, texWidth: texW, texHeight: texH,
		uvWidth: texW * uv.mul, uvHeight: texH * uv.mul,
	}).config;
	const one = collectBoxes(plain(1));
	const big = collectBoxes(plain(2));
	let bad = 0, worstK = 0;
	if (big.length !== one.length) bad++;
	else for (let i = 0; i < one.length; i++) {
		for (let v = 0; v < 8; v++) {
			// into source coordinates: there the scaling is uniform about zero
			const a = [-one[i].pts[v][0], 24 - one[i].pts[v][1], one[i].pts[v][2]];
			const b = [-big[i].pts[v][0], 24 - big[i].pts[v][1], big[i].pts[v][2]];
			for (let ax = 0; ax < 3; ax++) worstK = Math.max(worstK, Math.abs(b[ax] - a[ax] * 2));
		}
	}
	if (bad || worstK > 0.01) fail(`the scale is not uniform: a divergence of ${worstK.toFixed(4)} px at k=2`);
	notes.push(`the scale is uniform: at k=2 the deviation is ${worstK.toExponential(2)} px`);
}

// Corners are a set; our traversal order and the renderer's differ.
function worstMismatch(a, b) {
	let worst = 0;
	for (const p of a) {
		let best = Infinity;
		for (const q of b) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
		worst = Math.max(worst, best);
	}
	return worst;
}

const centroid = pts => pts.reduce((a, p) => [a[0] + p[0] / 8, a[1] + p[1] / 8, a[2] + p[2] / 8], [0, 0, 0]);
for (const e of [...expected, ...got]) e.mid = centroid(e.pts);

let checked = 0, worstAll = 0, worstName = '';
const missing = [];
if (expected.length !== got.length) {
	fail(`boxes in the CPM tree ${got.length}, but source ones ${expected.length}`);
}
const taken = new Array(got.length).fill(false);
for (const e of expected) {
	let best = -1, bestD = Infinity;
	for (let i = 0; i < got.length; i++) {
		if (taken[i]) continue;
		const d = Math.hypot(e.mid[0] - got[i].mid[0], e.mid[1] - got[i].mid[1], e.mid[2] - got[i].mid[2]);
		if (d < bestD) { bestD = d; best = i; }
	}
	if (best < 0) { missing.push(e.name); continue; }
	taken[best] = true;
	const d = worstMismatch(e.pts, got[best].pts);
	checked++;
	if (d > worstAll) { worstAll = d; worstName = e.name; }
}
if (missing.length) fail(`not found in the CPM tree: ${missing.length} (${missing.slice(0, 5).join(', ')})`);
// The tolerance is the rounding we introduce ourselves: pos and offset to 4 digits,
// angles to a hundredth of a degree. On a 20 px arm a hundredth of a degree gives ~0.004 px.
const TOL = 0.02;
if (worstAll > TOL) fail(`the geometry diverged: up to ${worstAll.toFixed(4)} px (${worstName})`);

// 4. Animations. The pose is assembled from our keyframes the way CPM will assemble it, and
// compared with the true pose from glTF — the same one as in tools/verify-animation.mjs.
// This is the only check that catches mixed-up axes in keyframe rotations:
// the keyframes on their own look plausible with any sign.
const animFiles = Object.keys(built.files).filter(n => n.startsWith('animations/'));
let animChecked = 0, animWorst = 0, animWhere = '';
{
	const byIdx = new Map(parsed.hierarchy.map(h => [h.index, h]));
	const chainOf = h => { const c = []; for (let n = h; n; n = n.parent >= 0 ? byIdx.get(n.parent) : null) c.unshift(n); return c; };
	// where each bone's element ended up — by storeID
	const elemByStore = new Map();
	const walkEl = (list, part) => (list || []).forEach(e => {
		elemByStore.set(e.storeID, e);
		walkEl(e.children, part);
	});
	config.elements.forEach(r => walkEl(r.children, r.id));
	const storeOfNode = new Map();
	{
		// bone elements go in the same order as in the tree, so they are looked up by name
		// and position: more reliable would be to match by storeID from the build
		const b = plugin.buildCPMConfig({
			hierarchy: parsed.hierarchy, cubes, assign, keepNodes: animated,
			uvMul: uv.mul, scale: 1,
		});
		for (const [node, el] of Object.entries(b.elemByNode)) storeOfNode.set(Number(node), el.storeID);
	}

	for (const name of animFiles) {
		const data = JSON.parse(built.files[name]);
		const src = parsed.animations.find(a => a.name === data.name);
		if (!src || !data.frames.length) continue;

		for (let fi = 0; fi < data.frames.length; fi++) {
			const t = src.length < 1e-6 ? 0 : (fi / data.frames.length) * src.length;

			// the truth: world positions of the nodes from the glTF itself
			const at = {};
			for (const ch of src.channels) (at[ch.node] = at[ch.node] || {})[ch.path] = plugin.sampleChannel(ch, t);
			const truth = {};
			for (const h of parsed.hierarchy) {
				let m = plugin.matIdentity();
				for (const n of chainOf(h)) {
					const o = at[n.index] || {};
					m = plugin.matMul(m, plugin.matFromTRS(
						o.translation || n.rest.translation,
						o.rotation || n.rest.rotation,
						n.rest.scale));
				}
				// exactly the way parseGLTFFiles places pivots: scale and the centring
				// shift, otherwise the "truth" differs by a constant vector
				truth[h.index] = plugin.matApply(m, [0, 0, 0]).map((v, i) => v * scale + offset[i]);
			}

			// ours: the same chain, but assembled from the keyframe by CPM's rules —
			// shift by pos, then rotation, and so on down the tree
			const frame = new Map();
			for (const c of data.frames[fi].components) frame.set(c.storeID, c);

			for (const h of parsed.hierarchy) {
				if (!at[h.index]) continue;
				const store = storeOfNode.get(h.index);
				if (store === undefined) continue;
				let base = null, rot = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
				// find the root part this bone sits under
				for (const root of config.elements) {
					const pivot = CPM_PARTS[root.id];
					const found = (function seek(list, origin, R) {
						for (const el of list || []) {
							const p = apply3(R, [el.pos.x, el.pos.y, el.pos.z]);
							// a keyframe replaces pos and rotation of the elements it touches
							const f = frame.get(el.storeID);
							const usePos = f ? [f.pos.x, f.pos.y, f.pos.z] : [el.pos.x, el.pos.y, el.pos.z];
							const useRot = f ? f.rotation : el.rotation;
							const pp = apply3(R, usePos);
							const o2 = [origin[0] + pp[0], origin[1] + pp[1], origin[2] + pp[2]];
							const R2 = matMul3(R, rotZYX(useRot));
							if (el.storeID === store) return { origin: o2, R: R2 };
							const deeper = seek(el.children, o2, R2);
							if (deeper) return deeper;
							void p;
						}
						return null;
					})(root.children, [pivot[0] + root.pos.x, pivot[1] + root.pos.y, pivot[2] + root.pos.z], rot);
					if (found) { base = found.origin; break; }
				}
				if (!base) continue;
				// back into source coordinates, to compare with the truth;
				// the alignment with the player skeleton is removed first
				const got = [-(base[0] - align[0]), 24 - (base[1] - align[1]), base[2] - align[2]];
				const want = truth[h.index];
				const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
				animChecked++;
				if (err > animWorst) { animWorst = err; animWhere = `${data.name}/${h.name} frame ${fi}`; }
			}
		}
	}
}
// The tolerance means the same as for geometry: keyframes rounded to 4 digits
// and angles to a hundredth of a degree on an arm tens of pixels long.
if (animChecked && animWorst > 0.05) fail(`the pose from the animation diverged: up to ${animWorst.toFixed(4)} px (${animWhere})`);
if (!animChecked) fail('animations not checked: not a single pose was assembled');

// ------------------------------------------------------------------- output

const usedParts = Object.entries(built.stats.parts).filter(([, n]) => n > 0);
console.log(`model:         ${gltfPath}`);
console.log(`scale:         ×${scale.toFixed(3)} — height ${(heightUnits * scale).toFixed(1)} px${SCALE ? ' (set)' : ' (to the player)'}`);
console.log(`cubes:         ${cubes.length}${approximated ? ` (approximated with a box: ${approximated})` : ''}`);
console.log(`bones:         ${built.stats.bones} of ${parsed.hierarchy.length}`);
console.log(`elements:      ${elemCount}, with geometry ${boxCount}`);
console.log(`player parts:  ${usedParts.map(([p, n]) => `${p}=${n}`).join(', ') || '—'}`);
console.log(`UV grid:       ${texW * uv.mul}×${texH * uv.mul} (×${uv.mul}) for an image of ${texW}×${texH}`
	+ (uv.exact ? ', exact' : `, off by up to ${uv.worst.toFixed(3)} px`));
console.log(`faces with UV: ${uvFaces}`);
{
	// How well the bones settled on the vanilla pivots after alignment. A remainder of
	// a few pixels is unavoidable: an imported character has shoulders and hips
	// where its author put them, not where Minecraft has them.
	console.log(`alignment:     shift [${align.map(v => v.toFixed(1)).join(', ')}] px`);
	const rows = [];
	for (const h of parsed.hierarchy) {
		const part = assign[h.index];
		if (!part || !CPM_PARTS[part]) continue;
		const c = add3(cpmPoint(h.pivot), align);
		const w = CPM_PARTS[part];
		rows.push(`${h.name}→${part} ${Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2]).toFixed(1)}`);
	}
	console.log(`  remainder per bone, px: ${rows.join(', ')}`);
}
console.log(`corners checked: ${checked} boxes, worst divergence ${worstAll.toExponential(2)} px`);
console.log(`animations:    ${built.stats.anim.animations} of ${parsed.animations.length}, `
	+ `${built.stats.anim.frames} frames, ${built.stats.anim.components} records`);
console.log(`poses checked: ${animChecked}, worst divergence ${animWorst.toExponential(2)} px`
	+ (animWhere ? ` (${animWhere})` : ''));
{
	const s = built.stats.size, kb = n => (n / 1024).toFixed(1);
	console.log(`size in game:  ~${kb(s.total)} kB (model ${kb(s.cubes)}, animations ${kb(s.anim)}, `
		+ `texture ${kb(s.texture)}) against a 30 kB budget for a local .cpmmodel`);
}
for (const a of parsed.animations) {
	console.log(`  ${a.name.padEnd(16)} → ${poses[a.name] === 'gesture' ? 'gesture' : 'pose ' + poses[a.name]}`);
}
for (const w of built.warnings) console.log(`  build: ${w}`);
for (const n of notes) console.log(`  note: ${n}`);

if (writeAt) {
	fs.writeFileSync(writeAt, zipStore(built.files));
	console.log(`written:       ${writeAt}`);
}

if (problems.length) {
	console.log('');
	console.log(`FAILED: ${problems.length}`);
	for (const p of problems.slice(0, 20)) console.log('  ' + p);
	process.exit(1);
}
console.log('');
console.log('OK');

// ------------------------------------------------------- writing .cpmproject

/**
 * A ZIP with deflate compression — the same way CPM itself writes it. Animation keyframes are
 * snapshots of every movable bone, i.e. bulky and repetitive JSON, which is
 * exactly where deflate pays off: without compression the archive came out at 1.7 MB.
 *
 * Our own writer rather than a dependency: the ZIP format takes fifty lines here,
 * and zlib is already in Node.
 */
function zipStore(map) {
	const enc = new TextEncoder();
	const entries = Object.entries(map).map(([name, data]) => {
		const raw = typeof data === 'string' ? Buffer.from(enc.encode(data)) : Buffer.from(data);
		const packed = zlib.deflateRawSync(raw, { level: 9 });
		// Compression is applied only if it actually helped: on PNG an inflated
		// result is common.
		const useDeflate = packed.length < raw.length;
		return { name, raw, data: useDeflate ? packed : raw, method: useDeflate ? 8 : 0 };
	});
	const local = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const nameBytes = Buffer.from(e.name, 'utf8');
		// The CRC is computed over the ORIGINAL bytes, not the compressed ones
		const crc = crc32(e.raw);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(0, 6);
		head.writeUInt16LE(e.method, 8);
		head.writeUInt16LE(0, 10);
		head.writeUInt16LE(0, 12);
		head.writeUInt32LE(crc >>> 0, 14);
		head.writeUInt32LE(e.data.length, 18);
		head.writeUInt32LE(e.raw.length, 22);
		head.writeUInt16LE(nameBytes.length, 26);
		head.writeUInt16LE(0, 28);
		local.push(head, nameBytes, e.data);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(e.method, 10);
		cen.writeUInt32LE(crc >>> 0, 16);
		cen.writeUInt32LE(e.data.length, 20);
		cen.writeUInt32LE(e.raw.length, 24);
		cen.writeUInt16LE(nameBytes.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBytes);

		offset += 30 + nameBytes.length + e.data.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBuf, end]);
}

function crc32(buf) {
	let c, table = crc32.table;
	if (!table) {
		table = crc32.table = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c;
		}
	}
	let crc = -1;
	for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
	return (crc ^ -1) >>> 0;
}
