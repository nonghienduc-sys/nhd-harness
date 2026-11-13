# Visual QA — Natural Cinematic Media

Review the generated output in this order.

## 1. Continuity / identity
- Does the subject still match the canonical reference?
- Are silhouette, proportions, colors, markings, costume and props intact?
- Did the model invent or remove anatomy?

## 2. Contact / physics
- Are feet, hooves, paws and objects grounded?
- Are shadows and reflections consistent with contact?
- Does weight feel plausible?
- Do wind, smoke, hair/fur, fabric and particles respond consistently?

## 3. Camera / depth
- Does the perspective fit the intended lens?
- Is depth of field spatially coherent?
- Is foreground/background scale plausible?
- Is motion blur appropriate to speed and camera movement?

## 4. Light
- Can you identify the main source?
- Do highlights, shadows, bounce and colored spill agree?
- Are magical/emissive elements lighting nearby surfaces rather than floating as an overlay?

## 5. Material texture
Look for plastic or repeated AI texture:
- waxy skin;
- airbrushed fur;
- identical leaves;
- polished stone with no roughness variation;
- uniformly sharp micro-detail.

## 6. Composition
- Avoid accidental perfect symmetry unless requested.
- Check tangencies, fused objects and confusing overlaps.
- Prefer layered depth and intentional negative space.

## 7. Synthetic over-polish
Reduce when present:
- extreme HDR;
- universal cyan/orange;
- glow on every edge;
- too much volumetric fog;
- too many decorative particles;
- excessive bokeh;
- heavy sharpening;
- spotless surfaces.

## 8. Video temporal QA
Across frames check:
- face/body shape drift;
- color drift;
- disappearing/reappearing props;
- breathing background geometry;
- random exposure pulses;
- sudden camera acceleration;
- objects sliding without contact;
- particles ignoring depth or wind.

## Repair strategy

Fix the smallest failing layer:
- identity failure -> strengthen continuity lock;
- plastic texture -> rewrite material + light, not just add grain;
- floaty subject -> strengthen contact/weight;
- chaotic video -> reduce action beats/motion budget;
- synthetic fantasy glow -> add local light spill, falloff and physical carrier;
- generic composition -> specify camera height, foreground overlap and subject placement.

Do not automatically regenerate with a completely different prompt; preserve what already works.
