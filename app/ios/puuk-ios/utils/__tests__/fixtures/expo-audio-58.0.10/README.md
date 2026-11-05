Unmodified Swift fixtures from official expo-audio 58.0.10, under the included MIT LICENSE. Npm tarball integrity: `sha512-GoOyd1JAb7l/bJ/UNc5QIrXqSK9QrEFF3ahjdONGt8V6PN3RXRsTcOJDMN6RmDc9kb0XPP34DJIxEd/ushH1RQ==`.

`legacy-patch.cjs` is Puuk's pre-S1 patch (SHA-256 `1603cc8a30d954f0a1ade5b07d38eb0d6b0f37b796f6cf24a7a9de448daaf05f`). Tests apply it to isolated pristine fixtures, then migrate to identity v1. No network, Git or installed-source mutation is needed. Source guards are static assertions, not native compilation or AVFoundation/device tests.

`s1-patch.cjs` preserves the exact pre-correction S1 producer (SHA-256 `c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71`). It reproducibly builds the installed S1 output from pristine fixtures for corrective migration tests. The corrective producer also pins those intermediate bytes before applying F1–F4 changes.

`s1n-fix-patch.cjs` preserves the exact first corrective producer (SHA-256 `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88`). R1 tests use it to build the exact current pre-R1 output and check migration, repeat application, mixed-tree rejection and failed-transform preservation. Historical producers are fixtures only.

`s1n-r1-patch.cjs` preserves the exact R1 corrective producer (SHA-256 `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0`). R2 tests build that exact pre-R2 output and verify full-hash migration, repeat application, failed-transform preservation, module generation fences and original-volume retention. These checks are static source and host fixture checks, not native interleaving proof. Original fixtures and historical producers remain unchanged.

`s1n-r2-patch.cjs` preserves the byte-exact R2 producer (SHA-256 `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c`). S2 type-correction tests build exact R2 input, migrate its two remote pause call sites through checked `Playable` casts with generic pause fallback, and require the other four native outputs to remain byte-identical. Historical producers and Swift fixtures are unchanged; these are source/host checks, not Swift compilation or native runtime proof.
