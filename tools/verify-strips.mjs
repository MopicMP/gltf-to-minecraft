/**
 * Checks that the importer reads models written as triangle strips.
 *
 * The occasion: all six reference models of the time in test/model — from three
 * different hands, all passed through Sketchfab — are written in mode 5 (TRIANGLE_STRIP). The importer took
 * only mode 4 and silently skipped EVERY primitive in EVERY model, which is why
 * it reported that it had not found a single cube. The geometry itself was flawless:
 * twenty-four vertices per primitive, i.e. six faces of four corners each.
 *
 * Both are checked here: that strips and fans unfold into the same
 * triangles mode 4 would have recorded, and that real models are then
 * read as cubes.
 *
 * Run: node tools/verify-strips.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TRIANGULATE, parseGLTFFiles, solveBox } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const say = (ok, line) => { if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + line); };

// ----------------------------------------------------- unfolding, on its own

console.log('Strips and fans into triangles');

const strip = TRIANGULATE[5]([0, 1, 2, 3, 4]);
say(strip.length === 3, `a strip of five vertices gives three triangles (${strip.length})`);
// Every second triangle in a strip is written reversed, and the reader must turn
// it back. A reader that does not gets every second face
// turned inside out — and that is not a glitch, it is a cube with holes.
say(JSON.stringify(strip[0]) === '[0,1,2]', 'the first triangle as written');
say(JSON.stringify(strip[1]) === '[2,1,3]', 'the second turned back');
say(JSON.stringify(strip[2]) === '[2,3,4]', 'the third as written again');

const fan = TRIANGULATE[6]([0, 1, 2, 3]);
say(fan.length === 2, `a fan of four vertices gives two triangles (${fan.length})`);
say(JSON.stringify(fan) === '[[0,1,2],[0,2,3]]', 'a fan holds on to the first vertex');

const plain = TRIANGULATE[4]([0, 1, 2, 3, 4, 5]);
say(JSON.stringify(plain) === '[[0,1,2],[3,4,5]]', 'plain triangles are left alone');

// All three cover the same surface: a strip of six vertices and a fan of six
// cover four triangles each, and not one index is lost.
const used = new Set(TRIANGULATE[5]([0, 1, 2, 3, 4, 5]).flat());
say(used.size === 6, `a strip uses all of its vertices (${used.size} of 6)`);

// Stitches. A strip is one continuous band, so a box written as a strip
// jumps from face to face by repeating an index. Such a triangle draws
// nothing, but its three corners are read from TWO different texture faces at once, and
// the rectangle of each side stretches onto its neighbours. Exactly this looked
// like "the textures are put on completely wrong".
const stitched = TRIANGULATE[5]([0, 1, 2, 3, 3, 4, 4, 5, 6, 7]);
say(stitched.every(t => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]),
	'stitches dropped: a triangle with a repeated corner is not a triangle');
say(TRIANGULATE[4]([0, 1, 1, 2, 3, 4]).length === 1,
	'in plain triangles too, should one turn up');

// ------------------------------------------------------- real models

console.log('\nReal models');

const root = 'test/model';

// Folders are searched in depth and by the presence of a model, not by name: the
// "starts with zero" filter lost both the tenth model and those lying a level lower,
// under an author's name (<author>/<model>). It lost them silently — the check
// simply did not count them as its own.
function findModels(dir, out = []) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	if (entries.some(e => e.isFile() && e.name.endsWith('_Textured.gltf'))) out.push(dir);
	for (const e of entries) if (e.isDirectory()) findModels(path.join(dir, e.name), out);
	return out;
}

const folders = findModels(root).sort();

if (!folders.length) {
	console.log('  skipped: the reference models are not in place');
} else {
	for (const dir of folders) {
		const folder = path.basename(dir);
		const name = fs.readdirSync(dir).find(f => f.endsWith('_Textured.gltf'));
		if (!name) continue;
		const files = {};
		// Files only: a model folder may also hold a directory (one model
		// has a screenshot folder), and readFileSync fails on it with EISDIR.
		//
		// And only ONE .gltf. The reader takes whichever comes first, and a folder holds up to
		// three, the plain one with zero images: all along the check ran against the neighbouring
		// file — for one model, 362 objects instead of 589.
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f);
			if (fs.statSync(p).isDirectory()) continue;
			if (f.endsWith('.gltf') && f !== name) continue;
			files[f] = fs.readFileSync(p);
		}

		const parsed = parseGLTFFiles(files, { scale: 16, uvWidth: 128, uvHeight: 128 });
		const solved = parsed.objects.map(o => solveBox(o.faces)).filter(s => !s.error);
		const boxes = solved.length;
		const skipped = parsed.warnings.filter(w => /mode \d+ skipped/.test(w)).length;
		// A violation is a face whose rectangle in the texture is turned by a right angle
		// relative to the geometry. With stitches in the parse there were three hundred of them PER
		// box: a stitch reads corners from two faces at once and stretches
		// the rectangle of each side onto its neighbours.
		//
		// Zero here would be the wrong bar, and the first version of this test
		// demanded it for nothing. One model has 587 clean boxes out of 589, and two give 36 each —
		// those are two cubes whose UV in the source cannot be expressed as a rectangle
		// of a Blockbench box under any of the twenty-four rotations. A property
		// of the model, not of the reader.
		//
		// So the bar is that dirty ones are a handful, not the rule. A share alone does not
		// work: another model has only seventeen boxes, and the same two dirty ones give
		// twelve percent, though that is exactly the same number of cubes as two out of
		// five hundred and eighty-nine. Before the fix NOT ONE was clean.
		const dirty = solved.filter(s => (s.violations || 0) > 0).length;
		const clean = boxes ? (boxes - dirty) / boxes : 1;
		say(parsed.objects.length > 0 && skipped === 0 && (dirty <= 2 || clean >= 0.95),
			`${folder.slice(0, 34).padEnd(34)} ${String(parsed.objects.length).padStart(4)} objects,`
			+ ` ${String(boxes).padStart(4)} as cubes, ${skipped} skipped,`
			+ ` ${dirty} with rotated UV of ${boxes}`);
	}
}

console.log(bad === 0 ? '\nPASS: STRIPS ARE READ' : `\nFAIL: ${bad} checks failed`);
process.exit(bad === 0 ? 0 : 1);
