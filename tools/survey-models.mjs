/**
 * A survey of the collection: what the importer will do with each model in test/model.
 *
 * Not a check — there is no "correct" answer here. It is a summary of the whole
 * folder, to see where a model falls apart and where it comes through whole,
 * without opening Blockbench for each one.
 *
 * The path follows buildFromFiles step by step: glTF parsing -> splitting merged
 * meshes into connected parts -> dropping degenerate fragments -> solveBox on each.
 * It follows rather than imitates: parseGLTFFiles, splitComponents and solveBox
 * all come from the plugin itself.
 *
 * Run: node tools/survey-models.mjs [folder]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	parseGLTFFiles, splitComponents, solveBox, isDegenerate, imageSize,
} = require('../plugin/gltf_to_minecraft.js');

const root = process.argv[2] || 'test/model';

/**
 * Model folders are searched in depth: the collection is laid out differently, and
 * one author's models sit a level lower still (<author>/<model>).
 */
function findModels(dir, out = []) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	if (entries.some(e => e.isFile() && e.name.endsWith('.gltf'))) out.push(dir);
	for (const e of entries) if (e.isDirectory()) findModels(path.join(dir, e.name), out);
	return out;
}

/**
 * The model file. A folder may hold two — the plain one and `_Textured` — and the
 * plain one has zero images and a material without a texture. `_Textured` is taken, otherwise the first.
 */
function pickGltf(dir) {
	const all = fs.readdirSync(dir).filter(f => f.endsWith('.gltf'));
	return all.find(f => f.endsWith('_Textured.gltf')) || all[0] || null;
}

const models = findModels(root).sort();
if (!models.length) {
	console.log(`No models found in ${root}`);
	process.exit(0);
}

console.log('model'.padEnd(26) + 'objects'.padStart(8) + 'as cubes'.padStart(9) + 'approximated'.padStart(14)
	+ 'degen.'.padStart(9) + 'images'.padStart(11) + 'anim.'.padStart(7));
console.log(' '.repeat(26) + ' '.repeat(8) + ' '.repeat(9) + ' '.repeat(14) + ' '.repeat(9)
	+ 'all/col/hit'.padStart(11));
console.log('-'.repeat(100));

for (const dir of models) {
	const name = pickGltf(dir);
	if (!name) continue;

	// Exactly what lies in the model folder is handed over, the way a folder
	// import would give it: the WHOLE folder, together with the second .gltf
	// that has zero images and a material without a texture.
	// Choosing between them is the reader's job, and that is what has to be
	// checked here — not a selection prepared in advance, which would only
	// prove the preparation.
	//
	// Everything as bytes: the reader decodes .gltf itself (`TextDecoder`), and
	// crashes on a ready-made string.
	const files = {};
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		if (fs.statSync(p).isDirectory()) continue;
		files[f] = fs.readFileSync(p);
	}

	const label = path.basename(dir).slice(0, 25).padEnd(26);
	let parsed;
	try {
		parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128 });
	} catch (e) {
		console.log(label + '❌ parsing crashed: ' + String((e && e.message) || e).slice(0, 48));
		continue;
	}

	// Merged meshes: one mesh for the whole model is common among exporters, and
	// without splitting into connected parts it gives one "not a box" instead of fifty cubes.
	const split = [];
	for (const obj of parsed.objects) for (const faces of splitComponents(obj.faces)) split.push({ ...obj, faces });

	let boxes = 0, approx = 0, degen = 0;
	for (const obj of split) {
		if (isDegenerate(obj.faces)) { degen++; continue; }
		if (solveBox(obj.faces).error) approx++; else boxes++;
	}

	// Images: how many in total, how many of them are colour (auxiliary maps do not
	// go into the atlas), and how many the geometry actually reaches.
	const reached = new Set();
	for (const o of parsed.objects) if (o.image >= 0) reached.add(o.image);
	const colour = parsed.images.filter(im => im.role !== 'aux' && imageSize(im.bytes)).length;

	const live = boxes + approx;
	const share = live ? Math.round(100 * approx / live) : 0;
	console.log(
		label
		+ String(parsed.objects.length).padStart(8)
		+ String(boxes).padStart(9)
		+ (approx ? `${approx} (${share}%)` : '0').padStart(14)
		+ String(degen).padStart(9)
		+ `${parsed.images.length}/${colour}/${reached.size}`.padStart(11)
		+ String((parsed.animations || []).length).padStart(7)
		+ (share >= 30 ? '   ⚠ a third or more — the model is not for Minecraft' : '')
		+ (boxes === 0 ? '   ❌ not a single cube' : '')
	);
}
