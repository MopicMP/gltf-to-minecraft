/**
 * Adding a model to an open project: where its texture goes and what its
 * folders and animations are called.
 *
 * What is checked:
 *   - beside or below: the old texture keeps its corner, the sheet stays as small
 *     as it can, and on a tie the squarer one wins;
 *   - every way the texture can join a project gives UV that land where the
 *     atlas was put, at the size the project measures in;
 *   - names never repeat one already in use, and file names become folder names.
 *
 * The Blockbench side (undo, the drawing, the outliner) runs in
 * tools/smoke-plugin.mjs.
 *
 * Run: node tools/verify-add-to-project.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { placeBeside, texturePlan, placeRect, uniqueName, nameSlug } = require('../plugin/gltf_to_minecraft.js');

let failed = 0;
const check = (label, ok, detail) => {
	if (!ok) failed++;
	console.log(`${ok ? 'OK ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('--- beside or below');
{
	// 64×64 plus 64×32: below is 64×96, beside would be 128×64 — below is smaller
	const r = placeBeside([64, 64], [64, 32]);
	check('a wide strip goes under a square', same(r, { x: 0, y: 64, width: 64, height: 96 }), JSON.stringify(r));
}
{
	// 64×32 plus 32×32: beside fills the height exactly, 96×32
	const r = placeBeside([64, 32], [32, 32]);
	check('a square goes beside a wide sheet', same(r, { x: 64, y: 0, width: 96, height: 32 }), JSON.stringify(r));
}
{
	// equal areas either way; beside is 192×128 and below 128×192, both 1.5 long
	const r = placeBeside([64, 64], [128, 128]);
	check('a tie of area and shape goes beside', r.x === 64 && r.y === 0 && r.width === 192 && r.height === 128, JSON.stringify(r));
}
{
	// 128×16 plus 16×16: beside 144×16 (2304) against below 128×32 (4096)
	const r = placeBeside([128, 16], [16, 16]);
	check('the smaller sheet wins even when it is longer', same(r, { x: 128, y: 0, width: 144, height: 16 }), JSON.stringify(r));
}
for (const [base, add] of [[[64, 64], [64, 32]], [[16, 16], [128, 64]], [[64, 32], [32, 32]], [[48, 80], [80, 48]]]) {
	const r = placeBeside(base, add);
	const oldKept = r.width >= base[0] && r.height >= base[1];
	const newFits = r.x + add[0] <= r.width && r.y + add[1] <= r.height;
	const apart = r.x >= base[0] || r.y >= base[1];
	check(`${base.join('×')} + ${add.join('×')}: both fit and do not overlap`, oldKept && newFits && apart, JSON.stringify(r));
}

console.log('');
console.log('--- where the UV land');
const rect = { x: 32, y: 16, w: 32, h: 16 };
{
	const p = texturePlan('fresh', null, [128, 64]);
	check('fresh: the project takes the atlas size', same(p.projectSize, [128, 64]) && same(placeRect(rect, p), rect), JSON.stringify(p));
}
{
	const p = texturePlan('own', [16, 16], [128, 64]);
	check('own: the atlas keeps its size, the project keeps its own',
		p.projectSize === null && same(p.uvSize, [128, 64]) && same(placeRect(rect, p), rect), JSON.stringify(p));
}
{
	const p = texturePlan('shared', [16, 16], [128, 64]);
	const r = placeRect(rect, p);
	check('shared: UV squeezed into the project size', p.projectSize === null && same(p.uvSize, [16, 16])
		&& same(r, { x: 4, y: 4, w: 4, h: 4 }), JSON.stringify(r));
}
{
	const p = texturePlan('beside', [64, 64], [64, 32]);
	const r = placeRect(rect, p);
	check('beside: UV moved to where the atlas went, the project grown', same(p.projectSize, [64, 96])
		&& same(r, { x: 32, y: 80, w: 32, h: 16 }), JSON.stringify({ p, r }));
}
check('no rectangle stays none', placeRect(undefined, texturePlan('fresh', null, [16, 16])) === undefined);

console.log('');
console.log('--- names');
check('a free name is kept', uniqueName('arm', new Set(['body'])) === 'arm');
check('a taken name gets the first free number', uniqueName('arm', new Set(['arm', 'arm_2'])) === 'arm_3');
check('a file name becomes a folder name', nameSlug('Iron Sword (1).zip') === 'iron_sword_1', nameSlug('Iron Sword (1).zip'));
check('the archive of the test fixture', nameSlug('model(gltf).zip') === 'model_gltf', nameSlug('model(gltf).zip'));
check('nothing usable gives "model"', nameSlug('(((.zip') === 'model' && nameSlug('') === 'model');

console.log('');
console.log(failed ? `❌ ${failed} FAILED` : '✅ ALL PASSED');
process.exit(failed ? 1 : 0);
