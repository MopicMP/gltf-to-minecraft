/**
 * The outliner after an import: which glTF nodes stay as folders, and names.
 *
 * Every glTF node used to become a folder, and a Sketchfab export nests them
 * deep — a cube inside its own node, inside a node holding its mesh, under
 * three wrapper nodes. The import now drops folders that hold one thing or
 * nothing and carry no animation, and takes the exporter's numbering off names.
 *
 * What must hold: no animated node disappears (its animation would have nothing
 * to turn), every cube has a folder to go in, and bone names stay unique.
 *
 * Run: node tools/verify-outliner.mjs [folder with models, default test/model]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { tidyHierarchy, parseGLTFFiles, splitComponents, isDegenerate } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

/** A hierarchy from [index, name, parent, wrapper?] rows. */
const tree = rows => rows.map(([index, name, parent, wrapper]) => ({ index, name, parent, wrapper: !!wrapper }));

console.log('\n=== A Sketchfab export of a Blockbench model ===');
{
	// Sketchfab_model > root > GLTF_SceneRootNode > _985 > bone_518 (animated)
	//   > bone35_5 > cube_1 > _gltfNode_2 [cube]
	//              > cube_2 > _gltfNode_4 [cube]
	const h = tree([
		[0, 'Sketchfab_model', -1, true], [1, 'root', 0, true], [2, 'GLTF_SceneRootNode', 1, true],
		[3, '_985', 2], [4, 'bone_518', 3], [5, 'bone35_5', 4],
		[6, 'cube_1', 5], [7, '_gltfNode_2', 6], [8, 'cube_2', 5], [9, '_gltfNode_4', 8],
	]);
	const t = tidyHierarchy(h, [7, 9], new Set([4]));
	ok(t.kept.sort().join() === '4,5', `only the animated bone and the branching one stay (kept: ${t.kept.join(', ')})`);
	ok(t.parent.get(5) === 4 && t.parent.get(4) === -1, 'bone35 hangs from bone_518, which is at the top');
	ok(t.home(7) === 5 && t.home(9) === 5, 'both cubes go into bone35');
	ok(t.cubeName(7, '_gltfNode_2') === 'cube', 'a cube is named after its node, not the mesh holder: "cube"');
	ok(t.name.get(5) === 'bone35' && t.name.get(4) === 'bone', 'the exporter\'s _N is stripped from folders');
	ok(t.stripped, 'the numbering is recognised as the exporter\'s');
}

console.log('\n=== A part whose every cube sits in a node of its own ===');
{
	// body_69 > body_66 > Object_104 > [cube Object_104]
	//         > body_67 > Object_106 > [cube]
	//         > body_68 > Object_108 > [cube]
	const h = tree([
		[0, 'body_69', -1],
		[1, 'body_66', 0], [2, 'Object_104', 1],
		[3, 'body_67', 0], [4, 'Object_106', 3],
		[5, 'body_68', 0], [6, 'Object_108', 5],
	]);
	const t = tidyHierarchy(h, [2, 4, 6], new Set());
	ok(t.kept.join() === '0', 'three levels become one folder with three cubes');
	ok(t.cubeName(2, 'Object_104') === 'body', 'Object_104 takes the author\'s name above it');
}

console.log('\n=== What must not go ===');
{
	// An animated node with a single child stays: its animation needs it.
	const h = tree([[0, 'arm', -1], [1, 'hand', 0], [2, 'mesh', 1]]);
	const t = tidyHierarchy(h, [2], new Set([1]));
	ok(t.name.has(1), 'an animated node with one child stays');
	ok(!t.name.has(0), '...while its still parent with one child goes');
	ok(t.home(2) === 1, 'the cube lands in the animated node');
}
{
	// Names the author wrote are left alone when not every name carries a number.
	const h = tree([[0, 'Head', -1], [1, 'leg_1', -1], [2, 'leg_2', -1]]);
	const t = tidyHierarchy(h, [0, 0, 1, 1, 2, 2], new Set());
	ok(t.name.get(1) === 'leg_1' && t.name.get(2) === 'leg_2', 'the author\'s own leg_1 and leg_2 are kept');
	ok(!t.stripped, '...because not every name carries the exporter\'s number');
}
{
	// Stripped names that collide get a number back: bones must differ.
	const h = tree([[0, 'leg_3', -1], [1, 'leg_7', -1]]);
	const t = tidyHierarchy(h, [0, 0, 1, 1], new Set());
	ok(t.name.get(0) === 'leg' && t.name.get(1) === 'leg_2', `colliding names are told apart: ${t.name.get(0)}, ${t.name.get(1)}`);
}
{
	// An empty folder goes, and its parent may then hold a single thing and go too.
	const h = tree([[0, 'body_1', -1], [1, 'empty_2', 0], [2, 'part_3', 0]]);
	const t = tidyHierarchy(h, [2], new Set());
	ok(t.kept.length === 0 && t.home(2) === -1, 'an empty folder goes, and its parent after it');
}
{
	// A wrapper holding several things still goes: its children move up.
	const h = tree([[0, 'GLTF_SceneRootNode', -1, true], [1, 'a_1', 0], [2, 'b_2', 0]]);
	const t = tidyHierarchy(h, [1, 1, 2, 2], new Set());
	ok(!t.name.has(0) && t.parent.get(1) === -1, 'the export wrapper goes even with several children');
}

// Every model in the local collection: animated nodes kept, every cube housed.
const root = process.argv[2] || path.join('test', 'model');
function findModels(dir, out = []) {
	let e;
	try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	if (e.some(x => x.isFile() && x.name.endsWith('.gltf'))) out.push(dir);
	for (const x of e) if (x.isDirectory()) findModels(path.join(dir, x.name), out);
	return out;
}
const models = findModels(root).sort();
if (models.length) {
	console.log(`\n=== Models in ${root} ===`);
	console.log('    folders before → after, animated nodes kept, cubes housed');
	models.forEach((dir, i) => {
		const files = {};
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f);
			if (!fs.statSync(p).isDirectory()) files[f] = fs.readFileSync(p);
		}
		let parsed;
		try { parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128 }); } catch { return; }
		const animated = new Set();
		for (const a of parsed.animations) for (const ch of a.channels) animated.add(ch.node);
		const cubeNodes = [];
		for (const o of parsed.objects) for (const f of splitComponents(o.faces)) if (!isDegenerate(f)) cubeNodes.push(o.node);
		const t = tidyHierarchy(parsed.hierarchy, cubeNodes, animated);
		const lost = [...animated].filter(n => parsed.hierarchy.some(h => h.index === n) && !t.name.has(n));
		const homeless = cubeNodes.filter(n => { const home = t.home(n); return home !== -1 && !t.name.has(home); });
		const names = [...t.name.values()];
		const label = `model ${String(i + 1).padStart(2, '0')}`;
		ok(!lost.length && !homeless.length && new Set(names).size === names.length,
			`${label}: ${parsed.hierarchy.length} → ${t.kept.length}, `
			+ `animated ${animated.size - lost.length} of ${animated.size}, `
			+ `${cubeNodes.length - homeless.length} of ${cubeNodes.length} cubes housed`
			+ (new Set(names).size === names.length ? '' : ', DUPLICATE bone names'));
	});
} else {
	console.log(`\n(no models in ${root}: only the fixed cases were checked)`);
}

console.log(`\n${bad ? `❌ FAILED: ${bad}` : '✅ THE OUTLINER IS TIDIED WITHOUT LOSS'}\n`);
process.exit(bad ? 1 : 0);
