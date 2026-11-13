# Model Adapters

These are compact prompting strategies, not claims about undocumented model internals. If the platform behavior changes, prefer the user's observed results and current model documentation.

## Google Flow / Veo — text to video

Recommended order:

1. LOOK — medium, era, palette, realism/stylization boundary.
2. CAMERA — shot size, lens feel, angle, one primary move.
3. SUBJECT + ACTION — one clear subject and usually 1–2 action beats.
4. ENVIRONMENT + PHYSICS — wind, contact, particles, reflections, gravity.
5. FIDELITY — identity, colors, props and shapes that must not drift.
6. AUDIO — only when useful: ambience, SFX, dialogue.
7. EXCLUSIONS — short list of likely failures.

Keep short clips temporally simple. More actions do not automatically produce a richer shot; they often create continuity drift.

Example skeleton:

`[LOOK]. [CAMERA]. [SUBJECT] performs [ACTION 1], then [ACTION 2]. [ENVIRONMENT/PHYSICS]. Preserve [FIDELITY]. Audio: [AUDIO]. Avoid [EXCLUSIONS].`

## Google Flow / Veo — image to video

Assume the source image already defines identity, composition and most appearance.

Prompt mostly:
- what starts moving;
- how fast and in what sequence;
- how the camera moves;
- how environment reacts;
- what stays absolutely fixed.

Example skeleton:

`Use the source image as the exact visual anchor. Camera: [ONE MOVE]. Motion: [PRIMARY SUBJECT MOTION], then [SECONDARY BEAT]. Environment response: [WIND/PARTICLES/LIGHT]. Preserve exact [IDENTITY/COLOR/PROPORTIONS/COMPOSITION ANCHORS]. No [DRIFT FAILURES].`

Avoid redescribing every visible object unless a specific element is repeatedly drifting.

## Still image generation

Order:
**subject/scene -> composition -> camera/lens -> lighting -> materials/physical cues -> restrained imperfection -> color finish -> exclusions**

For a realistic look, camera and material evidence are more useful than "photorealistic 8K."

## Character continuity

Use a short immutable block:
- species/person;
- body proportions and silhouette;
- face/head geometry;
- exact color/marking map;
- signature prop/costume;
- forbidden changes.

Repeat this continuity lock consistently across shots. Do not casually synonymize exact colors when color identity matters.

## Fantasy creature example strategy

Do not say only "majestic magical wolf."

Specify:
- body mass and anatomy;
- fur structure;
- head/neck proportions;
- grounded stance/contact;
- how magical edge light interacts with fur and nearby ground;
- exact canonical glow colors;
- restrained particle carrier;
- camera position and lens;
- failure constraints such as no extra limbs and no color drift.
