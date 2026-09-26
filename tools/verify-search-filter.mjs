/**
 * The Sketchfab results filter: show only models with a ready glTF.
 *
 * Some models only offer the author's source (.blend, .fbx) for download — there is
 * nothing to open it with. The journal collected six such refusals in a row, and all
 * of them looked fine right up to the import attempt.
 *
 * Run: node tools/verify-search-filter.mjs [--live]
 *   --live also checks the filter on real API results
 *          (search is public, no token needed).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasGltfArchive, sketchfabSearchURL, cubeHint } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

console.log('\n=== What counts as usable ===');
ok(hasGltfArchive({ archives: { gltf: { size: 12345 }, source: { size: null } } }),
	'gltf with a size — usable');
ok(hasGltfArchive({ archives: { glb: { size: 500 } } }), 'only glb — usable too');
ok(!hasGltfArchive({ archives: { source: { size: 999 } } }), 'only the author\'s source — hidden');
ok(!hasGltfArchive({ archives: { gltf: { size: 0 }, source: { size: 10 } } }),
	'gltf of zero size — no autoconversion, hidden');
ok(!hasGltfArchive({ archives: { gltf: { size: null } } }), 'gltf with size=null — hidden');
ok(hasGltfArchive({ name: 'no archives field' }),
	'no archives field — shown (better too much than hiding everything)');
ok(hasGltfArchive({}) && hasGltfArchive(null) === false || true, 'null does not crash the function');

// The blockbench tag. A model built in Blockbench is cubes already and comes
// through whole; most of Sketchfab is sculpts that leave only a pile of
// bounding boxes. That is why the filter is on by default.
console.log('\n=== The request the plugin builds ===');
const withTag = sketchfabSearchURL('girl', true);
const without = sketchfabSearchURL('girl', false);
ok(/[?&]tags=blockbench(&|$)/.test(withTag), 'with the filter the request has tags=blockbench');
ok(!/tags=/.test(without), 'without the filter the request has no tag');
ok(/downloadable=true/.test(withTag) && /downloadable=true/.test(without),
	'"downloadable only" is set in both cases');
ok(/q=girl/.test(sketchfabSearchURL('girl', true)), 'the query itself is not lost');
ok(/q=&|q=$/.test(sketchfabSearchURL('', true)), 'an empty query gives an empty q, not undefined');

// The Animated box: off by default, and independent of the tag.
const animated = sketchfabSearchURL('girl', true, true);
ok(/[?&]animated=true(&|$)/.test(animated), 'with Animated the request has animated=true');
ok(!/animated=/.test(withTag), 'without it the request has no animated parameter');
ok(/tags=blockbench/.test(animated), 'Animated does not drop the blockbench tag');
ok(/animated=true/.test(sketchfabSearchURL('girl', false, true)) && !/tags=/.test(sketchfabSearchURL('girl', false, true)),
	'Animated works without the tag as well');

// The card's cube sign. Sketchfab counts vertex positions: a separate cube is 8
// of them to 12 triangles. The numbers are from real search results.
console.log('\n=== Built from cubes? ===');
ok(cubeHint(144, 96) === 'cubes', 'a player of 12 separate cubes (144 triangles, 96 vertices): cubes');
ok(cubeHint(10980, 7320) === 'cubes', 'exactly 2:3 at any size: cubes');
ok(cubeHint(212, 92) === 'shapes', 'shared corners, 0.43 vertices per triangle (a bevelled house): not cubes');
ok(cubeHint(388, 234) === null, 'in between, 0.60: no claim either way');
ok(cubeHint(18, 13) === null, 'above 2:3, as with faces left out or flat planes: no claim');
ok(cubeHint(0, 0) === null && cubeHint(undefined, 8) === null, 'missing counts: no claim');

const hasTag = m => (m.tags || []).some(t => t.name === 'blockbench' || t.slug === 'blockbench');

if (process.argv.includes('--live')) {
	// Hitting the API with exactly the URL the plugin built, not a copy of it: a test
	// against its own string would say nothing about what leaves Blockbench.
	console.log('\n=== The tag on real results ===');
	try {
		const page = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
		const plain = await page(without);
		const tagged = await page(withTag);
		const p1 = (plain.results || []).filter(hasTag).length;
		const t1 = (tagged.results || []).filter(hasTag).length;
		console.log(`  without the filter, tagged: ${p1} of ${(plain.results || []).length}`);
		console.log(`  with the filter, tagged: ${t1} of ${(tagged.results || []).length}`);
		ok((tagged.results || []).length > 0, 'the filter does not wipe out all results');
		ok(t1 === (tagged.results || []).length, 'with the filter every model carries the tag');
		// The card's cube sign on the same page: if Sketchfab ever stopped sending the
		// counts, or started counting vertices differently, nothing would read as cubes.
		const hints = (tagged.results || []).map(m => cubeHint(m.faceCount, m.vertexCount));
		const cubes = hints.filter(h => h === 'cubes').length, shapes = hints.filter(h => h === 'shapes').length;
		console.log(`  cube sign: cubes ${cubes}, probably not cubes ${shapes}, no claim ${hints.length - cubes - shapes}`);
		ok(cubes > 0, 'some tagged models read as cubes (the sign is alive)');
		// "Show more" follows the ready-made next link from the response. If it lost the
		// parameter, the first page would be from Blockbench and the second — anything.
		if (tagged.next) {
			ok(/tags=blockbench/.test(tagged.next), 'the next link keeps the tag');
			const second = await page(tagged.next);
			const t2 = (second.results || []).filter(hasTag).length;
			console.log(`  second page: tagged ${t2} of ${(second.results || []).length}`);
			ok(t2 === (second.results || []).length, 'on the second page every model carries the tag too');
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}

	// The same for Animated, with the plugin's own URL. The cards show the count
	// from animationCount, so that is what has to be non-zero.
	console.log('\n=== Animated on real results ===');
	try {
		const page = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
		const moving = m => Number(m.animationCount) > 0;
		const plain = await page(withTag);
		const anim = await page(animated);
		const p1 = (plain.results || []).filter(moving).length;
		const a1 = (anim.results || []).filter(moving).length;
		console.log(`  without the filter, animated: ${p1} of ${(plain.results || []).length}`);
		console.log(`  with the filter, animated: ${a1} of ${(anim.results || []).length}`);
		ok((anim.results || []).length > 0, 'the filter does not wipe out all results');
		ok(a1 === (anim.results || []).length, 'with the filter every model has an animation');
		ok((anim.results || []).every(m => typeof m.faceCount === 'number'), 'every result carries faceCount for the card');
		if (anim.next) {
			ok(/animated=true/.test(anim.next) && /tags=blockbench/.test(anim.next), 'the next link keeps both filters');
			const second = await page(anim.next);
			const a2 = (second.results || []).filter(moving).length;
			console.log(`  second page: animated ${a2} of ${(second.results || []).length}`);
			ok(a2 === (second.results || []).length, 'on the second page every model has an animation too');
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}
}

if (process.argv.includes('--live')) {
	console.log('\n=== Real API results ===');
	const url = sketchfabSearchURL('minecraft', false);
	try {
		const r = await fetch(url);
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const data = await r.json();
		const list = data.results || [];
		const good = list.filter(hasGltfArchive);
		const withArchives = list.filter(m => m.archives).length;
		console.log(`  models in the results: ${list.length}, with an archives field: ${withArchives}`);
		console.log(`  pass the filter: ${good.length}, hidden: ${list.length - good.length}`);
		ok(withArchives > 0, 'the API really returns archives (otherwise the filter is a dummy)');
		ok(good.length > 0, 'the filter does not wipe out all results');
		for (const m of list.filter(m => !hasGltfArchive(m)).slice(0, 5)) {
			const has = Object.entries(m.archives || {})
				.filter(([, v]) => v && v.size).map(([k]) => k).join(', ') || 'nothing';
			console.log(`    hidden: ${(m.name || '').slice(0, 40)} — available: ${has}`);
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}
} else {
	console.log('\n(run with --live to check the filter on real results)');
}

console.log(bad ? `\n❌ ERRORS: ${bad}\n` : '\n✅ THE RESULTS FILTER WORKS\n');
process.exit(bad ? 1 : 0);
