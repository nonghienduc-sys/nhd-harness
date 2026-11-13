---
name: "natural-cinematic-media"
description: "Create and QA AI image/video prompts that feel photographed or filmed rather than generically AI-rendered, using concrete cinematography, physical realism, natural imperfection, subject continuity, Google Flow/Veo adaptation, and anti-slop prompt linting."
---

# Natural Cinematic Media

Use this skill when the user asks MCP to design, rewrite, or QA prompts for AI-generated images or video, especially Google Flow/Veo, image-to-video, fantasy scenes, character continuity, or output that should feel less synthetic and more like a photographed/filmed production.

The goal is aesthetic naturalism and production quality. Do not claim this bypasses AI provenance systems or detection tools.

## Core principle

Do not try to remove the "AI look" with a single phrase such as `add noise`, `photorealistic`, `cinematic`, `8K`, or `masterpiece`.

Build realism from a coherent capture model:

**reference lock -> scene intent -> physical world -> camera/lens -> light -> texture/imperfection -> controlled motion -> model adapter -> exclusions -> lint -> visual QA**

Fantasy is allowed. The world may be impossible; the image formation, materials, anatomy, gravity, contact, lighting, and motion should still feel internally plausible.

## Workflow

### 1. Lock references and invariants

Before writing a prompt, identify what must not drift:
- subject identity, anatomy, silhouette, proportions, costume/props;
- canonical colors and markings;
- environment anchors and art direction;
- aspect ratio and framing constraints;
- source image identity for image-to-video.

If the project has a canonical reference or memory entry, preserve it explicitly. Never silently redesign the subject while "improving" realism.

### 2. State the shot in plain language

Define one primary visual intention:
- what the viewer sees;
- where the subject is;
- what matters emotionally;
- what changes during the shot.

Avoid stacking multiple unrelated scenes into one prompt.

### 3. Specify cinematography concretely

Prefer observable camera language over prestige adjectives:
- shot size: establishing, wide, medium, close-up, macro;
- camera height/angle: eye-level, low, high, over-shoulder;
- lens feel or focal length: 24/35/50/85mm when useful;
- depth behavior: deep focus, moderate separation, shallow focus;
- camera behavior: locked, tripod, dolly, crane, pan, gentle handheld, follow;
- composition: foreground occlusion, layered depth, negative space, asymmetry, leading lines.

Use one dominant camera movement per short video shot unless the user specifically needs more.

### 4. Make the world physically specific

Describe the evidence a real camera would capture:
- material roughness, fibers, fur clumping, dust, condensation, worn edges;
- foot/hoof/paw contact with ground;
- weight transfer and inertia;
- wind acting consistently on grass, fabric, fur, smoke and particles;
- shadow contact and bounce light;
- water/reflection behavior;
- atmospheric depth and visibility falloff.

For creatures, preserve believable joints, gait, muscle tension, eye placement, fur direction and body mass even when the creature is magical.

### 5. Add natural imperfection with restraint

Naturalism is not random degradation. Select only a few motivated imperfections:
- subtle organic film grain or sensor texture;
- slight exposure variation;
- mild lens softness away from the focal plane;
- restrained highlight bloom/halation when motivated by bright sources;
- natural edge falloff/vignetting;
- tiny handheld micro-sway;
- realistic motion blur;
- foreground leaves/grass briefly occluding the frame;
- uneven vegetation, dirt, wear and texture variation;
- slight asymmetry in pose and composition;
- restrained saturation and non-uniform shadows.

Do not pile every defect into every shot. The imperfection must fit the implied camera and scene.

### 6. Protect fantasy from becoming synthetic

For fantasy shots, anchor magic to physical carriers:
- light catching mist, dust, pollen, fur or leaves;
- emissive edges casting local light onto nearby surfaces;
- particles affected by air movement and depth;
- glow with finite intensity and falloff;
- magical colors embedded into the environment rather than pasted over it.

Prefer "a real location with impossible phenomena" over "generic fantasy render."

### 7. Adapt to the generation mode

Read `references/model-adapters.md` when model-specific wording matters.

For Google Flow/Veo short shots, structure as:
**LOOK -> CAMERA -> SUBJECT/ACTION -> ENVIRONMENT/PHYSICS -> FIDELITY -> AUDIO (if needed) -> EXCLUSIONS**

For image-to-video:
- do not waste the prompt redescribing every visible object;
- treat the source image as the identity and composition anchor;
- primarily specify motion, temporal behavior, camera behavior, environmental response, and what must remain unchanged;
- keep the motion budget small: usually one camera move plus one or two action beats.

### 8. Use exclusions as failure prevention

Write concise failure constraints instead of a giant negative-prompt dump. Examples:
- no anatomy drift;
- no extra limbs/horns/wings;
- no plastic-smooth fur or skin;
- no floating contact points;
- no random camera whip;
- no pulsing exposure;
- no oversaturated cyan/orange grade unless requested;
- no text/logo mutation;
- preserve face/character identity;
- preserve exact reference colors.

### 9. Lint before delivery

When practical, run:

`python skills/natural-cinematic-media/scripts/prompt_lint.py --mode <image|video|i2v> --prompt "<prompt>"`

Treat linter findings as advisory. Fix contradictions and missing capture/physics information, but do not mechanically add irrelevant keywords just to raise a score.

### 10. Visual QA after generation

If an output image/frame is available, inspect it visually and use `references/visual-qa.md`.

Check at minimum:
- identity and silhouette;
- anatomy/contact;
- material response;
- lighting consistency;
- depth/lens behavior;
- repetitive AI texture;
- synthetic over-polish;
- fantasy effect integration;
- text/logo integrity;
- video temporal stability if applicable.

When a result fails, revise the smallest relevant prompt layer instead of rewriting everything.

## Anti-slop rules

Avoid these habits unless the user explicitly wants them:
- adjective soup: "masterpiece, stunning, epic, ultra detailed, 8K";
- universal teal/orange grading;
- glowing rim light around every edge;
- perfect bilateral symmetry;
- spotless glossy surfaces everywhere;
- excessive volumetric fog;
- random floating particles with no physical interaction;
- maximum bokeh regardless of shot purpose;
- every surface equally sharp and detailed;
- impossible subject-ground contact;
- overdescribing the source image during image-to-video;
- too many action beats in one short generation.

"Less AI" usually means **more specific, more physically coherent, and more restrained**, not merely noisier.

## Output format

Unless the user requests another format, return:
1. **Generation prompt** — clean prompt ready to paste.
2. **Exclusions / preserve** — short failure-prevention block.
3. **Continuity lock** — only when a reference character/object must stay canonical.
4. **Optional generation notes** — aspect ratio, shot duration, or image-to-video notes that the target model benefits from.

Do not bury the usable prompt inside a long explanation.

## Packaged references

- `references/naturalism-rules.md` — physical realism and imperfection library.
- `references/model-adapters.md` — Google Flow/Veo and generic image/image-to-video adapters.
- `references/visual-qa.md` — post-generation anti-slop review.
- `SOURCES.md` — external inspirations and attribution notes.
- `scripts/prompt_lint.py` — dependency-free advisory prompt linter.
