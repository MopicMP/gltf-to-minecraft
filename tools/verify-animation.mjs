/**
 * Checks the animation maths WITHOUT Blockbench.
 *
 * Assembles the pose the way Blockbench will assemble it from our keyframes, and
 * compares it with the true pose from glTF. All it takes is plain arithmetic, so
 * a mistake shows up here rather than after yet another "import and look" round.
 *
 * The model in Blockbench: bones sit with zero rotation, the rest pose is baked
 * into world coordinates, and a keyframe sets an offset. A bone rotation is applied
 * AROUND ITS PIVOT, and nested bones are multiplied together.
 *
 * Run: node tools/verify-animation.mjs [animation name] [time]
 * from a folder holding model(gltf)/source/model.gltf, or with MODEL=<file.gltf>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../plugin/gltf_to_minecraft.js');
const { matMul, matFromTRS, matApply, matIdentity, boneDeltaRotation, boneDeltaPosition } = M;

const wantAnim = process.argv[2] || null;
const wantTime = process.argv[3] !== undefined ? +process.argv[3] : 0;

// MODEL names another .gltf; the .bin files beside it come along
const modelFile = process.env.MODEL || 'model(gltf)/source/model.gltf';
const files = { [path.basename(modelFile)]: new Uint8Array(fs.readFileSync(modelFile)) };
for (const f of fs.readdirSync(path.dirname(modelFile))) {
	if (f.endsWith('.bin')) files[f] = new Uint8Array(fs.readFileSync(path.join(path.dirname(modelFile), f)));
}
// Pixels per glTF unit. Not 16 on purpose: the plugin builds a model at the size
// it picks, and the offsets once had 16 written into them. Measured at 16, as it
// was, the tool agreed with that mistake while a model built at x8 fell apart.
const SCALE = +(process.env.SCALE || 12);
const parsed = M.parseGLTFFiles(files, { scale: SCALE, uvWidth: 128, uvHeight: 128 });

const byIdx = new Map(parsed.hierarchy.map(h => [h.index, h]));
const chainOf = h => { const c = []; for (let n = h; n; n = n.parent >= 0 ? byIdx.get(n.parent) : null) c.unshift(n); return c; };

/** Channel value at time t (linear interpolation, as in glTF). */
function sample(ch, t) {
	const { times, values } = ch;
	if (t <= times[0]) return values[0];
	if (t >= times[times.length - 1]) return values[values.length - 1];
	let i = 0;
	while (i + 1 < times.length && times[i + 1] < t) i++;
	const k = (t - times[i]) / (times[i + 1] - times[i]);
	const a = values[i], b = values[i + 1];
	const out = a.map((v, j) => v + (b[j] - v) * k);
	if (ch.path === 'rotation') {   // quaternions are normalised
		const len = Math.hypot(...out);
		return out.map(v => v / len);
	}
	return out;
}

/** Rotation matrix about a point: T(p) · R(q) · T(−p). */
function rotateAround(pivot, q) {
	const T = p => matFromTRS(p, [0, 0, 0, 1], [1, 1, 1]);
	return matMul(matMul(T(pivot), matFromTRS([0, 0, 0], q, [1, 1, 1])), T(pivot.map(v => -v)));
}

const MODES = ['local', 'model', 'absolute', 'skip', 'rt'];
// How Blockbench combines an offset with a bone rotation is unknown to us:
// 'TR' — the offset outside (like a THREE local matrix), 'RT' — the offset inside
// the rotation. What has to be written depends on it.
const COMPOSE = ['TR', 'RT'];
const ORDERS = [false, true];   // preMultiply

// Summed over ALL animations and several moments in time: on one animation at
// one point the right combination cannot be told apart — half of the variants
// give zero by coincidence.
const TIMES = [0, 0.17, 0.33, 0.5, 0.75, 1.0];
const totals = new Map();

for (const anim of parsed.animations) {
	if (wantAnim && anim.name !== wantAnim) continue;
	for (const time of TIMES) {
		const at = {};
		for (const ch of anim.channels) (at[ch.node] = at[ch.node] || {})[ch.path] = sample(ch, time * Math.max(anim.length, 1e-6));

		const truth = {};
		for (const h of parsed.hierarchy) {
			let m = matIdentity();
			for (const n of chainOf(h)) {
				const o = at[n.index] || {};
				m = matMul(m, matFromTRS(o.translation || n.rest.translation, o.rotation || n.rest.rotation, n.rest.scale));
			}
			truth[h.index] = matApply(m, [0, 0, 0]).map(v => v * SCALE);
		}

		for (const compose of COMPOSE) {
			for (const preMul of ORDERS) {
				for (const mode of MODES) {
					const key = `${compose} ${mode.padEnd(9)} ${preMul ? 'R0inv*R' : 'R*R0inv'}`;
					let worst = totals.get(key) || { worst: 0, where: '' };
					for (const h of parsed.hierarchy) {
						let m = matIdentity();
						for (const n of chainOf(h)) {
							const o = at[n.index];
							if (!o) continue;
							const dRot = o.rotation ? boneDeltaRotation(n.rest, n.parentQuat, o.rotation, preMul) : [0, 0, 0, 1];
							const T = o.translation && mode !== 'skip'
								? matFromTRS(boneDeltaPosition(n.rest, n.parentQuat, o.translation, mode, dRot, parsed.space.scale), [0, 0, 0, 1], [1, 1, 1])
								: matIdentity();
							const R = o.rotation ? rotateAround(n.pivot, dRot) : matIdentity();
							m = matMul(m, compose === 'TR' ? matMul(T, R) : matMul(R, T));
						}
						const got = matApply(m, h.pivot), want = truth[h.index];
						const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
						if (err > worst.worst) worst = { worst: err, where: `${anim.name}/${h.name}` };
					}
					totals.set(key, worst);
				}
			}
		}
	}
}

const rows = [...totals.entries()].sort((a, b) => a[1].worst - b[1].worst);
console.log('');
console.log(`Summary across all animations and 6 moments in time, at x${SCALE}:`);
console.log('');
console.log('build  mode      formula      worst miss     where');
for (const [key, v] of rows) {
	const tag = v.worst < 0.01 ? 'PASS' : v.worst < 1 ? '    ' : 'FAIL';
	console.log(`${tag} ${key}  ${v.worst.toFixed(3).padStart(10)} px  ${v.where}`);
}
console.log('');

// ------------------------------------------------ playback between keyframes
//
// The table above takes the glTF pose at a moment and converts it on the spot,
// so it says nothing of what Blockbench draws BETWEEN keyframes, where it eases
// each Euler angle in a straight line. Nor does a pivot show a bone turning
// about itself. Here the keyframes are made by the plugin's own functions,
// kept on the animation's grid the way Blockbench keeps them, played back the
// way it plays them, and every corner of every part is compared with glTF at
// many moments.

const { sampleChannel, rotationKeyframes, rotationTolerance, boneReach, boneScale, quatFromEuler, keyframeGrid } = M;
const ORDER = 'ZYX';
const RAD = Math.PI / 180;

/** glTF's own reading of a channel, written here a second time: slerp for rotations. */
function truthAt(ch, t) {
	const { times, values } = ch;
	if (t <= times[0]) return values[0];
	if (t >= times[times.length - 1]) return values[values.length - 1];
	let i = 0;
	while (i + 1 < times.length && times[i + 1] < t) i++;
	if (ch.interpolation === 'STEP') return values[i];
	const k = (t - times[i]) / (times[i + 1] - times[i]);
	const a = values[i];
	let b = values[i + 1];
	if (ch.path !== 'rotation') return a.map((v, j) => v + (b[j] - v) * k);
	let d = a.reduce((s, v, j) => s + v * b[j], 0);
	if (d < 0) { b = b.map(v => -v); d = -d; }
	if (d > 0.9999) return a.map((v, j) => v + (b[j] - v) * k);
	const th = Math.acos(d), s = Math.sin(th);
	return a.map((v, j) => (v * Math.sin((1 - k) * th) + b[j] * Math.sin(k * th)) / s);
}

/** A track of keyframes [{ t, v }] at time t, eased the way Blockbench eases it. */
function playAt(keys, t, step) {
	if (t <= keys[0].t) return keys[0].v;
	if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
	let i = 0;
	while (i + 1 < keys.length && keys[i + 1].t < t) i++;
	if (step) return keys[i].v;
	const k = (t - keys[i].t) / (keys[i + 1].t - keys[i].t);
	return keys[i].v.map((v, j) => v + (keys[i + 1].v[j] - v) * k);
}

function invertAffine(m) {
	const [a, b, c, , d, e, f, , g, h, i] = m;
	const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
	const r = [
		(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0,
		(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
		(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0,
		0, 0, 0, 1,
	];
	const t = matApply(r, [m[12], m[13], m[14]]);
	r[12] = -t[0]; r[13] = -t[1]; r[14] = -t[2];
	return r;
}

/**
 * What Blockbench keeps of keyframes created one after another on a grid of
 * `rate` a second: each moved onto the grid, and one landing where another
 * stands takes its place. Written here a second time, as Timeline.snapTime and
 * Keyframe.replaceOthers do it, so that a plugin writing off the grid shows.
 */
function kept(keys, rate) {
	const slot = new Map();
	for (const k of keys) slot.set(Math.round(k.t * rate), { t: Math.round(k.t * rate) / rate, v: k.v });
	return [...slot.values()].sort((a, b) => a.t - b.t);
}

/**
 * Keyframes for one animation, as they stand in Blockbench: the plugin's way, or
 * each keyframe on its own, scale left out and the animation on Blockbench's
 * default grid of 24 a second, as before.
 */
function tracksFor(anim, naive) {
	const tracks = {};
	const grid = keyframeGrid(anim.channels.flatMap(c => [...c.times]));
	const rate = naive ? 24 : grid.fine;
	for (const src of anim.channels) {
		const ch = naive ? src : grid.channel(src);
		const n = byIdx.get(ch.node);
		if (!n) continue;
		const tr = tracks[ch.node] = tracks[ch.node] || {};
		if (ch.path === 'rotation') {
			const toDelta = q => boneDeltaRotation(n.rest, n.parentQuat, q, false);
			tr.rotation = kept(naive
				? ch.times.map(t => ({ t, v: M.eulerFromQuat(toDelta(sampleChannel(ch, t)), ORDER).map(v => v / RAD) }))
				: rotationKeyframes(ch, toDelta, ORDER, ch.times, rotationTolerance(reach[ch.node]), grid.fine).map(k => ({ t: k.t, v: k.e })), rate);
		} else if (ch.path === 'translation') {
			tr.translation = kept(ch.times.map(t => ({ t, v: boneDeltaPosition(n.rest, n.parentQuat, sampleChannel(ch, t), 'model', null, parsed.space.scale) })), rate);
		} else if (ch.path === 'scale' && !naive) {
			tr.scale = kept(ch.times.map(t => {
				const s = boneScale(n.rest, n.parentQuat, sampleChannel(ch, t));
				if (!s.exact) slanted.add(ch.node);
				return { t, v: s.scale };
			}), rate);
		}
		tr[ch.path + 'Step'] = ch.interpolation === 'STEP';
	}
	return tracks;
}

const reach = boneReach(parsed.hierarchy, parsed.objects);
// bones scaled along axes slanted at rest: the plugin can only come close there,
// and says so in its report, so what hangs off them is measured apart
const slanted = new Set();

// the corners of every part, at most 64 to a part
const parts = parsed.hierarchy.filter(h => h.objectIndex >= 0).map(h => {
	const seen = new Map();
	for (const f of parsed.objects[h.objectIndex].faces) for (const p of f.positions) seen.set(p.join(','), p);
	return { h, points: [...seen.values()].slice(0, 64) };
});
const restWorld = new Map();
for (const h of parsed.hierarchy) {
	let m = matIdentity();
	for (const n of chainOf(h)) m = matMul(m, matFromTRS(n.rest.translation, n.rest.rotation, n.rest.scale));
	restWorld.set(h.index, m);
}
const scaleBy = (m, k) => matMul(matFromTRS([0, 0, 0], [0, 0, 0, 1], [k, k, k]), matMul(m, matFromTRS([0, 0, 0], [0, 0, 0, 1], [1 / k, 1 / k, 1 / k])));

console.log('Playback between keyframes, every corner of every part:');
console.log('');
for (const naive of [true, false]) {
	let worst = 0, where = '', keys = 0, rough = 0, roughWhere = '', shifted = 0, shiftedWhere = '';
	for (const anim of parsed.animations) {
		if (wantAnim && anim.name !== wantAnim) continue;
		const tracks = tracksFor(anim, naive);
		// glTF times no grid of Blockbench's holds: the plugin moves them a step at
		// most and says so in its report, so the moments around them are measured apart
		const grid = keyframeGrid(anim.channels.flatMap(c => [...c.times]));
		const moved = naive ? [] : anim.channels.flatMap(c => [...c.times]).filter(t => Math.abs(Math.round(t * grid.fine) / grid.fine - t) > 1e-4);
		const nearMoved = t => moved.some(m => Math.abs(m - t) < 1 / grid.fine);
		for (const tr of Object.values(tracks)) keys += (tr.rotation || []).length;
		const length = Math.max(anim.length, 1e-6);
		const samples = Math.min(400, Math.max(60, Math.ceil(length * 30)));
		for (let s = 0; s <= samples; s++) {
			const t = length * s / samples;
			const at = {};
			for (const ch of anim.channels) (at[ch.node] = at[ch.node] || {})[ch.path] = truthAt(ch, t);
			for (const { h, points } of parts) {
				let truth = matIdentity(), drawn = matIdentity();
				for (const n of chainOf(h)) {
					const o = at[n.index] || {};
					truth = matMul(truth, matFromTRS(o.translation || n.rest.translation, o.rotation || n.rest.rotation, o.scale || n.rest.scale));
					const tr = tracks[n.index];
					if (!tr) continue;
					const T = tr.translation ? matFromTRS(playAt(tr.translation, t, tr.translationStep), [0, 0, 0, 1], [1, 1, 1]) : matIdentity();
					const q = tr.rotation ? quatFromEuler(playAt(tr.rotation, t, tr.rotationStep).map(v => v * RAD), ORDER) : [0, 0, 0, 1];
					const S = tr.scale ? playAt(tr.scale, t, tr.scaleStep) : [1, 1, 1];
					const around = matMul(matMul(matFromTRS(n.pivot, [0, 0, 0, 1], [1, 1, 1]), matFromTRS([0, 0, 0], q, S)), matFromTRS(n.pivot.map(v => -v), [0, 0, 0, 1], [1, 1, 1]));
					drawn = matMul(drawn, matMul(T, around));
				}
				// glTF in pixels: from the rest pose to this moment
				const move = scaleBy(matMul(truth, invertAffine(restWorld.get(h.index))), SCALE);
				const close = !naive && chainOf(h).some(n => slanted.has(n.index));
				const off = nearMoved(t);
				for (const p of points) {
					const want = matApply(move, p), got = matApply(drawn, p);
					const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
					if (off) { if (err > shifted) { shifted = err; shiftedWhere = `${anim.name}/${h.name} at ${t.toFixed(3)} s`; } }
					else if (close) { if (err > rough) { rough = err; roughWhere = `${anim.name}/${h.name} at ${t.toFixed(3)} s`; } }
					else if (err > worst) { worst = err; where = `${anim.name}/${h.name} at ${t.toFixed(3)} s`; }
				}
			}
		}
	}
	// Each bone keeps within PLAYBACK_TOLERANCE of its own arc, but a part at the
	// end of a chain carries the strays of every bone above it; on the animated
	// models at hand that came to under four times the tolerance.
	const tag = worst < 0.25 ? 'PASS' : worst < 1 ? '    ' : 'FAIL';
	console.log(`${tag} ${naive ? 'each keyframe on its own, no scale, 24/s' : 'the plugin                             '}  ${worst.toFixed(3).padStart(10)} px  rotation keyframes ${keys}  ${where}`);
	if (rough) console.log(`     under a scale slanted at rest             ${rough.toFixed(3).padStart(10)} px  ${roughWhere}`);
	if (shifted) console.log(`     a step from a keyframe moved onto grid    ${shifted.toFixed(3).padStart(10)} px  ${shiftedWhere}`);
}
console.log('');
