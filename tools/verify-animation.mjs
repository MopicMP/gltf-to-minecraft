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
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../plugin/gltf_to_minecraft.js');
const { matMul, matFromTRS, matApply, matIdentity, boneDeltaRotation, boneDeltaPosition } = M;

const wantAnim = process.argv[2] || null;
const wantTime = process.argv[3] !== undefined ? +process.argv[3] : 0;

const parsed = M.parseGLTFFiles(
	{ 'm.gltf': new Uint8Array(fs.readFileSync('model(gltf)/source/model.gltf')) },
	{ scale: 16, uvWidth: 128, uvHeight: 128 });

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
			truth[h.index] = matApply(m, [0, 0, 0]).map(v => v * 16);
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
								? matFromTRS(boneDeltaPosition(n.rest, n.parentQuat, o.translation, mode, dRot), [0, 0, 0, 1], [1, 1, 1])
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
console.log('Summary across all animations and 6 moments in time:');
console.log('');
console.log('build  mode      formula      worst miss     where');
for (const [key, v] of rows) {
	const tag = v.worst < 0.01 ? '✅' : v.worst < 1 ? '  ' : '❌';
	console.log(`${tag} ${key}  ${v.worst.toFixed(3).padStart(10)} px  ${v.where}`);
}
console.log('');
